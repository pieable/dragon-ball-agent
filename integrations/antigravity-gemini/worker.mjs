import { loadWorkerBindings } from './local-bindings.mjs';
export { loadWorkerBindings } from './local-bindings.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { publishIdentity } from './diagnose-binding.mjs';
import { nativeChat } from './native-chat.mjs';
import { idPattern, isLocalAbsolutePath, readRegular, turnStore, within } from './turns.mjs';
import { appProvider } from './app-provider.mjs';
import { createTaskStore, lockRouteWorker, publishWorkerHeartbeat } from './task-store.mjs';
import { runtimeConfig } from './runtime-config.mjs';
import { routeWorkerIdentity, workerConfigDigest } from './runtime-version.mjs';

const legacyTerminal = new Set(['done', 'failed']);
const samePath = (a, b) => path.relative(a, b) === '';
const guardedProviderMethods = new Set(['verifyRegistration', 'metadata', 'progress', 'observe', 'dispatch']);

export function withFreshRuntimeGuard(provider, assertCurrent, assertRegistration) {
  return new Proxy(provider, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (!guardedProviderMethods.has(property) || typeof value !== 'function') return value;
      return async (...args) => {
        await assertCurrent();
        if (property !== 'verifyRegistration') await assertRegistration?.();
        return value.apply(target, args);
      };
    },
  });
}

async function legacyQueue(protocol) {
  const root = path.join(protocol.ROOT, 'runtime', 'jobs');
  if (!await protocol.exists(root)) return { queued: false, busy: false };
  await protocol.safeDirectory(root);
  let queued = false;
  for (const id of await fs.readdir(root)) {
    protocol.assertId(id);
    const dir = path.join(root, id);
    await protocol.safeDirectory(dir);
    if (!await protocol.exists(path.join(dir, 'request.json'))) continue;
    const { state } = await protocol.inspectJob(protocol.ROOT, id);
    if (state === 'queued') queued = true;
    else if (!legacyTerminal.has(state)) return { queued, busy: true };
  }
  return { queued, busy: false };
}

async function serveV3(route, ownerPid) {
  const lifetime = await import('./live2d-sidecar/parent-lifetime.mjs');
  const official = await import('./live2d-sidecar/official-agentapi.mjs');
  const live = () => lifetime.parentIsAlive(ownerPid);
  if (!live()) return;
  const workerHealth = await workerConfigDigest(route);
  const manifestPath = process.argv[3];
  const manifestDigest = createHash('sha256').update(await fs.readFile(manifestPath)).digest('hex');
  async function assertCurrentRuntime() {
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    if (manifest.version !== 1 || !Array.isArray(manifest.bindings)) {
      throw new Error('The registered v1 manifest envelope changed while the worker was running.');
    }
    const candidates = (manifest.routes_v3 ?? []).filter(candidate => candidate?.sidecar_id === route.sidecar_id);
    if (candidates.length !== 1 || candidates[0].route_id !== route.route_id ||
        JSON.stringify(routeWorkerIdentity(candidates[0])) !== JSON.stringify(routeWorkerIdentity(route))) {
      throw new Error('The registered route identity or workspace root set changed while the worker was running.');
    }
    const current = await workerConfigDigest(candidates[0]);
    if (current.worker_config_sha256 !== workerHealth.worker_config_sha256 ||
        current.runtime_sha256 !== workerHealth.runtime_sha256) {
      throw new Error('The worker runtime or route configuration changed; reload this App Sidecar before native work.');
    }
  }
  const unlock = await lockRouteWorker(route);
  let executable, provider, store;
  let stopping = false;
  let failurePublished = false;
  let lastState;
  const stop = () => { stopping = true; };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  try {
    executable = await official.resolveAgentapi();
    const app = appProvider(executable, official.nativeArgv, route);
    provider = withFreshRuntimeGuard(app, assertCurrentRuntime, () => app.verifyRegistration());
    store = createTaskStore(route, provider);
    await provider.verifyRegistration();
    await publishWorkerHeartbeat(route, 'ready', { ...workerHealth, manifest_sha256: manifestDigest,
      app_registration: 'verified', agentapi_source: executable.source });
    while (!stopping && live()) {
      let state = 'idle';
      await assertCurrentRuntime();
      try {
        const result = await store.pump(provider);
        state = result?.state ?? 'idle';
        await publishWorkerHeartbeat(route, 'ready', { ...workerHealth, manifest_sha256: manifestDigest,
          app_registration: 'verified', agentapi_source: executable.source, last_task_state: state });
      } catch (error) {
        state = 'degraded';
        await publishWorkerHeartbeat(route, state, { ...workerHealth, manifest_sha256: manifestDigest,
          app_registration: 'verified', agentapi_source: executable?.source ?? null,
          diagnostic: { code: 'worker_iteration_failed', stage: 'task_pump', message: error.message } });
      }
      if (state !== lastState) { console.log(JSON.stringify({ route_id: route.route_id, state })); lastState = state; }
      await delay(runtimeConfig.workerPollMs);
    }
  } catch (error) {
    try {
      await publishWorkerHeartbeat(route, 'failed', { ...workerHealth,
        manifest_sha256: manifestDigest, agentapi_source: executable?.source ?? null,
        diagnostic: { code: 'worker_start_failed', stage: 'startup', message: error.message } });
      failurePublished = true;
    }
    catch { /* preserve the startup error if heartbeat storage is also unavailable */ }
    throw error;
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    try {
      if (!failurePublished) await publishWorkerHeartbeat(route, stopping ? 'stopped' : 'parent_exited', {
        ...workerHealth, manifest_sha256: manifestDigest,
      });
    } finally { await unlock(); }
  }
}

