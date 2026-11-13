import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { defaultTitle, idPattern, isTurnPending, legacyRequestedModel, shaPattern, turnStore, waitFor } from './turns.mjs';
import { createRegistry } from './registry.mjs';
import { createTaskStore, inspectLegacyTask } from './task-store.mjs';
import { readArtifactPage } from './artifact-page.mjs';
import { runtimeConfig } from './runtime-config.mjs';
import { acquireRouteReloadGate, acquireRouteSubmissionGate } from './route-work-gate.mjs';
import { readConversationMessages } from './conversation-log.mjs';

const protocolVersions = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const requestKeyPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const identityPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const modelIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const reloadSettledTaskStates = new Set([
  'done', 'failed', 'needs_input', 'cancelled', 'cursor_conflict', 'preflight_failed',
  'artifact_invalid', 'artifact_changed', 'artifact_unavailable',
]);
const projectNotice = 'Uses the verified Antigravity conversation for this Codex workspace only. Submit only materials the user authorized Gemini to receive.';
const reviewPolicy = [
  '发件方：我是 OpenAI Codex，是 AI 助手。以下简报可能包含我转述的用户要求、我的观察和待检验的判断；我的判断不代表用户的意见。',
  '请独立审查。主动找反例和可能改变结论的证据；如果不同意简报里的判断，请直接说明理由。区分你实际观察到的内容、你的推断和证据不足之处。证据支持同意时也请说明依据。',
].join('\n');
// The single verified legacy receipt had match flags only. Its digest covers
// the exact workspace, Sidecar, IDs and receipt bytes of that deployment.
const legacyIdentityDigest = process.env.ANTIGRAVITY_LEGACY_IDENTITY_DIGEST ?? '';

const requestKey = {
  type: 'string', pattern: requestKeyPattern.source,
  description: 'A fresh random lowercase UUID v4. Keep it private and reuse the same value to query or safely retry this submission.',
};
const conversationIdSchema = { type: 'string', pattern: idPattern.source };
const waitMsSchema = { type: 'integer', minimum: 0, maximum: runtimeConfig.localWaitMaxMs, description: 'Optional bounded wait for this call, in milliseconds. The App task can run longer.' };
const modelIdSchema = { type: 'string', pattern: modelIdPattern.source };
const turnProperties = {
  request_key: requestKey,
  prompt: { type: 'string', minLength: 1, description: 'Instructions for this turn. Send only the new request on continuation.' },
  materials: { type: 'array', items: {
    type: 'object', additionalProperties: false, required: ['path'],
    properties: { path: { type: 'string' }, sha256: { type: 'string', pattern: shaPattern.source } },
  }, description: 'Explicitly authorized absolute local workspace file paths, optionally pinned by SHA-256. Bytes are snapshotted for this turn.' },
};
const queuedTool = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const toolSchema = (required, properties) => ({ type: 'object', additionalProperties: false, required, properties });

