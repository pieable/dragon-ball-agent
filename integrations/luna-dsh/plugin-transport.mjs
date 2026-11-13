import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

const endpointName = 'endpoint.json';
const lockName = 'host.lock';
export class PluginTransportError extends Error {
  constructor(code, message, options) { super(message, options); this.name = 'PluginTransportError'; this.code = code; }
}
const transportError = (code, message) => new PluginTransportError(code, message);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'ESRCH' ? false : undefined; }
}

// An OS-owned gate releases even if its process crashes. Unlike a second lock
// file, it cannot itself leave a stale recovery lock. All starts share this gate.
async function acquireStartupGate(stateDir) {
  const digest = createHash('sha256').update(process.platform === 'win32' ? stateDir.toLowerCase() : stateDir).digest('hex');
  const gate = net.createServer(socket => socket.destroy());
  const address = process.platform === 'win32'
    ? { path: `\\\\.\\pipe\\dsh-luna-startup-${digest}` }
    : process.platform === 'linux'
      ? { path: `\0dsh-luna-startup-${digest}` }
      : { host: '127.0.0.1', port: 49152 + Number.parseInt(digest.slice(0, 8), 16) % 16384 };
  await new Promise((resolve, reject) => {
    gate.once('error', error => reject(error.code === 'EADDRINUSE'
      ? transportError('HOST_STARTING', 'Another startup owns the plugin recovery gate; retry discovery after it finishes') : error));
    gate.listen(address, resolve);
  });
  return () => new Promise((resolve, reject) => gate.close(error => error ? reject(error) : resolve()));
}

async function recoverDeadOwner(stateDir, isProcessAlive) {
  const lockFile = path.join(stateDir, lockName);
  let owner;
  try { owner = JSON.parse(await fs.readFile(lockFile, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return;
    throw transportError('HOST_LOCKED', 'Plugin ownership cannot be verified; existing lock is preserved');
  }
  if (!object(owner) || typeof owner.instance_id !== 'string' || !owner.instance_id || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) {
    throw transportError('HOST_LOCKED', 'Plugin ownership record is invalid; existing lock is preserved');
  }
  let alive;
  try { alive = await isProcessAlive(owner.pid); } catch { alive = undefined; }
  if (alive !== false) throw transportError('HOST_LOCKED', 'Plugin owner is alive or its process state cannot be verified');
  await removeOwned(path.join(stateDir, endpointName), owner.instance_id);
  await removeOwned(lockFile, owner.instance_id);
}
function authenticated(header, token) {
  if (typeof header !== 'string') return false;
  const supplied = Buffer.from(header), expected = Buffer.from(`Bearer ${token}`);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
function reply(res, status, value) {
  if (res.destroyed) return;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}
async function removeOwned(file, instanceId) {
  let value;
  try { value = JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) {
    // Unrecognizable pre-existing discovery is not ours to remove.
    if (error.code === 'ENOENT' || error.code === 'EISDIR' || error instanceof SyntaxError) return;
    throw error;
  }
  if (value.instance_id === instanceId) await fs.rm(file);
}

/** Mount in the DSH plugin process. Business dispatch owns agent/session state. */
// Probe injection lets fault tests establish dead/unknown PID cases without
// terminating processes. Production callers normally use processIsAlive.
export async function startPluginTransport({ stateDir, dispatch, onClose = async () => {}, isProcessAlive = processIsAlive }) {
  stateDir = path.resolve(stateDir);
  await fs.mkdir(stateDir, { recursive: true });
  stateDir = await fs.realpath(stateDir);
  const releaseGate = await acquireStartupGate(stateDir);
  try {
    await recoverDeadOwner(stateDir, isProcessAlive);
    return await startLockedTransport({ stateDir, dispatch, onClose });
  } finally { await releaseGate(); }
}

async function startLockedTransport({ stateDir, dispatch, onClose }) {
  if (typeof dispatch !== 'function') throw new TypeError('dispatch must be a function');
  stateDir = path.resolve(stateDir);
  await fs.mkdir(stateDir, { recursive: true });
  const instanceId = randomUUID(), token = randomBytes(32).toString('hex');
  const endpointFile = path.join(stateDir, endpointName), lockFile = path.join(stateDir, lockName);
  let lock;
  try { lock = await fs.open(lockFile, 'wx', 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') throw transportError('HOST_LOCKED', 'A plugin host owns this state directory. Connect to it, or inspect its lifecycle before recovery.');
    throw error;
  }
  try {
    await lock.writeFile(JSON.stringify({ instance_id: instanceId, pid: process.pid }));
  } catch (error) {
    await lock.close();
    await fs.rm(lockFile, { force: true });
    throw error;
  }
  await lock.close();
  let closing = false, closePromise;
  const server = http.createServer(async (req, res) => {
    if (!authenticated(req.headers.authorization, token)) { reply(res, 401, { ok: false, error: { code: 'UNAUTHORIZED', message: 'Plugin authentication required' } }); return; }
    if (closing) { reply(res, 503, { ok: false, error: { code: 'HOST_CLOSING', message: 'Plugin host is closing' } }); return; }
    if (req.method !== 'POST' || req.url !== '/rpc') { reply(res, 404, { ok: false, error: { code: 'INVALID_ENDPOINT', message: 'Use POST /rpc' } }); return; }
    if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) { reply(res, 415, { ok: false, error: { code: 'INVALID_CONTENT_TYPE', message: 'Expected application/json' } }); return; }
    let input;
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!object(input) || typeof input.operation !== 'string' || input.operation.trim() === '' || !object(input.args)) throw new Error('Expected { operation: non-empty string, args: object }');
    } catch (error) {
      reply(res, 400, { ok: false, error: { code: 'INVALID_REQUEST', message: 'Expected valid JSON with operation and args' } }); return;
    }
    try {
      const result = await dispatch(input.operation, input.args);
      if (closing) res.shouldKeepAlive = false;
      reply(res, 200, { ok: true, result: result ?? null });
    } catch (error) {
      if (closing) res.shouldKeepAlive = false;
      const redact = value => String(value).split(token).join('[REDACTED_TRANSPORT_TOKEN]');
      reply(res, 200, { ok: false, error: { code: redact(error?.code ?? 'DISPATCH_ERROR'), message: redact(error?.message ?? error) } });
    }
  });
  // Business requests can legitimately wait; no transport-level task deadline.
  server.requestTimeout = 0;
  const closeServer = () => new Promise((resolve, reject) => server.close(error => error && error.code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve()));
  const removeDiscovery = async () => {
    const outcomes = await Promise.allSettled([removeOwned(endpointFile, instanceId), removeOwned(lockFile, instanceId)]);
    const errors = outcomes.filter(value => value.status === 'rejected').map(value => value.reason);
    if (errors.length) throw new AggregateError(errors, 'Could not clean plugin discovery files');
  };
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const endpoint = { version: 1, instance_id: instanceId, pid: process.pid, url: `http://127.0.0.1:${server.address().port}/rpc`, token };
    const temp = path.join(stateDir, `endpoint.${instanceId}.tmp`);
    try {
      await fs.writeFile(temp, JSON.stringify(endpoint), { mode: 0o600 });
      await fs.rename(temp, endpointFile);
    } finally { await fs.rm(temp, { force: true }); }
    return {
      // Credentials deliberately stay out of the returned public descriptor.
      address: { url: endpoint.url, instance_id: instanceId, pid: process.pid },
      close() {
        if (closePromise) return closePromise;
        closing = true;
        closePromise = (async () => {
          // Stop accepting connections before asking the owner to drain/cancel
          // its work. Running the hook first avoids deadlocking long dispatches.
          const stopped = closeServer();
          try { await onClose(); await stopped; }
          finally { server.closeAllConnections(); await stopped; await removeDiscovery(); }
        })();
        return closePromise;
      },
    };
  } catch (error) {
    await closeServer();
    await removeDiscovery();
    throw error;
  }
}

