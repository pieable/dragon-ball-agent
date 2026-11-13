import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { observedBinding } from './diagnose-binding.mjs';
import { hash, idPattern, readRegular } from './turns.mjs';
import { runNativeCommand } from './native-command.mjs';

const samePath = (a, b) => path.relative(a, b) === '';
const localRoot = path.join(os.homedir(), '.gemini');

export function nativeCall(executable, nativeArgv, args) {
  return runNativeCommand(executable.file, nativeArgv(executable, args));
}

function idsInCreation(value, ids = new Set()) {
  if (!value || typeof value !== 'object') return ids;
  for (const [key, child] of Object.entries(value)) {
    if (/^(?:(?:root|new)[_-]?)?(?:conversation|cascade)[_-]?id$/i.test(key) &&
        typeof child === 'string' && idPattern.test(child)) ids.add(child);
    if (typeof child === 'object' && !/token|secret|credential|authorization/i.test(key)) idsInCreation(child, ids);
  }
  return ids;
}

export async function verifyRegistration(configDir, { sidecarId, projectId, workspace }) {
  const config = JSON.parse(await readRegular(path.join(configDir, 'config.json')));
  const registration = config.sidecars?.[sidecarId];
  if (registration?.enabled !== true || registration.projectId !== projectId) {
    throw new Error('App Sidecar registration is not enabled for this Antigravity project.');
  }
  const project = JSON.parse(await readRegular(path.join(configDir, 'projects', projectId + '.json')));
  const resources = project.projectResources?.resources;
  const uri = resources?.[0]?.gitFolder?.folderUri;
  if (project.id !== projectId || !Array.isArray(resources) || resources.length !== 1 ||
      typeof uri !== 'string' || !uri.startsWith('file:') ||
      !samePath(workspace, await fs.realpath(fileURLToPath(uri)))) {
    throw new Error('The App project does not identify exactly this workspace.');
  }
}

export function isConversationInput(row) {
  return row?.status === 'DONE' && typeof row.content === 'string' &&
    (row.type === 'USER_INPUT' || (row.type === 'SYSTEM_MESSAGE' &&
      row.content.split(/\r?\n/).some(line => /^\[Message\] timestamp=\S+ sender=\S+ priority=\S+ content=/.test(line))));
}

export function matchesRequestInput(row, request) {
  if (!request?.id || !request?.nonce || !isConversationInput(row)) return false;
  const marker = `OpenAI Codex task ${request.id} / ${request.nonce}.`;
  return row.content.split(/\r?\n/).some(line => {
    const text = line.trim();
    if (row.type === 'USER_INPUT') return text === marker || text === '<USER_REQUEST>' + marker;
    const header = /^\[Message\] timestamp=\S+ sender=\S+ priority=\S+ content=/;
    return header.test(text) && text.replace(header, '') === marker;
  });
}

export function isFinalPlannerResponse(row) {
  return row?.type === 'PLANNER_RESPONSE' && row.status === 'DONE' && typeof row.content === 'string' &&
    (row.tool_calls == null || (Array.isArray(row.tool_calls) && row.tool_calls.length === 0));
}

export function transcriptSummary(bytes, request) {
  let rows;
  try {
    rows = bytes.toString('utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  } catch {
    return { state: 'transcript_unavailable' };
  }
  const isInput = isConversationInput;
  const latestInput = rows.findLastIndex(isInput);
  if (latestInput < 0) return { state: 'transcript_unavailable' };
  const includesMarker = row => matchesRequestInput(row, request);
  const requestObserved = Boolean(request && rows.some(includesMarker));
  const current = rows.slice(latestInput + 1);
  const last = current.at(-1);
  const associated = request ? { request_observed: requestObserved, request_current: includesMarker(rows[latestInput]) } : {};
  if (!isFinalPlannerResponse(last)) {
    return { state: 'app_active_or_unsettled', ...associated };
  }
  return {
    state: 'ready', cursor: hash(bytes),
    ...(typeof last.created_at === 'string' && Number.isFinite(Date.parse(last.created_at)) ? { last_event_at: last.created_at } : {}),
    ...associated,
  };
}

async function readTranscript(brain, id) {
  let directory = brain;
  for (const part of [id, '.system_generated', 'logs']) {
    directory = path.join(directory, part);
    const info = await fs.lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe transcript directory.');
  }
  return readRegular(path.join(directory, 'transcript.jsonl'));
}

export function nativeChat(executable, nativeArgv, route, { call = nativeCall, geminiRoot = localRoot } = {}) {
  const { sidecarId, projectId, workspace, anchor } = route;
  const invoke = args => call(executable, nativeArgv, args);

  async function metadata(conversationId) {
    if (!idPattern.test(conversationId)) throw new Error('Invalid Antigravity conversation ID.');
    const { response, evidence } = await invoke(['get-conversation-metadata', conversationId]);
    const data = response?.conversationMetadata?.metadata;
    const binding = await observedBinding(Buffer.from(JSON.stringify({ response })));
    if (binding.project_id !== projectId || binding.conversation_id !== conversationId ||
        !samePath(binding.workspace_root, workspace)) throw new Error('Conversation ownership differs from this workspace.');
    return {
      check: { command: 'get-conversation-metadata', exitCode: evidence.exit_code,
        stdoutSha256: evidence.stdout_sha256, observed_binding: binding },
      observed_model: /^gemini-[0-9a-z.-]+$/.test(data.modelName ?? '') ? data.modelName : null,
    };
  }

  async function progress(conversationId, request) {
    if (!idPattern.test(conversationId)) throw new Error('Invalid Antigravity conversation ID.');
    try {
      return transcriptSummary(await readTranscript(path.join(geminiRoot, 'antigravity', 'brain'), conversationId), request);
    } catch {
      // A missing, inaccessible or unsafe log cannot prove a current cursor.
      return { state: 'transcript_unavailable' };
    }
  }

  async function observe(conversationId, request) {
    const info = await metadata(conversationId);
    return { conversation_id: conversationId, observed_model: info.observed_model, ...await progress(conversationId, request) };
  }

  async function verifyCreation() {
    await metadata(anchor);
    await verifyRegistration(path.join(geminiRoot, 'config'), { sidecarId, projectId, workspace });
  }

  async function dispatch(request, message) {
    const fresh = request.operation === 'start';
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

  return { metadata, observe, progress, verifyCreation, dispatch };
}
