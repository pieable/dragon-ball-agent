import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { connectPluginTransport, processIsAlive } from './plugin-transport.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const error = (code, message) => Object.assign(new Error(message), { code });
const redact = (text, key) => key ? String(text).split(key).join('[REDACTED_API_KEY]') : String(text);
function insideRepo(value) {
  const target = path.resolve(value), relative = path.relative(root, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw error('OUTSIDE_REPOSITORY', 'Launcher working data must stay inside its repository');
  return target;
}
async function json(file) { return JSON.parse(await fs.readFile(file, 'utf8')); }
async function atomic(file, value) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, JSON.stringify(value, null, 2));
    // Windows can reject replacement while another process briefly reads the
    // destination. Retry that observed sharing race, keeping the same candidate.
    for (let attempt = 0; ; attempt++) {
      try { await fs.rename(temp, file); break; }
      catch (e) { if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(e.code) || attempt >= 39) throw e; await sleep(25); }
    }
  }
  finally { await fs.rm(temp, { force: true }); }
}
async function gateFor(state) {
  const hash = createHash('sha256').update(process.platform === 'win32' ? state.toLowerCase() : state).digest('hex');
  const gate = net.createServer(socket => socket.destroy());
  const target = process.platform === 'win32' ? { path: `\\\\.\\pipe\\luna-launch-${hash}` }
    : process.platform === 'linux' ? { path: `\0luna-launch-${hash}` }
      : { host: '127.0.0.1', port: 49152 + Number.parseInt(hash.slice(0, 8), 16) % 16384 };
  try { await new Promise((resolve, reject) => { gate.once('error', reject); gate.listen(target, resolve); }); }
  catch (e) { if (e.code === 'EADDRINUSE') return null; throw e; }
  return () => new Promise((resolve, reject) => gate.close(e => e ? reject(e) : resolve()));
}

export async function resolveRuntime({ runtime, env = process.env } = {}) {
  let executable = runtime?.executable ?? env.LUNA_DSH_EXECUTABLE;
  if (!executable) {
    const candidates = [
      env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness', 'DeepSeek Harness.exe'),
      env.ProgramFiles && path.join(env.ProgramFiles, 'DeepSeek Harness', 'DeepSeek Harness.exe'),
    ].filter(Boolean);
    for (const candidate of candidates) { try { await fs.access(candidate); executable = candidate; break; } catch {} }
  }
  if (!executable) throw error('RUNTIME_NOT_FOUND', 'Set LUNA_DSH_EXECUTABLE to the installed official DeepSeek Harness executable');
  executable = path.resolve(executable);
  try { await fs.access(executable); } catch { throw error('RUNTIME_NOT_FOUND', `DSH executable does not exist: ${executable}`); }
  const cli = path.resolve(runtime?.cli ?? env.LUNA_DSH_CLI ?? path.join(path.dirname(executable), 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js'));
  const archive = cli.match(/^(.*?\.asar)(?:[\\/]|$)/i)?.[1];
  try { await fs.access(archive ?? cli); } catch { throw error('RUNTIME_CLI_NOT_FOUND', `DSH CLI or archive does not exist: ${cli}`); }
  return { executable, cli };
}

export async function resolveAgentsHome({ agentsHome, env = process.env } = {}) {
  const explicit = agentsHome ?? env.LUNA_CODEX_HOME ?? env.CODEX_HOME;
  const candidate = path.resolve(explicit ?? path.join(os.homedir(), '.codex'));
  try {
    if (!(await fs.stat(candidate)).isDirectory()) throw new Error('Not a directory');
    const available = await Promise.all(['AGENTS.md', 'skills'].map(file => fs.access(path.join(candidate, file)).then(() => true, () => false)));
    if (!available.some(Boolean)) throw new Error('No readable AGENTS.md or skills entry');
    return await fs.realpath(candidate);
  } catch (e) {
    if (explicit) throw error('AGENTS_HOME_UNAVAILABLE', `Explicit Codex instruction directory is unavailable: ${candidate}`);
    return undefined;
  }
}

async function writeOwned(file, expected, equivalent = current => current === expected) {
  try {
    const current = await fs.readFile(file, 'utf8');
    if (!equivalent(current)) throw error('PROFILE_CONFLICT', `Private profile file differs from generated content: ${file}`);
  } catch (e) { if (e.code !== 'ENOENT') throw e; await fs.writeFile(file, expected, { flag: 'wx' }); }
}
async function prepareProfile(home) {
  const profile = path.join(home, 'profiles', 'luna-subagent');
  const modules = path.join(profile, 'node_modules');
  await fs.mkdir(modules, { recursive: true });
  const link = path.join(modules, 'luna-dsh-subagent-mcp');
  try {
    if (await fs.realpath(link) !== await fs.realpath(root)) throw error('PROFILE_CONFLICT', 'Private profile bundle link points elsewhere');
  } catch (e) { if (e.code !== 'ENOENT') throw e; await fs.symlink(root, link, process.platform === 'win32' ? 'junction' : 'dir'); }
  const pkg = { name: 'luna-private-profile', private: true, dependencies: { 'luna-dsh-subagent-mcp': `link:${root.replaceAll('\\', '/')}` }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'luna-dsh-subagent-mcp'] } } };
  await writeOwned(path.join(profile, 'package.json'), JSON.stringify(pkg, null, 2), current => {
    let value; try { value = JSON.parse(current); } catch { return false; }
    return value.private === true && JSON.stringify(value.dsh?.profile?.bundles) === JSON.stringify(pkg.dsh.profile.bundles)
      && JSON.stringify(value.dependencies) === JSON.stringify(pkg.dependencies);
  });
  for (const file of ['cordis.yml', 'cordis.patch.yml']) await writeOwned(path.join(profile, file), '[]', current => current.split(/\r?\n/).map(line=>line.trim()).filter(line=>line&&!line.startsWith('#')).join('') === '[]');
}

