import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { runtimeConfig } from './runtime-config.mjs';

export class RouteWorkGateError extends Error {
  constructor(code, message, nextAction) {
    super(message);
    this.name = 'RouteWorkGateError';
    this.code = code;
    this.stage = 'route_maintenance';
    this.next_action = nextAction;
  }
}

async function pipeNames(route) {
  if (process.platform !== 'win32') {
    throw new RouteWorkGateError('route_gate_unsupported',
      'Route task acceptance and Sidecar reload coordination requires Windows named-pipe locks.',
      'Run the App Sidecar route on Windows; no file-based lock fallback is enabled.');
  }
  if (!route || typeof route.state_root !== 'string' || !path.isAbsolute(route.state_root)) {
    throw new RouteWorkGateError('route_gate_invalid', 'A route with an absolute stable state_root is required.',
      'Resolve the registered v3 route before accepting or reloading App work.');
  }
  const stableOwner = await fs.realpath(route.state_root);
  const identity = process.platform === 'win32' ? stableOwner.toLowerCase() : stableOwner;
  const digest = createHash('sha256').update(identity).digest('hex');
  return {
    submission: `\\\\.\\pipe\\codex-antigravity-submit-${digest}`,
    reload: `\\\\.\\pipe\\codex-antigravity-reload-${digest}`,
  };
}

async function tryAcquire(pipePath) {
  const server = net.createServer(socket => socket.destroy());
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen({ path: pipePath, exclusive: true }, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
  } catch (error) {
    if (error?.code === 'EADDRINUSE') return null;
    try { server.close(); } catch { /* listen did not establish a handle */ }
    throw error;
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  };
}

async function acquireSubmissionPipe(pipePath, { waitMs, pollMs }) {
  const deadline = Date.now() + waitMs;
  while (true) {
    const release = await tryAcquire(pipePath);
    if (release) return release;
    if (Date.now() >= deadline) {
      throw new RouteWorkGateError('route_submission_busy',
        'Another route task submission is still being staged.',
        'Retry this request with the same request_key; no task has been accepted by this call.');
    }
    await delay(pollMs);
  }
}

function reloadBusy() {
  return new RouteWorkGateError('worker_reload_in_progress',
    'This App route is being reloaded; new task or observation work was not accepted.',
    'Wait for reload_worker to finish, then check binding_status before submitting new work.');
}

export async function acquireRouteSubmissionGate(route, {
  waitMs = runtimeConfig.routeGateWaitMs,
  pollMs = runtimeConfig.statePollMs,
} = {}) {
  const pipes = await pipeNames(route);
  const reloadProbe = await tryAcquire(pipes.reload);
  if (!reloadProbe) throw reloadBusy();
  await reloadProbe();

  const releaseSubmission = await acquireSubmissionPipe(pipes.submission, { waitMs, pollMs });
  try {
    const secondReloadProbe = await tryAcquire(pipes.reload);
    if (!secondReloadProbe) throw reloadBusy();
    await secondReloadProbe();
    return releaseSubmission;
  } catch (error) {
    await releaseSubmission();
    throw error;
  }
}

export async function acquireRouteReloadGate(route, {
  waitMs = runtimeConfig.routeGateWaitMs,
  pollMs = runtimeConfig.statePollMs,
} = {}) {
  const pipes = await pipeNames(route);
  const releaseReload = await tryAcquire(pipes.reload);
  if (!releaseReload) {
    throw new RouteWorkGateError('worker_reload_in_progress',
      'Another reload already owns this App route.',
      'Wait for the existing reload attempt to finish and inspect binding_status.');
  }
  let releaseSubmission;
  try {
    releaseSubmission = await acquireSubmissionPipe(pipes.submission, { waitMs, pollMs });
  } catch (error) {
    await releaseReload();
    throw error;
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    try { await releaseSubmission(); }
    finally { await releaseReload(); }
  };
}
