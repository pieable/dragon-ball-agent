import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nativeCall, transcriptSummary, isConversationInput, matchesRequestInput, isFinalPlannerResponse } from './native-chat.mjs';
import { hash, idPattern, readRegular } from './turns.mjs';
import { readConversationMessages } from './conversation-log.mjs';

const samePath = (left, right) => path.relative(left, right) === '';
const localConfig = path.join(os.homedir(), '.gemini', 'config');

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function readJson(file) {
  return JSON.parse(await readRegular(file));
}

function idsInCreation(value, ids = new Set()) {
  if (!value || typeof value !== 'object') return ids;
  for (const [key, child] of Object.entries(value)) {
    if (/^(?:(?:root|new)[_-]?)?(?:conversation|cascade)[_-]?id$/i.test(key) &&
        typeof child === 'string' && idPattern.test(child)) ids.add(child);
    if (child && typeof child === 'object' && !/token|secret|credential|authorization/i.test(key)) {
      idsInCreation(child, ids);
    }
  }
  return ids;
}

async function uriRoots(values) {
  if (!Array.isArray(values) || !values.length) throw new Error('App metadata did not identify local workspaces.');
  const result = [];
  for (const entry of values) {
    const uri = entry?.workspaceFolderAbsoluteUri;
    if (typeof uri !== 'string' || !uri.startsWith('file:')) {
      throw new Error('App metadata contains an unsupported workspace URI.');
    }
    result.push(await fs.realpath(fileURLToPath(uri)));
  }
  const normalized = [...new Set(result)].sort((a, b) => a.localeCompare(b));
  if (normalized.length !== result.length) throw new Error('App metadata repeats a workspace root.');
  return normalized;
}

async function projectRoots(project) {
  const resources = project?.projectResources?.resources;
  if (!Array.isArray(resources) || !resources.length) throw new Error('App project has no supported resource list.');
  const roots = [];
  for (const resource of resources) {
    const candidates = [
      ['gitFolder', resource?.gitFolder?.folderUri],
      ['localFolder', resource?.localFolder?.folderUri],
      ['folder', resource?.folderUri],
    ].filter(([, uri]) => typeof uri === 'string');
    if (candidates.length !== 1) throw new Error('App project contains an unsupported or ambiguous resource shape.');
    const [kind, uri] = candidates[0];
    if (!uri.startsWith('file:')) throw new Error('App project resource is not a local file URI.');
    roots.push({ kind, path: await fs.realpath(fileURLToPath(uri)) });
  }
  const paths = roots.map(root => root.path);
  if (new Set(paths).size !== paths.length) throw new Error('App project repeats a workspace root.');
  return roots.sort((a, b) => a.path.localeCompare(b.path));
}

function compareRootSets(observed, expected) {
  if (observed.length !== expected.length) return false;
  const actual = observed.map(value => typeof value === 'string' ? value : value.path)
    .sort((a, b) => a.localeCompare(b));
  const wanted = expected.map(root => typeof root === 'string' ? root : root.path)
    .sort((a, b) => a.localeCompare(b));
  return actual.every((value, index) => samePath(value, wanted[index]));
}

/**
 * App Sidecar provider. The route is data from the registered project registry;
 * the adapter verifies App ownership before dispatch and never requires an
 * anchor conversation for a new project.
 */