export async function runWorker(protocol, native, workspace, sendLegacy, {
  live = () => true, verifyLegacy = id => native.metadata(id), onStart = async () => {},
} = {}) {
  const turns = turnStore(protocol, workspace);
  const unlock = await protocol.lockWorker(protocol.ROOT);
  const legacyBoundaryFile = path.join(protocol.ROOT, 'runtime', 'legacy-anchor-boundary.json');
  let legacyBoundary;
  let stopping = false;
  const stop = () => { stopping = true; };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  try {
    await onStart();
    if (await protocol.exists(legacyBoundaryFile)) legacyBoundary = await protocol.readJson(legacyBoundaryFile);
    while (!stopping && live()) {
      const legacy = await legacyQueue(protocol);
      const turn = await turns.pump(native, legacy.busy || legacy.queued, legacyBoundary);
      if (legacy.queued && !legacy.busy && !turn?.anchor_blocked && !stopping && live()) {
        // The established novel protocol predates the per-attempt hook. For
        // that version check before entering its pump (only when work exists).
        if (protocol.pump.length < 3) await verifyLegacy(protocol.CONVERSATION_ID);
        await protocol.pump(protocol.ROOT, async (id, message) => {
          const observed = await native.progress(id);
          legacyBoundary = { conversation_id: id, cursor: observed.cursor ?? null, armed_at: new Date().toISOString() };
          await protocol.publishJson(legacyBoundaryFile, legacyBoundary);
          return sendLegacy(id, message);
        }, verifyLegacy);
      }
      await delay(1000);
    }
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    await unlock();
  }
}

async function main() {
  const [mode, manifestPath, sidecarId] = process.argv.slice(2);
  if (mode !== '--serve' || ![5, 8].includes(process.argv.length) || !isLocalAbsolutePath(manifestPath) ||
      !/^[a-z0-9][a-z0-9_-]*$/i.test(sidecarId ?? '')) throw new Error('Use --serve <absolute bindings.json> <sidecar_id>');
  await loadWorkerBindings(process.argv.slice(5));
  if (!process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR) throw new Error('Run only as an App-managed Sidecar.');
  const config = JSON.parse(await readRegular(manifestPath));
  const v3Routes = config.routes_v3?.filter(row => row.sidecar_id === sidecarId) ?? [];
  if (v3Routes.length) {
    if (v3Routes.length !== 1 || config.version !== 1 || !Array.isArray(config.bindings)) {
      throw new Error('Expected one valid v3 route beside the legacy manifest bindings.');
    }
    const route = v3Routes[0];
    if (route.provider !== 'antigravity-agentapi' || !idPattern.test(route.project_id) ||
        typeof route.route_id !== 'string' || !/^[a-z0-9][a-z0-9_-]*$/i.test(route.route_id) ||
        !isLocalAbsolutePath(route.state_root) || !isLocalAbsolutePath(route.sidecar_root) ||
        !Array.isArray(route.workspace_roots) || !route.workspace_roots.length ||
        route.workspace_roots.some(root => !isLocalAbsolutePath(root.path))) {
      throw new Error('Invalid v3 Sidecar route.');
    }
    const expectedStateRoot = path.resolve(route.workspace_roots[0].path, '.antigravity-gemini-mcp');
    if (!samePath(path.resolve(route.state_root), expectedStateRoot)) throw new Error('Invalid route state_root.');
    const actualSidecarRoot = await fs.realpath(route.sidecar_root);
    if (!samePath(actualSidecarRoot, path.resolve(route.sidecar_root))) throw new Error('Sidecar root resolves through a link.');
    await serveV3(route, process.ppid);
    return;
  }
  const selected = config.version === 1 && Array.isArray(config.bindings) && config.bindings.filter(row => row.sidecar_id === sidecarId);
  if (!selected || selected.length !== 1) throw new Error('Expected exactly one workspace binding for this Sidecar.');
  const entry = selected[0];
  if (!idPattern.test(entry.project_id) || !idPattern.test(entry.conversation_id) ||
      !isLocalAbsolutePath(entry.workspace_root) || !isLocalAbsolutePath(entry.sidecar_root)) {
    throw new Error('Invalid Sidecar binding.');
  }
  const workspace = await fs.realpath(entry.workspace_root);
  const root = await fs.realpath(entry.sidecar_root);
  if (!within(workspace, root)) throw new Error('Sidecar queue must be inside its bound workspace.');
  const local = async name => {
    const file = path.join(root, name);
    if (!(await fs.lstat(file)).isFile()) throw new Error('Expected a regular Sidecar module.');
    return import(pathToFileURL(file));
  };
  const [protocol, official, lifetime] = await Promise.all([
    local('protocol.mjs'), local('official-agentapi.mjs'), local('parent-lifetime.mjs'),
  ]);
  if (protocol.CONVERSATION_ID !== entry.conversation_id || !samePath(protocol.ROOT, root) ||
      official.EXPECTED_PROJECT_ID !== entry.project_id || !samePath(await fs.realpath(official.EXPECTED_WORKSPACE), workspace)) {
    throw new Error('Sidecar modules disagree with the workspace binding.');
  }
  const ownerPid = process.ppid;
  const live = () => lifetime.parentIsAlive(ownerPid);
  if (!live()) return;
  const executable = await official.resolveAgentapi();
  const native = nativeChat(executable, official.nativeArgv, {
    sidecarId, workspace, projectId: entry.project_id, anchor: entry.conversation_id,
  });
  async function verifyLegacy(id) {
    try {
      return (await native.metadata(id)).check;
    } catch (error) {
      await publishIdentity(root, protocol.publishJson, { state: 'failed' });
      throw error;
    }
  }
  await runWorker(protocol, native, workspace,
    (id, message) => official.runAgentapi(executable, ['send-message', id, message]), {
      live, verifyLegacy,
      onStart: async () => {
        const check = await verifyLegacy(entry.conversation_id);
        await publishIdentity(root, protocol.publishJson, { state: 'verified', source: executable.source, check });
      },
    });
}

if (process.argv[1] && samePath(fileURLToPath(import.meta.url), path.resolve(process.argv[1]))) {
  try { await main(); }
  catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
}