const tools = [
  {
    name: 'project_catalog',
    description: 'Find the already existing Antigravity project whose local resource root exactly matches this Codex workspace. Reads project metadata only; does not list conversations or create projects.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'connect_project',
    description: 'Prepare or apply an idempotent App Sidecar and MCP route registration for an already existing, locally verified Antigravity project. Call with apply=false to inspect exact file hashes/diffs; apply=true writes only the route manifest, Sidecar descriptor and target App registration.',
    inputSchema: toolSchema([], {
      project_id: { type: 'string', pattern: identityPattern.source },
      default_model: { ...modelIdSchema, description: 'Optional exact default model ID. Its account availability remains unverified until an App request succeeds.' },
      apply: { type: 'boolean', description: 'Defaults to false. Set true only after reviewing the returned transaction diff.' },
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'binding_status',
    description: 'Read the Antigravity project route, App registration, project roots, worker heartbeat and model configuration for this Codex workspace.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'reload_worker',
    description: 'Safely reload this route’s empty App-managed worker. Requires a verified route and no unsettled tasks; changes only this Sidecar enabled state and waits for the current worker to stop and the matching runtime heartbeat to return.',
    inputSchema: toolSchema([], {}),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'submit_review',
    description: `Queue an independent review for Gemini in the local Antigravity app. New requests identify the sender as OpenAI Codex (an AI assistant) and ask Gemini to challenge unsupported claims, cite evidence, and state uncertainty. Label user requirements separately from Codex observations or judgments in the brief. ${projectNotice}`,
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['request_key', 'prompt'],
      properties: {
        request_key: requestKey,
        prompt: { type: 'string', minLength: 1, description: 'The review task and questions. Label any relayed user requirements separately from your own observations and hypotheses.' },
        image_paths: { type: 'array', items: { type: 'string' }, description: 'Absolute paths of user-authorized local PNG, JPEG or WebP images inside this workspace. List them in the order referenced in the prompt.' },
        model_id: { ...modelIdSchema, description: 'Optional exact model ID for this new App conversation. Omit to use the route default.' },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'model_catalog',
    description: 'List model IDs with their source and verification level. The App Sidecar agentapi has no dynamic model-discovery API; this does not claim account availability.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'read_task_artifact',
    description: 'Read a byte-offset page from a verified task artifact. Large results remain retrievable; UTF-8 pages begin and end on code point boundaries.',
    inputSchema: toolSchema(['request_key', 'name'], {
      request_key: requestKey,
      name: { type: 'string', minLength: 1, maxLength: 128 },
      offset_bytes: { type: 'integer', minimum: 0 },
      length_bytes: { type: 'integer', minimum: 1, maximum: runtimeConfig.artifactPageBytes },
    }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'job_status',
    description: 'Read a submitted task or wait briefly for its result. Keep the same request key after an unknown outcome and check the Antigravity conversation.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['request_key'],
      properties: { request_key: requestKey, wait_ms: waitMsSchema },
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'start_chat',
    description: `Queue a new visible Antigravity chat using an explicit model_id or the route's configured default. General writing and editing tasks are supported. ${projectNotice}`,
    inputSchema: toolSchema(['request_key', 'prompt'], {
      ...turnProperties, model_id: { ...modelIdSchema, description: 'Optional exact model ID. Omit only when a route default is configured.' },
      title: { type: 'string', description: 'Optional App chat title. A short request ID is appended for recovery.' },
    }),
    annotations: queuedTool,
  },
  {
    name: 'continue_chat',
    description: `Queue a new turn in an explicit same-project conversation, using a fresh cursor from conversation_status. The existing App conversation keeps its model; a manually advanced or unsettled chat requires re-observation. ${projectNotice}`,
    inputSchema: toolSchema(['request_key', 'conversation_id', 'cursor', 'prompt'], {
      ...turnProperties, conversation_id: conversationIdSchema, cursor: { type: 'string', pattern: shaPattern.source },
    }),
    annotations: queuedTool,
  },
  {
    name: 'send_message',
    description: 'Send a plain message to any explicitly identified existing Antigravity conversation, including outside-of-project. Uses its current model and a fresh conversation_status cursor. Replies are archived by the bridge; no task files or completion receipt are requested from the model.',
    inputSchema: toolSchema(['request_key', 'conversation_id', 'cursor', 'prompt'], {
      request_key: requestKey, conversation_id: conversationIdSchema,
      cursor: { type: 'string', pattern: shaPattern.source }, prompt: { type: 'string' },
    }),
    annotations: queuedTool,
  },
  {
    name: 'read_conversation',
    description: 'Verify an explicit existing conversation through the App and read its user-visible messages. Includes outside-of-project; never returns private model thinking. Page by after_step and limit.',
    inputSchema: toolSchema(['conversation_id'], { conversation_id: conversationIdSchema, wait_ms: waitMsSchema,
      after_step: { type: 'integer', minimum: -1 }, limit: { type: 'integer', minimum: 1 } }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'conversation_status',
    description: 'Ask the App worker to verify an explicit conversation and observe its transcript boundary. A ready result supplies the cursor for continuation. No model call.',
    inputSchema: toolSchema(['conversation_id'], { conversation_id: conversationIdSchema, wait_ms: waitMsSchema }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'cancel_job',
    description: 'Cancel a queued start_chat or continue_chat task before App dispatch. Once dispatched, stop in Antigravity if needed.',
    inputSchema: toolSchema(['request_key'], { request_key: requestKey }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'takeover_job',
    description: 'Release an unresolved chat job to manual App control without resending it. If a fresh chat ID was lost, supply the visible conversation ID so the worker can verify its dispatch marker and recover a valid receipt.',
    inputSchema: toolSchema(['request_key'], { request_key: requestKey, conversation_id: conversationIdSchema }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
];

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function explicitModelId(args) {
  if (!Object.hasOwn(args, 'model_id')) return undefined;
  if (typeof args.model_id !== 'string' || !modelIdPattern.test(args.model_id)) {
    const error = new Error('model_id must be one exact model ID string when supplied.');
    error.code = 'model_id_invalid'; error.stage = 'input_validation';
    error.next_action = 'Pass a nonempty model ID that matches the published model ID format, or omit the field to use the configured route default.';
    throw error;
  }
  return args.model_id;
}

function isLocalAbsolutePath(value) {
  return typeof value === 'string' && !/[\x00-\x1f]/.test(value) && path.isAbsolute(value) &&
    (process.platform !== 'win32' || (/^[a-z]:[\\/]/i.test(value) && !value.slice(2).includes(':')));
}

function within(directory, file) {
  const relative = path.relative(directory, file);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function isProcessRunning(pid) {
  if (!Number.isInteger(pid) || pid < 1) return null;
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (error?.code === 'ESRCH') return false;
    if (error?.code === 'EPERM') return true;
    return null;
  }
}

async function readRegularFile(file) {
  if (!(await fs.lstat(file)).isFile()) throw new Error('Expected a regular JSON configuration file.');
  return fs.readFile(file);
}

async function resolveImage(file, workspaceOrRoots) {
  const legacyWorkspace = !Array.isArray(workspaceOrRoots);
  const workspaces = legacyWorkspace ? [workspaceOrRoots] : workspaceOrRoots;
  const contains = candidate => workspaces.some(root => within(root, candidate));
  if (!isLocalAbsolutePath(file)) throw new Error('Image paths must be absolute local file paths.');
  if (!contains(path.resolve(file))) throw new Error(legacyWorkspace
    ? 'Images must be inside the bound Codex workspace.'
    : 'Images must be inside a registered Codex workspace root.');
  const extension = path.extname(file).toLowerCase();
  if (!['.png', '.jpg', '.jpeg', '.webp'].includes(extension)) {
    throw new Error('Supported image types are PNG, JPEG and WebP.');
  }
  if (!(await fs.lstat(file)).isFile()) throw new Error('Images must be regular files.');
  const realFile = await fs.realpath(file);
  if (!contains(realFile)) throw new Error(legacyWorkspace
    ? 'Image resolves outside the bound Codex workspace.'
    : 'Image resolves outside registered Codex workspace roots.');
  const handle = await fs.open(realFile, 'r');
  const signature = Buffer.alloc(12);
  try {
    if (!(await handle.stat()).isFile()) throw new Error('Images must be regular files.');
    await handle.read(signature, 0, signature.length, 0);
  } finally {
    await handle.close();
  }
  const png = signature.subarray(0, 8).toString('hex') === '89504e470d0a1a0a';
  const jpeg = signature.subarray(0, 3).toString('hex') === 'ffd8ff';
  const webp = signature.toString('ascii', 0, 4) === 'RIFF' && signature.toString('ascii', 8, 12) === 'WEBP';
  if (extension === '.png' ? !png : extension === '.webp' ? !webp : !jpeg) {
    throw new Error('Image file signature does not match its extension.');
  }
  return realFile;
}

function supportsStructuredOutput(version) {
  return version === '2025-06-18' || version === '2025-11-25';
}

function toolResult(data, isError = false, version) {
  return { content: [{ type: 'text', text: JSON.stringify(data) }], isError,
    ...(supportsStructuredOutput(version) ? { structuredContent: data } : {}) };
}

function toolsForVersion(version) {
  return supportsStructuredOutput(version)
    ? tools.map(tool => ({ ...tool, outputSchema: { type: 'object', additionalProperties: true } }))
    : tools;
}

async function findBinding(configPath, workspace) {
  const config = JSON.parse(await readRegularFile(configPath));
  if (config?.version !== 1 || !Array.isArray(config.bindings)) throw new Error('Invalid binding manifest.');
  const projects = new Set();
  const conversations = new Set();
  const matches = [];
  for (const entry of config.bindings) {
    if (!isLocalAbsolutePath(entry?.workspace_root) || !isLocalAbsolutePath(entry.sidecar_root) ||
        typeof entry.project_id !== 'string' || !identityPattern.test(entry.project_id) ||
        typeof entry.conversation_id !== 'string' || !identityPattern.test(entry.conversation_id) ||
        (entry.sidecar_id !== undefined && (typeof entry.sidecar_id !== 'string' || !/^[a-z0-9][a-z0-9_-]*$/i.test(entry.sidecar_id)))) {
      throw new Error('Invalid Antigravity project binding.');
    }
    if (projects.has(entry.project_id)) throw new Error('One Antigravity project cannot serve multiple workspace bindings.');
    if (conversations.has(entry.conversation_id)) throw new Error('One Antigravity conversation cannot serve multiple workspace bindings.');
    projects.add(entry.project_id);
    conversations.add(entry.conversation_id);
    let configuredWorkspace;
    try { configuredWorkspace = await fs.realpath(entry.workspace_root); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (path.relative(workspace, configuredWorkspace) === '') matches.push(entry);
  }
  if (matches.length > 1) throw new Error('Multiple bindings match the current Codex workspace.');
  return matches[0];
}

async function verifyBinding(entry, workspace) {
  const sidecar = await fs.realpath(entry.sidecar_root);
  if (!within(workspace, sidecar)) throw new Error('Sidecar resolves outside the bound Codex workspace.');
  const protocolPath = path.join(sidecar, 'protocol.mjs');
  const agentapiPath = path.join(sidecar, 'official-agentapi.mjs');
  if (!(await fs.lstat(protocolPath)).isFile() || !(await fs.lstat(agentapiPath)).isFile()) {
    throw new Error('Binding requires regular Sidecar protocol and agentapi modules.');
  }
  const protocol = await import(pathToFileURL(protocolPath));
  const agentapi = await import(pathToFileURL(agentapiPath));
  if (path.relative(sidecar, protocol.ROOT) !== '' || protocol.CONVERSATION_ID !== entry.conversation_id || agentapi.EXPECTED_PROJECT_ID !== entry.project_id ||
      !isLocalAbsolutePath(agentapi.EXPECTED_WORKSPACE) || path.relative(workspace, await fs.realpath(agentapi.EXPECTED_WORKSPACE)) !== '') {
    throw new Error('Sidecar project, workspace or conversation does not match the binding manifest.');
  }
  const receiptBytes = await readRegularFile(path.join(sidecar, 'native-identity-result.json'));
  const identity = JSON.parse(receiptBytes);
  if (identity?.version === 1 && process.platform === 'win32') {
    const legacyTuple = [workspace.toLowerCase(), sidecar.toLowerCase(), entry.project_id, entry.conversation_id];
    const digest = createHash('sha256').update(`${JSON.stringify(legacyTuple)}\n`).update(receiptBytes).digest('hex');
    if (/^[a-f0-9]{64}$/.test(legacyIdentityDigest) && digest === legacyIdentityDigest) return { protocol, identityCheckedAt: identity.observedAt };
  }
  const check = identity?.check;
  const observed = check?.observed_binding;
  if (identity?.version !== 2 || identity.state !== 'verified' || identity.appRuntimePresent !== true || !Number.isFinite(Date.parse(identity.observedAt)) ||
      check?.command !== 'get-conversation-metadata' || check.exitCode !== 0 ||
      typeof check.stdoutSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(check.stdoutSha256)) {
    throw new Error('Sidecar has no successful Antigravity project identity check from diagnose-binding.mjs.');
  }
  if (observed?.project_id !== entry.project_id || observed.conversation_id !== entry.conversation_id ||
      !isLocalAbsolutePath(observed.workspace_root) || path.relative(workspace, await fs.realpath(observed.workspace_root)) !== '') {
    throw new Error('Recorded identity evidence does not match the workspace, project or conversation.');
  }
  return { protocol, identityCheckedAt: identity.observedAt };
}

async function main() {
  const configPath = process.argv[2];
  if (!isLocalAbsolutePath(configPath)) throw new Error('Pass the absolute workspace binding manifest path as the first argument.');
  const workspace = await fs.realpath(process.cwd());
  const appConfigDir = path.join(os.homedir(), '.gemini', 'config');
  const registry = createRegistry({ manifestPath: configPath, appConfigDir,
    sidecarsDir: path.join(appConfigDir, 'sidecars'), workerPath: fileURLToPath(new URL('./worker.mjs', import.meta.url)),
    nodeExecutable: process.execPath });

  async function callTool(name, args) {
    if (args === undefined) args = {};
    if (!isObject(args)) throw new Error('Tool arguments must be an object.');
    const allowedKeys = Object.keys(tools.find(tool => tool.name === name).inputSchema.properties);
    if (Object.keys(args).some(key => !allowedKeys.includes(key))) throw new Error('Unexpected tool argument.');

    if (name === 'project_catalog') return registry.catalog({ cwd: workspace });
    if (name === 'connect_project') {
      if (args.apply !== undefined && typeof args.apply !== 'boolean') throw new Error('apply must be a boolean.');
      if (args.default_model !== undefined && typeof args.default_model !== 'string') {
        throw new Error('default_model must be one exact model ID string.');
      }
      if (args.default_model !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(args.default_model)) {
        throw new Error('default_model must be one exact model ID string.');
      }
      return registry.connect({ cwd: workspace, project_id: args.project_id,
        default_model: args.default_model === undefined ? undefined : {
          id: args.default_model, source: 'explicit connect_project configuration',
        }, apply: args.apply === true });
    }

    const routeResult = await registry.resolveRoute({ cwd: workspace });
    if (routeResult.state === 'ambiguous') {
      const error = new Error('Multiple registered Antigravity routes match this workspace.');
      error.code = 'route_ambiguous'; error.stage = 'route_resolution'; error.next_action = 'Use a workspace with one registered project route or remove the duplicate through the registry.';
      throw error;
    }
    const route = routeResult.route ?? null;
    if (name === 'reload_worker') {
      if (!route) {
        const error = new Error('reload_worker requires one registered v3 route for this workspace.');
        error.code = 'route_missing'; error.stage = 'route_resolution';
        error.next_action = 'Use project_catalog and connect_project to inspect or register the existing App project.';
        throw error;
      }
      return reloadWorker(route);
    }
    if (name === 'binding_status') {
      if (route) return registry.status({ cwd: workspace });
      const legacy = await findBinding(configPath, workspace);
      if (!legacy) return { state: 'unbound', workspace_root: workspace,
        registry: await registry.status({ cwd: workspace }) };
      const { identityCheckedAt } = await verifyBinding(legacy, workspace);
      return { state: 'bound', route_schema: 'legacy', workspace_root: workspace, project_id: legacy.project_id,
        conversation_id: legacy.conversation_id, identity_checked_at: identityCheckedAt,
        ...(legacy.sidecar_id ? { sidecar_id: legacy.sidecar_id, chat_tools_configured: true } : {}),
      };
    }
    if (name === 'model_catalog') {
      if (route) return registry.modelCatalog({ cwd: workspace });
      const legacy = await findBinding(configPath, workspace);
      if (legacy) return { provider: 'antigravity-agentapi', dynamic_discovery: 'unavailable',
        default_model: { id: legacyRequestedModel, source: 'legacy_route_compatibility', status: 'legacy_default' }, models: [],
        account_observed: 'unknown' };
      return registry.modelCatalog({ cwd: workspace });
    }
    const taskTool = ['start_chat', 'continue_chat', 'send_message', 'submit_review', 'job_status', 'cancel_job', 'takeover_job', 'read_task_artifact'].includes(name);
    if (taskTool && (typeof args.request_key !== 'string' || !requestKeyPattern.test(args.request_key))) {
      throw new Error('request_key must be a random lowercase UUID v4.');
    }
    if (route) return await callV3Tool(name, args, route);
    if (['send_message', 'read_conversation'].includes(name)) throw new Error('Plain conversation tools require a registered App Sidecar route.');

    const binding = await findBinding(configPath, workspace);
    if (!binding) throw new Error('No Antigravity binding or route for the current Codex workspace. Use project_catalog and connect_project to inspect or register the existing App project.');
    const { protocol } = await verifyBinding(binding, workspace);
    const { ROOT, CONVERSATION_ID, submit, inspectJob } = protocol;
    const turns = turnStore(protocol, workspace);
    const id = `codex-mcp-${args.request_key}`;
    const waitMs = args.wait_ms ?? (name === 'conversation_status' ? runtimeConfig.conversationDefaultWaitMs : 0);
    if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > runtimeConfig.localWaitMaxMs) throw new Error(`wait_ms must be an integer from 0 to ${runtimeConfig.localWaitMaxMs}.`);
    if ((['continue_chat', 'send_message', 'read_conversation', 'conversation_status'].includes(name) || args.conversation_id !== undefined) &&
        (typeof args.conversation_id !== 'string' || !idPattern.test(args.conversation_id))) {
      throw new Error('conversation_id must be a lowercase Antigravity UUID.');
    }
    if (!['submit_review', 'job_status'].includes(name) && !binding.sidecar_id) {
      throw new Error('This workspace Sidecar has not been registered for chat tools.');
    }
    if (name === 'conversation_status') return turns.observe(args.conversation_id, waitMs);
    if (name === 'cancel_job') return turns.cancel(id);
    if (name === 'takeover_job') return turns.requestTakeover(id, args.conversation_id);
    if (name === 'start_chat' || name === 'continue_chat') {
      if (typeof args.prompt !== 'string' || !args.prompt.trim()) throw new Error('prompt must be nonempty.');
      if (args.materials !== undefined && !Array.isArray(args.materials)) throw new Error('materials must be an array.');
      const materials = (args.materials ?? []).map(ref => {
        if (!isObject(ref) || !isLocalAbsolutePath(ref.path) || Object.keys(ref).some(key => !['path', 'sha256'].includes(key)) ||
            (ref.sha256 !== undefined && (typeof ref.sha256 !== 'string' || !shaPattern.test(ref.sha256)))) {
          throw new Error('Each material requires an absolute path and accepts an optional lowercase SHA-256.');
        }
        return { path: ref.path, ...(ref.sha256 ? { sha256: ref.sha256 } : {}) };
      });
      const input = { prompt: args.prompt, materials };
      if (name === 'start_chat') {
        if (args.model_id !== undefined && args.model_id !== legacyRequestedModel) {
          throw new Error('This legacy route does not support explicit model selection; connect it through the v3 registry first.');
        }
        if (args.title !== undefined && (typeof args.title !== 'string' || !args.title.trim() || /[\x00-\x1f]/.test(args.title))) {
          throw new Error('title must be nonempty and on one line.');
        }
        return turns.submit(id, { operation: 'start', title: `${args.title?.trim() ?? defaultTitle} [${args.request_key.slice(0, 8)}]`, ...input });
      }
      if (typeof args.cursor !== 'string' || !shaPattern.test(args.cursor)) throw new Error('Use a current cursor from conversation_status.');
      return turns.submit(id, { operation: 'continue', conversation_id: args.conversation_id, cursor: args.cursor, ...input });
    }

    if (name === 'submit_review') {
      if (typeof args.prompt !== 'string' || !args.prompt.trim()) throw new Error('prompt must be nonempty.');
      if (Object.hasOwn(args, 'model_id')) {
        const error = new Error('The legacy review route sends to its existing conversation and cannot select or change its model. Omit model_id or connect this project through the v3 route for new model selection.');
        error.code = 'legacy_model_selection_unsupported'; error.stage = 'input_validation';
        error.next_action = 'Omit model_id to continue the legacy review route with its existing conversation model, or use a v3 project route for a new conversation.';
        throw error;
      }
      if (args.image_paths !== undefined && !Array.isArray(args.image_paths)) throw new Error('image_paths must be an array.');
      const images = [];
      for (const file of args.image_paths ?? []) images.push(await resolveImage(file, workspace));
      const reviewBrief = [
        'Perform this independent technical review using only the images explicitly listed below and the supplied review brief.',
        'Treat each numbered path as an image to inspect in order. If any image cannot be inspected, report that fact and which image is affected. Do not claim to have seen it.',
        'Read no other project files and write only candidate.md and completion.json in this task directory. Do not change sources or take external actions.',
        `Images in order (JSON array): ${JSON.stringify(images)}`,
        `Review brief:\n${args.prompt}`,
      ].join('\n');
      const legacyPrompt = `${reviewPolicy}\n\n${reviewBrief}`;
      const legacyRequestPath = path.join(ROOT, 'runtime', 'jobs', id, 'request.json');
      try {
        const prior = JSON.parse(await readRegularFile(legacyRequestPath));
        if (prior.id !== id || prior.mode !== 'technical' ||
            (prior.prompt !== legacyPrompt && prior.prompt !== reviewBrief)) {
          throw new Error('Same job ID has different prompt.');
        }
        return { ...await inspectJob(ROOT, id), duplicate: true, conversation_id: CONVERSATION_ID,
          compatibility: 'legacy_review_replay' };
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      let queued;
      if (await turns.exists(id)) throw new Error('request_key is already used by a chat turn.');
      // Old registrations retain their exact on-disk review protocol.
      if (binding.sidecar_id) await turns.reserve(id, 'review');
      try {
        queued = await submit(ROOT, id, legacyPrompt, 'technical');
      } catch (error) {
        if (error.message !== 'Same job ID has different prompt') throw error;
        // Before the review policy was added, the same request omitted its preface.
        // Recognize a matching old request without rewriting or resending it.
        const prior = JSON.parse(await readRegularFile(path.join(ROOT, 'runtime', 'jobs', id, 'request.json')));
        if (prior.prompt !== reviewBrief) throw error;
        queued = { duplicate: true };
      }
      return { ...await inspectJob(ROOT, id), duplicate: queued.duplicate, conversation_id: CONVERSATION_ID };
    }

    if (name === 'read_task_artifact') {
      if (await turns.exists(id)) {
        return turns.readArtifact(id, args.name, args.offset_bytes ?? 0, args.length_bytes ?? runtimeConfig.artifactPageBytes);
      }
      const job = await inspectJob(ROOT, id);
      if (job.state !== 'done') return job;
      if (args.name !== 'candidate.md') throw new Error('Artifact is not declared by the legacy review protocol.');
      const candidatePath = path.join(ROOT, 'runtime', 'jobs', id, 'candidate.md');
      const page = await readArtifactPage(candidatePath, { name: 'candidate.md', mime_type: 'text/markdown',
        bytes: job.candidateBytes, sha256: job.candidateSha256 }, {
        offset: args.offset_bytes ?? 0, length: args.length_bytes ?? runtimeConfig.artifactPageBytes,
      });
      return { id, state: 'done', ...page };
    }

    if (await turns.exists(id)) return waitFor(() => turns.status(id), job => !isTurnPending(job), waitMs);
    const job = await waitFor(() => inspectJob(ROOT, id),
      result => !['queued', 'delivery_unknown', 'completion_unknown'].includes(result.state), waitMs);
    if (job.state !== 'done') return job;
    const candidatePath = path.join(ROOT, 'runtime', 'jobs', id, 'candidate.md');
    if (job.candidateBytes > runtimeConfig.inlineArtifactBytes) return { ...job, candidate_path: candidatePath };
    const candidate = await fs.readFile(candidatePath);
    if (createHash('sha256').update(candidate).digest('hex') !== job.candidateSha256) {
      throw new Error('Candidate changed while reading. Check the Antigravity conversation.');
    }
    return { ...job, candidate_path: candidatePath, candidate_markdown: candidate.toString('utf8') };
  }

  async function assertWorkerReady(route) {
    const health = await registry.status({ cwd: workspace });
    const currentRoute = health.route?.value;
    const worker = health.worker;
    const routeMatches = health.route?.state === 'verified' && currentRoute?.route_id === route.route_id &&
      currentRoute?.project_id === route.project_id && currentRoute?.sidecar_id === route.sidecar_id &&
      currentRoute?.state_root === route.state_root;
    if (routeMatches && health.app_registration?.state === 'verified' && worker?.state === 'verified' &&
        worker.route_config_state === 'verified' && worker.runtime_state === 'verified' &&
        worker.heartbeat?.state === 'ready') return health;
    const error = new Error(`The App worker is not ready for new native work (route=${health.route?.state ?? 'unknown'}, App=${health.app_registration?.state ?? 'unknown'}, worker=${worker?.state ?? 'unknown'}, route_config=${worker?.route_config_state ?? 'unknown'}, runtime=${worker?.runtime_state ?? 'unknown'}).`);
    error.code = 'worker_not_ready'; error.stage = 'worker_preflight';
    error.next_action = health.next_action ?? 'Reload the matching App Sidecar configuration, then verify a fresh worker heartbeat before submitting.';
    throw error;
  }

  async function acquireTaskAcceptance(route) {
    const release = await acquireRouteSubmissionGate(route);
    try {
      await assertWorkerReady(route);
      return release;
    } catch (error) {
      await release();
      throw error;
    }
  }

  async function reloadWorker(route, gateHeld = false) {
    const health = await registry.status({ cwd: workspace });
    const registered = health.route?.state === 'verified' && health.route.value?.route_id === route.route_id &&
      health.route.value?.project_id === route.project_id && health.route.value?.sidecar_id === route.sidecar_id &&
      health.route.value?.state_root === route.state_root &&
      health.app_registration?.global_config?.expected_project_id === route.project_id &&
      health.app_registration?.global_config?.observed_project_id === route.project_id &&
      health.app_registration?.descriptor?.state === 'verified';
    if (!registered || health.app_registration?.enabled !== true) {
      const error = new Error('reload_worker requires the existing route and enabled App Sidecar registration to match exactly.');
      error.code = 'reload_identity_unverified'; error.stage = 'worker_reload_preflight';
      error.next_action = 'Use binding_status and connect_project with the explicit existing project_id to resolve route or App identity before reload.';
      throw error;
    }
    if (health.worker?.state === 'verified' && health.worker?.heartbeat?.state === 'ready') {
      return { state: 'already_ready', project_id: route.project_id, sidecar_id: route.sidecar_id,
        worker_pid: health.worker.heartbeat.pid,
        worker_config_sha256: health.worker.expected_worker_config_sha256,
        runtime_sha256: health.worker.expected_runtime_sha256 };
    }
    if (!gateHeld) {
      const release = await acquireRouteReloadGate(route);
      try { return await reloadWorker(route, true); }
      finally { await release(); }
    }
    const heartbeat = health.worker?.heartbeat;
    if (!heartbeat || heartbeat.route_id !== route.route_id || heartbeat.project_id !== route.project_id ||
        heartbeat.sidecar_id !== route.sidecar_id || !Number.isInteger(heartbeat.pid) || heartbeat.pid === process.pid) {
      const error = new Error('reload_worker cannot identify a matching App worker process from its route heartbeat.');
      error.code = 'worker_pid_unverified'; error.stage = 'worker_reload_preflight';
      error.next_action = 'Wait for a matching worker heartbeat or inspect the App Sidecar runtime; no process was stopped.';
      throw error;
    }
    const previousProcessState = isProcessRunning(heartbeat.pid);
    const heartbeatTime = Date.parse(heartbeat.at ?? heartbeat.last_seen_at ?? '');
    const heartbeatAge = Date.now() - heartbeatTime;
    const heartbeatFresh = Number.isFinite(heartbeatTime) && heartbeatAge >= -60_000 &&
      heartbeatAge <= runtimeConfig.workerHeartbeatStaleMs;
    if (previousProcessState === null || (previousProcessState && !heartbeatFresh)) {
      const error = new Error('reload_worker cannot safely match the live process to a fresh route heartbeat.');
      error.code = 'worker_pid_unverified'; error.stage = 'worker_reload_preflight';
      error.next_action = 'Wait for a fresh route heartbeat or inspect the Sidecar process; no App config was changed.';
      throw error;
    }
    const store = createTaskStore(route, { originWorkspaceRoot: workspace });
    const statuses = await store.listStatuses();
    const unresolved = statuses.filter(item => !reloadSettledTaskStates.has(item.state));
    if (unresolved.length) {
      const error = new Error(`reload_worker refused because ${unresolved.length} task(s) are not settled.`);
      error.code = 'worker_tasks_unsettled'; error.stage = 'worker_reload_preflight';
      error.next_action = 'Use job_status for the original request keys and resolve every queued, running, unknown, or manually taken-over task before reload.';
      throw error;
    }

    const observationsRoot = path.join(route.state_root, 'runtime', 'conversation-observations');
    let pendingObservations = 0;
    if (await store.protocol.exists(observationsRoot)) {
      await store.protocol.safeDirectory(observationsRoot);
      for (const entry of await fs.readdir(observationsRoot)) {
        if (!idPattern.test(entry)) throw new Error('Conversation observation queue contains an invalid identifier.');
        const directory = path.join(observationsRoot, entry);
        await store.protocol.safeDirectory(directory);
        const requestFile = path.join(directory, 'request.json');
        const observationFile = path.join(directory, 'observation.json');
        if (!await store.protocol.exists(requestFile)) continue;
        const request = await store.protocol.readJson(requestFile);
        const observation = await store.protocol.exists(observationFile)
          ? await store.protocol.readJson(observationFile) : null;
        if (!observation || observation.requested_at !== request.requested_at) pendingObservations += 1;
      }
    }
    if (pendingObservations) {
      const error = new Error(`reload_worker refused because ${pendingObservations} conversation observation(s) are pending.`);
      error.code = 'worker_observations_pending'; error.stage = 'worker_reload_preflight';
      error.next_action = 'Wait for conversation_status to settle before reloading the App Sidecar.';
      throw error;
    }

    const previousPid = heartbeat.pid;
    const disabled = await registry.setSidecarEnabled({ cwd: workspace, enabled: false });
    const stopDeadline = Date.now() + runtimeConfig.sidecarStopWaitMs;
    let processState;
    while (Date.now() < stopDeadline) {
      processState = isProcessRunning(previousPid);
      if (processState === false) break;
      await delay(runtimeConfig.statePollMs);
    }
    if (processState !== false) {
      let restore;
      try { restore = await registry.setSidecarEnabled({ cwd: workspace, enabled: true }); }
      catch (error) {
        const conflict = new Error(`The old App worker did not stop and the Sidecar could not be safely re-enabled: ${error.message}`);
        conflict.code = 'worker_reload_restore_failed'; conflict.stage = 'worker_reload_stop';
        conflict.next_action = 'Inspect binding_status and the App-owned Sidecar entry before any manual change.';
        throw conflict;
      }
      return { state: 'worker_stop_timeout', project_id: route.project_id, sidecar_id: route.sidecar_id,
        previous_worker_pid: previousPid, registration_state: restore.state,
        next_action: 'The Sidecar was re-enabled, but its previous worker PID remained alive. Do not kill it; inspect the App Sidecar runtime before retrying.' };
    }

    const enabled = await registry.setSidecarEnabled({ cwd: workspace, enabled: true });
    const readyDeadline = Date.now() + runtimeConfig.sidecarReadyWaitMs;
    let current = await registry.status({ cwd: workspace });
    while (Date.now() < readyDeadline) {
      if (current.route?.state === 'verified' && current.app_registration?.state === 'verified' &&
          current.worker?.state === 'verified' && current.worker.runtime_state === 'verified' &&
          current.worker.route_config_state === 'verified' && current.worker.heartbeat?.state === 'ready' &&
          current.worker.heartbeat.pid !== previousPid) {
        return { state: 'ready', project_id: route.project_id, sidecar_id: route.sidecar_id,
          previous_worker_pid: previousPid, worker_pid: current.worker.heartbeat.pid,
          worker_config_sha256: current.worker.expected_worker_config_sha256,
          runtime_sha256: current.worker.expected_runtime_sha256,
          disable_transaction_id: disabled.transaction_id ?? null,
          enable_transaction_id: enabled.transaction_id ?? null };
      }
      await delay(runtimeConfig.statePollMs);
      current = await registry.status({ cwd: workspace });
    }
    return { state: 'enabled_waiting_for_worker', project_id: route.project_id, sidecar_id: route.sidecar_id,
      previous_worker_pid: previousPid, app_registration: current.app_registration?.state ?? 'unknown',
      worker: current.worker?.state ?? 'unknown', runtime_state: current.worker?.runtime_state ?? 'unknown',
      next_action: current.next_action ?? 'Wait for a fresh worker heartbeat; do not dispatch until binding_status verifies the current runtime.' };
  }

  async function callV3Tool(name, args, route) {
    if (name === 'binding_status') return registry.status({ cwd: workspace });
    if (name === 'model_catalog') return registry.modelCatalog({ cwd: workspace });
    const turns = createTaskStore(route, { originWorkspaceRoot: workspace });
    const id = `codex-mcp-${args.request_key}`;
    const waitMs = args.wait_ms ?? (['conversation_status', 'read_conversation'].includes(name) ? runtimeConfig.conversationDefaultWaitMs : 0);
    if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > runtimeConfig.localWaitMaxMs) {
      throw new Error(`wait_ms must be an integer from 0 to ${runtimeConfig.localWaitMaxMs}.`);
    }
    if ((['continue_chat', 'send_message', 'read_conversation', 'conversation_status'].includes(name) || args.conversation_id !== undefined) &&
        (typeof args.conversation_id !== 'string' || !idPattern.test(args.conversation_id))) {
      throw new Error('conversation_id must be a lowercase Antigravity UUID.');
    }
    if (name === 'conversation_status' || name === 'read_conversation') {
      const release = await acquireTaskAcceptance(route);
      try {
        const status = await turns.observe(args.conversation_id, waitMs, 'chat');
        if (name === 'conversation_status' || ['observation_pending', 'conversation_unverified'].includes(status.state)) return status;
        const afterStep = args.after_step ?? -1, limit = args.limit ?? 20;
        if (!Number.isInteger(afterStep) || afterStep < -1 || !Number.isInteger(limit) || limit < 1) throw new Error('after_step must be >= -1 and limit must be >= 1.');
        const result = await readConversationMessages(args.conversation_id);
        const remaining = result.messages.filter(message => message.step_index > afterStep);
        const messages = remaining.slice(0, limit);
        return { ...status, ...result, ...(status.cursor !== result.cursor ? { state: 'conversation_changed' } : {}), messages, has_more: remaining.length > messages.length,
          next_after_step: messages.at(-1)?.step_index ?? afterStep };
      }
      finally { await release(); }
    }
    if (name === 'send_message') {
      if (typeof args.prompt !== 'string' || !args.prompt.trim()) throw new Error('prompt must be nonempty.');
      if (typeof args.cursor !== 'string' || !shaPattern.test(args.cursor)) throw new Error('Use a current cursor from conversation_status.');
      return turns.submit(id, { operation: 'continue', task_kind: 'chat', conversation_id: args.conversation_id,
        cursor: args.cursor, prompt: args.prompt, materials: [] }, { beforeAccept: () => acquireTaskAcceptance(route) });
    }
    if (name === 'cancel_job') return turns.cancel(id);
    if (name === 'takeover_job') return turns.requestTakeover(id, args.conversation_id);
    if (name === 'start_chat' || name === 'continue_chat') {
      if (typeof args.prompt !== 'string' || !args.prompt.trim()) throw new Error('prompt must be nonempty.');
      if (args.materials !== undefined && !Array.isArray(args.materials)) throw new Error('materials must be an array.');
      const materials = (args.materials ?? []).map(ref => {
        if (!isObject(ref) || !isLocalAbsolutePath(ref.path) || Object.keys(ref).some(key => !['path', 'sha256'].includes(key)) ||
            (ref.sha256 !== undefined && (typeof ref.sha256 !== 'string' || !shaPattern.test(ref.sha256)))) {
          throw new Error('Each material requires an absolute path and accepts an optional lowercase SHA-256.');
        }
        return { path: ref.path, ...(ref.sha256 ? { sha256: ref.sha256 } : {}) };
      });
      if (name === 'start_chat') {
        const modelId = explicitModelId(args);
        if (args.title !== undefined && (typeof args.title !== 'string' || !args.title.trim() || /[\x00-\x1f]/.test(args.title))) {
          throw new Error('title must be nonempty and on one line.');
        }
        const task = { operation: 'start', task_kind: 'writing',
          title: `${args.title?.trim() ?? defaultTitle} [${args.request_key.slice(0, 8)}]`,
          prompt: args.prompt, materials, ...(modelId !== undefined ? { model_id: modelId } : {}) };
        return turns.submit(id, task, { beforeAccept: () => acquireTaskAcceptance(route) });
      }
      if (args.model_id !== undefined) throw new Error('continue_chat uses the model of its existing App conversation.');
      if (typeof args.cursor !== 'string' || !shaPattern.test(args.cursor)) throw new Error('Use a current cursor from conversation_status.');
      return turns.submit(id, { operation: 'continue', task_kind: 'writing', conversation_id: args.conversation_id,
        cursor: args.cursor, prompt: args.prompt, materials }, { beforeAccept: () => acquireTaskAcceptance(route) });
    }
    if (name === 'submit_review') {
      if (typeof args.prompt !== 'string' || !args.prompt.trim()) throw new Error('prompt must be nonempty.');
      const modelId = explicitModelId(args);
      if (args.image_paths !== undefined && !Array.isArray(args.image_paths)) throw new Error('image_paths must be an array.');
      const roots = route.workspace_roots.map(root => root.path);
      const images = [];
      for (const file of args.image_paths ?? []) images.push(await resolveImage(file, roots));
      const reviewBrief = [
        'Perform this independent technical review using only the image materials explicitly listed below and the supplied review brief.',
        'Inspect image materials in order. If an image cannot be inspected, report which image is affected. Do not claim to have seen it.',
        'Read no other project files and write only candidate.md and completion.json in this task directory. Do not change sources or take external actions.',
        `The image materials are the first materials in this task, in the submitted order. Use their task snapshots; do not reopen source paths.`,
        `Review brief:\n${args.prompt}`,
      ].join('\n');
      const legacyReviewBrief = [
        'Perform this independent technical review using only the images explicitly listed below and the supplied review brief.',
        'Treat each numbered path as an image to inspect in order. If any image cannot be inspected, report that fact and which image is affected. Do not claim to have seen it.',
        'Read no other project files and write only candidate.md and completion.json in this task directory. Do not change sources or take external actions.',
        `Images in order (JSON array): ${JSON.stringify(images)}`,
        `Review brief:\n${args.prompt}`,
      ].join('\n');
      const legacyReviewPrompt = `${reviewPolicy}\n\n${legacyReviewBrief}`;
      const materials = images.map(file => ({ path: file }));
      const priorLegacy = await inspectLegacyTask(route.state_root, id, {
        expectedPrompts: [legacyReviewPrompt, legacyReviewBrief], expectedMode: 'technical',
      });
      if (priorLegacy) {
        if (priorLegacy.key_matches === false) throw new Error('Same job ID has different prompt.');
        return { ...priorLegacy, duplicate: true, compatibility: 'legacy_review_replay',
          ...(priorLegacy.key_matches === undefined ? { next_action: 'The legacy record is incomplete or invalid; inspect it before any new submission.' } : {}) };
      }
      return turns.submit(id, { operation: 'start', task_kind: 'review',
        title: `Technical review [${args.request_key.slice(0, 8)}]`,
        prompt: `${reviewPolicy}\n\n${reviewBrief}`, materials,
        ...(modelId !== undefined ? { model_id: modelId } : {}) }, { beforeAccept: () => acquireTaskAcceptance(route) });
    }
    if (name === 'job_status') {
      const legacy = await inspectLegacyTask(route.state_root, id);
      if (legacy) return legacy;
      if (!await turns.exists(id)) return { id, state: 'not_found', next_action: 'Check the original request key and route.' };
      return waitFor(() => turns.status(id), job => !isTurnPending(job), waitMs);
    }
    if (name === 'read_task_artifact') {
      const legacy = await inspectLegacyTask(route.state_root, id);
      if (legacy) {
        if (legacy.state !== 'done') return legacy;
        if (args.name !== 'candidate.md') throw new Error('Artifact is not declared by the legacy review protocol.');
        const page = await readArtifactPage(legacy.candidate_path, { name: 'candidate.md', mime_type: 'text/markdown',
          bytes: legacy.candidateBytes, sha256: legacy.candidateSha256 }, {
          offset: args.offset_bytes ?? 0, length: args.length_bytes ?? runtimeConfig.artifactPageBytes,
        });
        return { ...legacy, ...page };
      }
      if (!await turns.exists(id)) return { id, state: 'not_found' };
      const page = await turns.readArtifact(id, args.name, args.offset_bytes ?? 0,
        args.length_bytes ?? runtimeConfig.artifactPageBytes);
      return page;
    }
    throw new Error(`Tool ${name} is not available for a v3 project route.`);
  }

  let phase = 'initializing';
  let negotiatedVersion;
  const respond = (id, value) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, ...value })}\n`);
  const error = (id, code, message) => respond(id, { error: { code, message } });
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const calls = new Set();
  for await (const line of lines) {
    let message;
    try { message = JSON.parse(line); }
    catch { error(null, -32700, 'Parse error'); continue; }
    if (!isObject(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      error(null, -32600, 'Invalid request');
      continue;
    }
    const { id, method, params } = message;
    if (id === undefined) {
      if (method === 'notifications/initialized' && phase === 'negotiated') phase = 'ready';
      continue;
    }
    if (typeof id !== 'string' && typeof id !== 'number') {
      error(null, -32600, 'Invalid request ID');
      continue;
    }
    if (method === 'initialize' && phase === 'initializing') {
      if (typeof params?.protocolVersion !== 'string') { error(id, -32602, 'protocolVersion is required'); continue; }
      phase = 'negotiated';
      negotiatedVersion = protocolVersions.includes(params.protocolVersion) ? params.protocolVersion : protocolVersions[0];
      respond(id, { result: {
        protocolVersion: negotiatedVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'antigravity-gemini', version: '3.0.0' },
        instructions: `Project artifact tools use the verified workspace route. On v3 routes, send_message/read_conversation address any explicitly identified existing App conversation, including outside-of-project. Submit only content authorized for Gemini. Use project_catalog/connect_project to inspect or register an existing transport project, then binding_status to confirm route and worker state. The App-managed Sidecar must be running to process queued tasks.`,
      } });
    } else if (method === 'ping') {
      respond(id, { result: {} });
    } else if (phase !== 'ready') {
      error(id, -32002, 'MCP initialization is incomplete');
    } else if (method === 'tools/list') {
      respond(id, { result: { tools: toolsForVersion(negotiatedVersion) } });
    } else if (method === 'tools/call' && tools.some(tool => tool.name === params?.name)) {
      const pending = callTool(params.name, params.arguments)
        .then(value => respond(id, { result: toolResult(value, false, negotiatedVersion) }),
          cause => {
            const message = cause?.message ?? String(cause);
            const detail = { code: cause?.code ?? 'tool_call_failed', stage: cause?.stage ?? 'tool_call',
              message, next_action: cause?.next_action ?? 'Check the reported state and retry only when the original delivery state is known.',
              error: message };
            respond(id, { result: toolResult(detail, true, negotiatedVersion) });
          });
      if (['conversation_status', 'read_conversation'].includes(params.name) || (params.name === 'job_status' && params.arguments?.wait_ms > 0)) {
        calls.add(pending);
        pending.finally(() => calls.delete(pending));
      } else {
        await pending;
      }
    } else if (method === 'tools/call') {
      error(id, -32602, 'Unknown tool');
    } else {
      error(id, -32601, 'Method not found');
    }
  }
  await Promise.allSettled(calls);
}

try { await main(); }
catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }

