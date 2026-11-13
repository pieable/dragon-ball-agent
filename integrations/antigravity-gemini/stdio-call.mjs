import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const [manifestArg, cwdArg, toolName, argsFileArg] = process.argv.slice(2);
if (!manifestArg || !cwdArg || !toolName || !argsFileArg) {
  console.error('Usage: node stdio-call.mjs <manifest.json> <workspace> <tool-name> <arguments.json|->');
  process.exit(2);
}

const manifest = path.resolve(manifestArg);
const cwd = path.resolve(cwdArg);
const argsFile = path.resolve(argsFileArg);
const argsSource = argsFileArg === '-'
  ? await new Promise((resolve, reject) => {
      const chunks = [];
      process.stdin.on('data', chunk => chunks.push(chunk));
      process.stdin.once('error', reject);
      process.stdin.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    })
  : await fs.readFile(argsFile, 'utf8');
const args = JSON.parse(argsSource.replace(/^\uFEFF/, ''));
if (args === null || typeof args !== 'object' || Array.isArray(args)) {
  throw new TypeError('arguments.json must contain a JSON object.');
}

const server = fileURLToPath(new URL('./server.mjs', import.meta.url));
const child = spawn(process.execPath, [server, manifest], {
  cwd,
  windowsHide: true,
  stdio: ['pipe', 'pipe', 'pipe'],
});
const stdout = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
const stderr = readline.createInterface({ input: child.stderr, crlfDelay: Infinity });
let stderrText = '';
stderr.on('line', line => { stderrText += `${line}\n`; });

const pending = new Map();
let nextId = 1;
stdout.on('line', line => {
  let response;
  try { response = JSON.parse(line); }
  catch (error) {
    for (const waiter of pending.values()) waiter.reject(new Error(`Invalid MCP stdio JSON: ${line}`, { cause: error }));
    pending.clear();
    return;
  }
  if (!Number.isInteger(response.id) || !pending.has(response.id)) return;
  const waiter = pending.get(response.id);
  pending.delete(response.id);
  if (response.error) waiter.reject(new Error(`MCP ${response.error.code}: ${response.error.message}`));
  else waiter.resolve(response.result);
});
child.once('error', error => {
  for (const waiter of pending.values()) waiter.reject(error);
  pending.clear();
});
child.once('close', code => {
  const detail = stderrText.trim();
  for (const waiter of pending.values()) waiter.reject(new Error(`MCP server exited with code ${code}${detail ? `: ${detail}` : ''}`));
  pending.clear();
});

function request(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`MCP ${method} timed out.`));
    }, 90_000);
    timer.unref();
    pending.set(id, {
      resolve(value) { clearTimeout(timer); resolve(value); },
      reject(error) { clearTimeout(timer); reject(error); },
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`, error => {
      if (!error) return;
      const waiter = pending.get(id);
      if (!waiter) return;
      pending.delete(id);
      waiter.reject(error);
    });
  });
}

async function notify(method, params = {}) {
  await new Promise((resolve, reject) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`, error => error ? reject(error) : resolve());
  });
}

try {
  const initialized = await request('initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'antigravity-gemini-stdio-call', version: '1.0.0' },
  });
  await notify('notifications/initialized');
  const listed = await request('tools/list');
  if (!listed.tools?.some(tool => tool.name === toolName)) {
    throw new Error(`Tool ${toolName} is not available in this fresh server process.`);
  }
  const result = await request('tools/call', { name: toolName, arguments: args });
  console.log(JSON.stringify({ protocol_version: initialized.protocolVersion, tool_name: toolName, result }));
  if (result.isError) process.exitCode = 1;
} finally {
  child.stdin.end();
}