export function appProvider(executable, nativeArgv, route, {
  call = nativeCall,
  configDir = localConfig,
  geminiRoot = path.dirname(configDir),
} = {}) {
  const expectedRoots = route.workspace_roots.map(root => ({ path: root.path }));
  const invoke = args => call(executable, nativeArgv, args);

  async function verifyRegistration() {
    const config = await readJson(path.join(configDir, 'config.json'));
    const registration = config?.sidecars?.[route.sidecar_id];
    if (registration?.enabled !== true || registration.projectId !== route.project_id) {
      throw new Error('App Sidecar registration is not enabled for this project.');
    }
    const project = await readJson(path.join(configDir, 'projects', `${route.project_id}.json`));
    if (project.id !== route.project_id || !compareRootSets(await projectRoots(project), expectedRoots)) {
      throw new Error('App project resources differ from the registered workspace roots.');
    }
    return { registered: true, project_id: route.project_id };
  }

  async function metadata(conversationId, request) {
    if (!idPattern.test(conversationId)) throw new Error('Invalid Antigravity conversation ID.');
    const { response, evidence } = await invoke(['get-conversation-metadata', conversationId]);
    if (evidence.native_error) throw new Error(evidence.native_error);
    if (evidence.timed_out || evidence.spawn_error || (evidence.exit_code !== undefined && evidence.exit_code !== 0)) {
      throw new Error(`get-conversation-metadata failed: exit=${evidence.exit_code ?? 'unknown'}, timed_out=${Boolean(evidence.timed_out)}${evidence.stderr_text ? `; ${evidence.stderr_text}${evidence.stderr_truncated ? ' [stderr truncated]' : ''}` : ''}`);
    }
    const data = response?.conversationMetadata?.metadata;
    const explicit = request?.task_kind === 'chat';
    if (!isObject(data) || (!explicit && data.projectId !== route.project_id) || data.rootConversationId !== conversationId) {
      throw new Error('Conversation metadata does not verify this project and conversation.');
    }
    const roots = explicit ? [] : await uriRoots(data.workspaces);
    if (!explicit && !compareRootSets(roots, expectedRoots)) {
      throw new Error('Conversation metadata workspace roots differ from this project.');
    }
    return {
      project_id: data.projectId,
      conversation_id: conversationId,
      workspace_roots: roots,
      ...(explicit ? { workspaces: data.workspaces ?? [] } : {}),
      observed_model: typeof data.modelName === 'string' && /^gemini-[0-9a-z.-]+$/.test(data.modelName)
        ? data.modelName : null,
      evidence: { command: 'get-conversation-metadata', exit_code: evidence.exit_code,
        stdout_bytes: evidence.stdout_bytes, stdout_sha256: evidence.stdout_sha256 },
    };
  }

  async function progress(conversationId, request) {
    try {
      let directory = path.join(geminiRoot, 'antigravity', 'brain');
      for (const part of [conversationId, '.system_generated', 'logs']) {
        directory = path.join(directory, part);
        const info = await fs.lstat(directory);
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe transcript directory.');
      }
      const bytes = await readRegular(path.join(directory, 'transcript.jsonl'));
      const summary = transcriptSummary(bytes, request);
      if (request?.task_kind === 'chat' && request.id && request.nonce) {
        const visible = await readConversationMessages(conversationId, { geminiRoot });
        if (visible.cursor !== hash(bytes)) return { state: 'app_active_or_unsettled' };
        const rows = bytes.toString('utf8').split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line));
        const start = rows.findLastIndex(row => matchesRequestInput(row, request));
        if (start >= 0) {
          const next = rows.findIndex((row, index) => index > start && isConversationInput(row));
          const last = rows[(next < 0 ? rows.length : next) - 1];
          const reply = visible.messages.find(row => row.step_index === last?.step_index && row.role === 'assistant' && row.status === 'DONE');
          if (isFinalPlannerResponse(last) && reply) return { ...summary, reply };
        }
      }
      return summary;
    } catch (error) {
      return { state: 'transcript_unavailable', error: error.message };
    }
  }

  async function observe(conversationId, request) {
    const info = await metadata(conversationId, request);
    return { conversation_id: conversationId, project_id: info.project_id, observed_model: info.observed_model,
      ...await progress(conversationId, request) };
  }

  async function dispatch(request, message) {
    const fresh = request.operation === 'start';
    if (fresh && (typeof request.requested_model !== 'string' || !request.requested_model.trim())) {
      throw new Error('No model was resolved for this new conversation.');
    }
    const args = fresh
      ? ['new-conversation', '--model=' + request.requested_model, '--title=' + request.title, message]
      : ['send-message', request.conversation_id, message];
    const { response, evidence } = await invoke(args);
    if (fresh) {
      const ids = [...idsInCreation(response?.newConversation)];
      return { ...evidence, acknowledged: ids.length === 1, conversation_id: ids.length === 1 ? ids[0] : null };
    }
    return { ...evidence, acknowledged: Boolean(response?.sendMessage), conversation_id: request.conversation_id };
  }

  return { verifyRegistration, verifyCreation: verifyRegistration, metadata, progress, observe, dispatch };
}
