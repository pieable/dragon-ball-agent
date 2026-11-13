import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { acquireRouteReloadGate, acquireRouteSubmissionGate } from './route-work-gate.mjs';

const prefix = 'antigravity-route-gate-';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(async () => {
    const real = await fs.realpath(root);
    assert.equal(path.dirname(real), await fs.realpath(os.tmpdir()));
    assert.ok(path.basename(real).startsWith(prefix));
    await fs.rm(real, { recursive: true });
  });
  return { state_root: await fs.realpath(root), workspace_roots: [{ path: root }, { path: path.join(root, 'second') }] };
}

test('reload and submission leases share one stable route owner across workspace-root reordering', async t => {
  const route = await fixture(t);
  const reordered = { ...route, workspace_roots: [...route.workspace_roots].reverse() };
  const releaseReload = await acquireRouteReloadGate(route, { waitMs: 100, pollMs: 5 });
  try {
    await assert.rejects(acquireRouteSubmissionGate(reordered, { waitMs: 20, pollMs: 5 }),
      error => error.code === 'worker_reload_in_progress');
  } finally { await releaseReload(); }
  const releaseSubmission = await acquireRouteSubmissionGate(reordered, { waitMs: 100, pollMs: 5 });
  await releaseSubmission();
});

test('reload waits for an in-flight task acceptance lease before inspecting queues', async t => {
  const route = await fixture(t);
  const releaseSubmission = await acquireRouteSubmissionGate(route, { waitMs: 100, pollMs: 5 });
  let reloadAcquired = false;
  const reloadPromise = acquireRouteReloadGate(route, { waitMs: 500, pollMs: 5 })
    .then(release => { reloadAcquired = true; return release; });
  try {
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(reloadAcquired, false, 'reload must not complete its queue-check lease ahead of an in-flight submission');
  } finally { await releaseSubmission(); }
  const releaseReload = await reloadPromise;
  assert.equal(reloadAcquired, true);
  await releaseReload();
});
