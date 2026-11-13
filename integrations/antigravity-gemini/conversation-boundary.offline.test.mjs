import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { claimConversationBoundary } from './conversation-boundary.mjs';

const id = '11111111-1111-1111-1111-111111111111';
const cursor = 'a'.repeat(64);
async function fixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'conversation-boundary-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'boundaries');
  const options = n => ({ root, requestId: `request-${n}`, stateRoot: path.join(base, `route-${n}`) });
  return { base, root, options };
}

test('one durable winner across routes and concurrent claims; retries do not resend', async t => {
  const f = await fixture(t);
  const results = await Promise.all(Array.from({ length: 12 }, (_, n) => claimConversationBoundary(id, cursor, f.options(n))));
  assert.equal(results.filter(Boolean).length, 1);
  const winner = results.indexOf(true);
  const record = JSON.parse(await fs.readFile(path.join(f.root, id, cursor + '.json'), 'utf8'));
  assert.equal(record.request_id, `request-${winner}`);
  assert.equal(record.state_root, f.options(winner).stateRoot);
  assert.equal(await claimConversationBoundary(id, cursor, f.options(winner)), false);
  assert.equal(await claimConversationBoundary(id, 'b'.repeat(64), f.options(0)), true);
});

test('invalid paths and preexisting partial claim cannot cause a resend', async t => {
  const f = await fixture(t);
  await assert.rejects(claimConversationBoundary('../escape', cursor, f.options(0)), /Invalid/);
  await assert.rejects(claimConversationBoundary(id, cursor, { ...f.options(0), root: 'relative' }), /absolute/);
  await fs.mkdir(path.join(f.root, id), { recursive: true });
  await fs.writeFile(path.join(f.root, id, cursor + '.json'), '');
  assert.equal(await claimConversationBoundary(id, cursor, f.options(0)), false);
});

test('rejects redirected directory before creating any claim', async t => {
  const f = await fixture(t);
  const target = path.join(f.base, 'target');
  await fs.mkdir(target);
  await fs.symlink(target, f.root, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(claimConversationBoundary(id, cursor, f.options(0)), /Unsafe/);
  assert.deepEqual(await fs.readdir(target), []);
});