/** Discover or start one persistent private DSH plugin host; never starts a model turn. */
export async function ensureHost(options = {}) {
  const env = { ...process.env, ...options.env };
  const state = insideRepo(options.stateDir ?? env.LUNA_BRIDGE_STATE_DIR ?? path.join(root, '.bridge-state'));
  const home = insideRepo(options.homeDir ?? path.join(root, '.runtime-home'));
  await fs.mkdir(state, { recursive: true });
  const client = connectPluginTransport({ stateDir: path.join(state, 'transport') });
  const statusFile = path.join(state, 'launcher-status.json');
  const signal = options.signal;
  const probe = async () => {
    try { return { client, capabilities: await client.call('capabilities', {}, { signal }), stateDir: state, homeDir: home }; }
    catch (e) { if (signal?.aborted) throw error('WAIT_ABORTED', 'Host startup wait was cancelled; any started host continues independently'); return null; }
  };
  let release;
  for (;;) {
    signal?.throwIfAborted();
    const existing = await probe(); if (existing) return { ...existing, reused: true };
    release = await gateFor(await fs.realpath(state));
    if (release) break;
    await sleep(100);
  }
  try {
    const existing = await probe(); if (existing) return { ...existing, reused: true };
    let status;
    try { status = await json(statusFile); } catch (e) { if (e.code !== 'ENOENT') throw error('INVALID_LAUNCH_STATUS', 'Cannot read launcher status'); }
    // A previous supervisor may still be starting, including after its MCP
    // client stopped waiting. Never spawn a second host based on elapsed time.
    if (!status || processIsAlive(status.supervisor_pid) === false) {
      if (!env.LUNA_OPENAI_API_KEY) throw error('MISSING_CREDENTIAL', 'LUNA_OPENAI_API_KEY is unavailable to the MCP process');
      const runtime = await resolveRuntime({ runtime: options.runtime, env });
      const agentsHome = await resolveAgentsHome({ agentsHome: options.agentsHome, env });
      await prepareProfile(home);
      const launchId = randomUUID();
      const descriptor = path.join(state, `launch-${launchId}.json`);
      await fs.writeFile(descriptor, JSON.stringify({ launchId, runtime, state, home, agentsHome, statusFile, cwd: root }));
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--supervise', descriptor], {
        detached: true, windowsHide: true, stdio: 'ignore',
        env: { ...env, DSH_HOME: home, LUNA_BRIDGE_STATE_DIR: state },
      });
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      child.unref();
      status = { launch_id: launchId, supervisor_pid: child.pid, state: 'starting' };
      // Supervisor exclusively owns this status from here; no competing writes.
      while (true) {
        try { const observed = await json(statusFile); if (observed.launch_id === launchId) { status = observed; break; } } catch (e) { if (e.code !== 'ENOENT') throw e; }
        if (processIsAlive(child.pid) === false) throw error('SUPERVISOR_EXITED', 'Host supervisor exited before publishing status');
        signal?.throwIfAborted(); await sleep(50);
      }
    } else if (processIsAlive(status.supervisor_pid) !== true) {
      throw error('HOST_STATE_UNKNOWN', 'Previous supervisor process state cannot be verified; no duplicate host was started');
    }
    for (;;) {
      signal?.throwIfAborted();
      const connected = await probe(); if (connected) return { ...connected, reused: false };
      const current = await json(statusFile);
      if (current.state === 'exited' || current.state === 'failed') throw error('HOST_START_FAILED', current.error ?? `DSH exited with code ${current.exit_code}; diagnostics: ${current.log_file}`);
      if (processIsAlive(current.supervisor_pid) === false) throw error('SUPERVISOR_EXITED', 'Host supervisor exited before the plugin became ready; inspect launcher status before retrying');
      await sleep(100);
    }
  } finally { await release(); }
}

