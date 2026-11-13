import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { turnStore, hash, within } from './turns.mjs';
import { runtimeConfig } from './runtime-config.mjs';

function assertRoute(route) {
  if (!route || route.provider !== 'antigravity-agentapi' || !Array.isArray(route.workspace_roots) ||
      !route.workspace_roots.length || typeof route.state_root !== 'string' || !path.isAbsolute(route.state_root)) {
    throw new Error('Invalid v3 task route.');
  }
  const primary = route.workspace_roots[0].path;
  if (typeof primary !== 'string' || !path.isAbsolute(primary) || !within(primary, route.state_root)) {
    throw new Error('Route state_root must be inside its first registered workspace root.');
  }
}

function routeProtocol(route) {
  const root = path.resolve(route.state_root);
  const owner = path.resolve(route.workspace_roots[0].path);

  async function safeDirectory(directory, create = false) {
    const absolute = path.resolve(directory);
    if (!within(owner, absolute)) throw new Error('Route state escapes the registered workspace root.');
    let current = owner;
    const relative = path.relative(owner, absolute);
    for (const part of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      if (create) {
        try { await fs.mkdir(current); }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
      }
      const info = await fs.lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Route state directory must not traverse links.');
    }
  }

  async function exists(file) {
    try { await fs.lstat(file); return true; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }

  async function readJson(file) {
    const info = await fs.lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Expected a regular task JSON file.');
    return JSON.parse(await fs.readFile(file, 'utf8'));
  }

  async function publishJson(file, value) {
    const temporary = `${file}.${randomUUID()}.tmp`;
    const handle = await fs.open(temporary, 'wx');
    try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync(); }
    finally { await handle.close(); }
    await fs.rename(temporary, file);
  }

  return { ROOT: root, CONVERSATION_ID: null, safeDirectory, exists, readJson, publishJson };
}

export function createTaskStore(route, providerOrOptions, maybeOptions) {
  assertRoute(route);
  const options = maybeOptions ?? providerOrOptions ?? {};
  const { originWorkspaceRoot, inlineArtifactBytes } = options;
  const protocol = routeProtocol(route);
  const store = turnStore(protocol, route.workspace_roots[0].path, {
    schemaVersion: 3,
    workspaceRoots: route.workspace_roots,
    originWorkspaceRoot: originWorkspaceRoot ?? route.workspace_roots[0].path,
    defaultModel: route.default_model ?? null,
    defaultModelSource: route.default_model?.source ?? null,
    inlineArtifactBytes: inlineArtifactBytes ?? runtimeConfig.inlineArtifactBytes,
    boundaryRoot: options.boundaryRoot,
  });
  return { ...store, protocol };
}

const legacyJobId = /^codex-mcp-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

async function readRegularJson(file) {
  const info = await fs.lstat(file);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Expected a regular legacy task file.');
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

/** Inspect a v1 runtime/jobs record without promoting, rewriting or resending it. */
export async function inspectLegacyTask(stateRoot, id, { expectedPrompts, expectedMode } = {}) {
  if (typeof id !== 'string' || !legacyJobId.test(id)) throw new Error('Invalid legacy task ID.');
  const dir = path.join(stateRoot, 'runtime', 'jobs', id);
  try {
    const info = await fs.lstat(dir);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Legacy task directory must not be a link.');
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  let request;
  try { request = await readRegularJson(path.join(dir, 'request.json')); }
  catch (error) {
    if (error.code === 'ENOENT') return { id, state: 'legacy_record_incomplete', legacy_protocol: 1 };
    throw error;
  }
  if (request.id !== id || typeof request.nonce !== 'string' || typeof request.prompt !== 'string') {
    return { id, state: 'legacy_record_invalid', legacy_protocol: 1 };
  }
  const keyMatches = (expectedMode === undefined || request.mode === expectedMode) &&
    (expectedPrompts === undefined || expectedPrompts.includes(request.prompt));
  const base = { id, state: 'queued', legacy_protocol: 1, ...(expectedPrompts !== undefined ? { key_matches: keyMatches } : {}),
    conversation_id: typeof request.conversationId === 'string' ? request.conversationId : null };
  let attempted = false;
  try { await fs.lstat(path.join(dir, 'attempt.json')); attempted = true; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!attempted) return base;
  let receipt;
  try { receipt = await readRegularJson(path.join(dir, 'completion.json')); }
  catch (error) { if (error.code !== 'ENOENT') return { ...base, state: 'completion_invalid' }; }
  if (receipt) {
    if (receipt.version !== 1 || receipt.id !== id || receipt.nonce !== request.nonce) return { ...base, state: 'completion_invalid' };
    if (receipt.status === 'failed' && typeof receipt.error === 'string') return { ...base, state: 'failed', error: receipt.error };
    if (receipt.status === 'done') {
      const candidate = path.join(dir, 'candidate.md');
      try {
        const info = await fs.lstat(candidate);
        if (!info.isFile() || info.isSymbolicLink()) return { ...base, state: 'completion_invalid' };
        const bytes = await fs.readFile(candidate);
        return { ...base, state: 'done', candidate_path: candidate, candidateBytes: bytes.length, candidateSha256: hash(bytes) };
      } catch (error) { if (error.code !== 'ENOENT') throw error; return { ...base, state: 'completion_invalid' }; }
    }
    return { ...base, state: 'completion_invalid' };
  }
  let delivery;
  try { delivery = await readRegularJson(path.join(dir, 'delivery.json')); }
  catch (error) { if (error.code !== 'ENOENT') return { ...base, state: 'delivery_unknown' }; }
  if (!delivery) return { ...base, state: 'delivery_unknown' };
  const uncertain = delivery.timedOut || delivery.timed_out || delivery.spawnError || delivery.spawn_error ||
    (delivery.exitCode !== undefined && delivery.exitCode !== 0) || (delivery.exit_code !== undefined && delivery.exit_code !== 0);
  return { ...base, state: uncertain ? 'delivery_unknown' : 'completion_unknown' };
}

export async function lockRouteWorker(route) {
  assertRoute(route);
  const protocol = routeProtocol(route);
  const runtime = path.join(route.state_root, 'runtime');
  await protocol.safeDirectory(runtime, true);
  const identity = (await fs.realpath(route.state_root)).toLowerCase();
  const digest = createHash('sha256').update(identity).digest('hex');
  if (process.platform === 'win32') {
    const pipe = `\\\\.\\pipe\\codex-antigravity-route-${digest}`;
    const server = net.createServer(socket => socket.destroy());
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen({ path: pipe, exclusive: true }, () => { server.removeListener('error', reject); resolve(); });
    });
    return () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
  const lock = path.join(runtime, 'worker.lock');
  const handle = await fs.open(lock, 'wx');
  await handle.writeFile(JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() }));
  await handle.sync();
  return async () => { await handle.close(); await fs.unlink(lock); };
}

export async function publishWorkerHeartbeat(route, state, extra = {}) {
  assertRoute(route);
  const protocol = routeProtocol(route);
  const directory = path.join(route.state_root, 'runtime');
  await protocol.safeDirectory(directory, true);
  const file = path.join(directory, 'worker-heartbeat.json');
  const value = { version: 1, state, route_id: route.route_id, project_id: route.project_id,
    sidecar_id: route.sidecar_id, pid: process.pid, at: new Date().toISOString(), ...extra };
  await protocol.publishJson(file, value);
  return value;
}
