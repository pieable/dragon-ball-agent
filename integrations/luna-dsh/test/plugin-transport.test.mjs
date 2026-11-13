import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startPluginTransport, connectPluginTransport, PluginTransportError, processIsAlive } from '../plugin-transport.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
async function fixture(t, dispatch, onClose) {
  const base = path.join(root, '.tests-tmp');
  await fs.mkdir(base, { recursive: true });
  const dir = await fs.mkdtemp(path.join(base, 'transport-'));
  const host = await startPluginTransport({ stateDir: dir, dispatch, onClose });
  t.after(async () => { await host.close().catch(() => {}); await fs.rm(dir, { recursive: true, force: true }); });
  return { dir, host, client: connectPluginTransport({ stateDir: dir }) };
}
async function raw(url, { method = 'POST', token, body = '{}', contentType = 'application/json' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': contentType, 'content-length': Buffer.byteLength(body) } }, res => {
      let body = ''; res.on('data', part => body += part); res.on('end', () => resolve({ status: res.statusCode, value: JSON.parse(body) }));
    }); req.on('error', reject); req.end(body);
  });
}

test('publishes authenticated loopback only after listen; rejects unauthenticated input', async t => {
  let called = 0;
  const { dir, host, client } = await fixture(t, async (operation, args) => { called++; return { operation, args }; });
  const endpoint = JSON.parse(await fs.readFile(path.join(dir, 'endpoint.json'), 'utf8'));
  assert.equal(new URL(endpoint.url).hostname, '127.0.0.1');
  assert.equal('token' in host.address, false);
  assert.equal((await raw(endpoint.url)).status, 401);
  assert.equal((await raw(endpoint.url, { token: 'invalid' })).status, 401);
  assert.equal(called, 0);
  assert.deepEqual(await client.call('echo', { n: 1 }), { operation: 'echo', args: { n: 1 } });
  assert.equal(called, 1);
});

test('rejects method, content type and malformed body before dispatch', async t => {
  const { dir } = await fixture(t, () => { throw new Error('must not dispatch'); });
  const e = JSON.parse(await fs.readFile(path.join(dir, 'endpoint.json'), 'utf8'));
  assert.equal((await raw(e.url, { token: e.token, method: 'GET' })).status, 404);
  assert.equal((await raw(e.url, { token: e.token, contentType: 'text/plain' })).status, 415);
  assert.equal((await raw(e.url, { token: e.token, body: '{' })).status, 400);
  assert.equal((await raw(e.url, { token: e.token, body: '{"operation":"x","args":[]}' })).status, 400);
});

test('preserves dispatch errors without exposing transport token', async t => {
  let secret;
  const { dir, client } = await fixture(t, () => { throw new PluginTransportError('UNKNOWN_OPERATION', `unknown ${secret}`); });
  secret = JSON.parse(await fs.readFile(path.join(dir, 'endpoint.json'), 'utf8')).token;
  await assert.rejects(client.call('missing'), error => error.code === 'UNKNOWN_OPERATION' && !error.message.includes(secret) && error.message.includes('[REDACTED_TRANSPORT_TOKEN]'));
});

test('multiple clients dispatch concurrently without serial blocking', async t => {
  let release, started = 0;
  const barrier = new Promise(resolve => release = resolve);
  const { dir, client } = await fixture(t, async (_, { value }) => { started++; if (started === 2) release(); await barrier; return value; });
  const other = connectPluginTransport({ stateDir: dir });
  assert.deepEqual(await Promise.all([client.call('work', { value: 1 }), other.call('work', { value: 2 })]), [1, 2]);
});

test('exclusive host lock, async close hook and client restart discovery', async t => {
  let closes = 0;
  const { dir, host, client } = await fixture(t, () => 'first', async () => { closes++; });
  await assert.rejects(startPluginTransport({ stateDir: dir, dispatch() {} }), error => error.code === 'HOST_LOCKED');
  const one = host.close(); const two = host.close(); assert.equal(one, two); await one;
  assert.equal(closes, 1);
  await assert.rejects(client.call('x'), error => error.code === 'HOST_NOT_STARTED');
  const replacement = await startPluginTransport({ stateDir: dir, dispatch: () => 'second' });
  try { assert.equal(await client.call('x'), 'second'); } finally { await replacement.close(); }
});

test('close calls owner hook before draining an active dispatch', async t => {
  let started, release;
  const began = new Promise(r => started = r), done = new Promise(r => release = r);
  const { host, client } = await fixture(t, async () => { started(); await done; return 'drained'; }, async () => release());
  const work = client.call('wait'); await began;
  await host.close(); assert.equal(await work, 'drained');
});

test('close does not remove another owner discovery files', async t => {
  const { dir, host } = await fixture(t, () => null);
  const replacement = { instance_id: 'different-owner' };
  await fs.writeFile(path.join(dir, 'endpoint.json'), JSON.stringify(replacement));
  await fs.writeFile(path.join(dir, 'host.lock'), JSON.stringify(replacement));
  await host.close();
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, 'endpoint.json'), 'utf8')), replacement);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, 'host.lock'), 'utf8')), replacement);
});

test('failed close hook still removes owned discovery and releases listening socket', async t => {
  const { dir, host } = await fixture(t, () => null, () => { throw new Error('close hook failed'); });
  await assert.rejects(host.close(), /close hook failed/);
  await assert.rejects(fs.access(path.join(dir, 'endpoint.json')));
  await assert.rejects(fs.access(path.join(dir, 'host.lock')));
});