async function supervise(descriptor) {
  const config = await json(insideRepo(descriptor));
  const { runtime, state, home, agentsHome, statusFile, launchId, cwd } = config;
  for (const local of [state, home, statusFile, cwd]) insideRepo(local);
  const logFile = path.join(state, `host-${launchId}.log`), key = process.env.LUNA_OPENAI_API_KEY;
  let writes = Promise.resolve();
  const writeLog = text => {
    const safe = redact(text, key);
    writes = writes.then(() => fs.appendFile(logFile, safe));
  };
  let status = { launch_id: launchId, supervisor_pid: process.pid, state: 'starting', log_file: logFile, agents_home: agentsHome ?? null };
  await atomic(statusFile, status);
  try {
    const childEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: home, LUNA_BRIDGE_STATE_DIR: state };
    // Refer to the user's source instructions; do not copy or alter them.
    if (agentsHome) childEnv.DSH_AGENTS_HOME = agentsHome;
    else delete childEnv.DSH_AGENTS_HOME;
    const child = spawn(runtime.executable, ['--expose-internals', runtime.cli, '--profile', 'luna-subagent'], { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: childEnv });
    const done = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
    done.catch(() => {});
    for (const stream of [child.stdout, child.stderr]) {
      let pending = '';
      stream.setEncoding('utf8');
      stream.on('data', text => {
        pending += text;
        // Keep a possible partial credential across stream chunks; redact
        // complete occurrences before emitting any safe prefix.
        pending = redact(pending, key);
        const keep = key ? key.length - 1 : 0;
        if (pending.length > keep) { writeLog(pending.slice(0, pending.length - keep)); pending = pending.slice(pending.length - keep); }
      });
      stream.on('end', () => { writeLog(pending); pending = ''; });
    }
    status = { ...status, child_pid: child.pid, state: 'running' }; await atomic(statusFile, status);
    const result = await done; await writes;
    let diagnostic = '', diagnosticTruncated = false;
    if (result.code !== 0) {
      try {
        const log = await fs.open(logFile, 'r');
        try {
          const { size } = await log.stat();
          // This bounds only the inline error preview, never the saved log or
          // task output. Long-lived hosts do not accumulate logs in memory.
          const bytes = Buffer.alloc(Math.min(size, 16384));
          await log.read(bytes, 0, bytes.length, Math.max(0, size - bytes.length));
          diagnostic = bytes.toString('utf8'); diagnosticTruncated = size > bytes.length;
        } finally { await log.close(); }
      } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    await atomic(statusFile, { ...status, state: 'exited', exit_code: result.code, signal: result.signal, diagnostics_truncated: diagnosticTruncated, error: diagnostic.trim() || `DSH exited with code ${result.code}` });
  } catch (e) {
    await writes;
    await atomic(statusFile, { ...status, state: 'failed', error: redact(e.message, key) });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === '--supervise') {
  await supervise(process.argv[3]);
}