async function readEndpoint(stateDir) {
  let endpoint;
  try { endpoint = JSON.parse(await fs.readFile(path.join(path.resolve(stateDir), endpointName), 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') throw transportError('HOST_NOT_STARTED', 'DSH plugin host has not published an endpoint');
    throw transportError('INVALID_ENDPOINT_FILE', 'Cannot read the DSH plugin endpoint');
  }
  let url;
  try { url = new URL(endpoint.url); } catch { throw transportError('INVALID_ENDPOINT_FILE', 'Invalid DSH plugin endpoint URL'); }
  if (endpoint.version !== 1 || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/rpc' || url.search || url.hash || url.username || url.password || !/^[a-f0-9]{64}$/.test(endpoint.token)) {
    throw transportError('INVALID_ENDPOINT_FILE', 'DSH plugin endpoint must be authenticated loopback RPC');
  }
  return endpoint;
}

/** Each call rereads discovery, so a long-lived MCP client can follow host restart. */
export function connectPluginTransport({ stateDir }) {
  return {
    async call(operation, args = {}, { signal } = {}) {
      const endpoint = await readEndpoint(stateDir);
      const payload = JSON.stringify({ operation, args });
      return new Promise((resolve, reject) => {
        const req = http.request(endpoint.url, { method: 'POST', signal, headers: { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } }, res => {
          const chunks = [];
          res.on('data', part => chunks.push(part));
          res.on('error', error => reject(transportError('HOST_CONNECTION_ERROR', error.message)));
          res.on('end', () => {
            let response;
            try { response = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
            catch { reject(transportError('INVALID_RESPONSE', 'Plugin host did not return JSON')); return; }
            if (response.ok === true && res.statusCode === 200) resolve(response.result);
            else reject(transportError(response.error?.code ?? 'HOST_ERROR', response.error?.message ?? `Plugin HTTP status ${res.statusCode}`));
          });
        });
        req.on('error', error => reject(transportError(error.name === 'AbortError' ? 'REQUEST_ABORTED' : 'HOST_CONNECTION_ERROR', error.message)));
        req.end(payload);
      });
    },
  };
}