test('client rejects discovery redirect to non-loopback without sending credentials', async t => {
  const { dir, client } = await fixture(t, () => null);
  const file = path.join(dir, 'endpoint.json'), endpoint = JSON.parse(await fs.readFile(file, 'utf8'));
  await fs.writeFile(file, JSON.stringify({ ...endpoint, url: 'http://example.com/rpc' }));
  await assert.rejects(client.call('x'), error => error.code === 'INVALID_ENDPOINT_FILE');
});

test('failed endpoint publication releases owned lock and leaves foreign content intact', async t => {
  const base = path.join(root, '.tests-tmp');
  await fs.mkdir(base, { recursive: true });
  const dir = await fs.mkdtemp(path.join(base, 'publication-failure-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dir, 'endpoint.json'));
  await assert.rejects(startPluginTransport({ stateDir: dir, dispatch() {} }));
  await assert.rejects(fs.access(path.join(dir, 'host.lock')));
  assert.equal((await fs.stat(path.join(dir, 'endpoint.json'))).isDirectory(), true);
  assert.deepEqual(await fs.readdir(dir), ['endpoint.json']);
});

async function staleFixture(t) {
  const base = path.join(root, '.tests-tmp');
  await fs.mkdir(base, { recursive: true });
  const dir = await fs.mkdtemp(path.join(base, 'recovery-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const old = { instance_id: 'old-crashed-owner', pid: 987654321 };
  await fs.writeFile(path.join(dir, 'host.lock'), JSON.stringify(old));
  await fs.writeFile(path.join(dir, 'endpoint.json'), JSON.stringify({ ...old, version: 1, url: 'http://127.0.0.1:9/rpc', token: 'a'.repeat(64) }));
  return { dir, old };
}

test('dead owner recovery publishes a new usable host without killing a process', async t => {
  const { dir, old } = await staleFixture(t);
  const probes = [];
  const host = await startPluginTransport({ stateDir: dir, dispatch: () => 'recovered', isProcessAlive: pid => { probes.push(pid); return false; } });
  try {
    assert.deepEqual(probes, [old.pid]);
    assert.notEqual(host.address.instance_id, old.instance_id);
    assert.equal(await connectPluginTransport({ stateDir: dir }).call('ping'), 'recovered');
  } finally { await host.close(); }
});

test('competing recoverers cannot delete the winner lock or endpoint', async t => {
  const { dir } = await staleFixture(t);
  let entered, release;
  const began = new Promise(r => entered = r), wait = new Promise(r => release = r);
  const first = startPluginTransport({ stateDir: dir, dispatch: () => 'winner', isProcessAlive: async () => { entered(); await wait; return false; } });
  await began;
  await assert.rejects(startPluginTransport({ stateDir: dir, dispatch: () => 'loser', isProcessAlive: () => false }), error => error.code === 'HOST_STARTING');
  release();
  const host = await first;
  try {
    await assert.rejects(startPluginTransport({ stateDir: dir, dispatch() {}, isProcessAlive: () => true }), error => error.code === 'HOST_LOCKED');
    assert.equal(JSON.parse(await fs.readFile(path.join(dir, 'host.lock'), 'utf8')).instance_id, host.address.instance_id);
    assert.equal(await connectPluginTransport({ stateDir: dir }).call('ping'), 'winner');
  } finally { await host.close(); }
});

test('alive and unverifiable owners are preserved, never assumed dead by elapsed time', async t => {
  const { dir } = await staleFixture(t);
  const before = await fs.readFile(path.join(dir, 'host.lock'), 'utf8');
  for (const probe of [() => true, () => undefined, () => { throw new Error('denied'); }]) {
    await assert.rejects(startPluginTransport({ stateDir: dir, dispatch() {}, isProcessAlive: probe }), error => error.code === 'HOST_LOCKED');
    assert.equal(await fs.readFile(path.join(dir, 'host.lock'), 'utf8'), before);
  }
});

test('real PID probe identifies this process without sending a termination signal', () => {
  assert.equal(processIsAlive(process.pid), true);
  assert.equal(processIsAlive(-1), undefined);
});

async function runChild(source) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], { cwd: root, windowsHide: true, stdio: 'ignore' });
  return new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
}

test('real child host abrupt exit is recovered from its persisted discovery', async t => {
  const base = path.join(root, '.tests-tmp');
  await fs.mkdir(base, { recursive: true });
  const dir = await fs.mkdtemp(path.join(base, 'real-crash-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const module = pathToFileURL(path.join(root, 'plugin-transport.mjs')).href;
  assert.equal(await runChild(`import { startPluginTransport } from ${JSON.stringify(module)}; await startPluginTransport({stateDir:${JSON.stringify(dir)},dispatch:()=>null}); process.exit(23);`), 23);
  const dead = JSON.parse(await fs.readFile(path.join(dir, 'host.lock'), 'utf8'));
  assert.equal(processIsAlive(dead.pid), false);
  const host = await startPluginTransport({ stateDir: dir, dispatch: () => 'alive' });
  try { assert.equal(await connectPluginTransport({ stateDir: dir }).call('ping'), 'alive'); }
  finally { await host.close(); }
});

test('OS recovery gate itself releases on abrupt owner exit', async t => {
  const { dir } = await staleFixture(t);
  const module = pathToFileURL(path.join(root, 'plugin-transport.mjs')).href;
  assert.equal(await runChild(`import { startPluginTransport } from ${JSON.stringify(module)}; await startPluginTransport({stateDir:${JSON.stringify(dir)},dispatch:()=>null,isProcessAlive:()=>process.exit(24)});`), 24);
  const host = await startPluginTransport({ stateDir: dir, dispatch: () => 'recovered gate', isProcessAlive: () => false });
  try { assert.equal(await connectPluginTransport({ stateDir: dir }).call('ping'), 'recovered gate'); }
  finally { await host.close(); }
});
