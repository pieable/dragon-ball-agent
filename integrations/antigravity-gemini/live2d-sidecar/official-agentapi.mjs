import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { runNativeCommand } from '../native-command.mjs';

export const REVIEWED_WRAPPER = process.env.ANTIGRAVITY_REVIEWED_WRAPPER ?? '';
export const REVIEWED_NATIVE = process.env.ANTIGRAVITY_REVIEWED_NATIVE ?? '';
export const EXPECTED_PROJECT_ID = process.env.ANTIGRAVITY_EXPECTED_PROJECT_ID ?? '';
export const EXPECTED_WORKSPACE = process.env.ANTIGRAVITY_EXPECTED_WORKSPACE ?? '';
const equalPath = (a, b) => path.win32.normalize(a).toLowerCase() === path.win32.normalize(b).toLowerCase();
export function parseReviewedWrapper(text) {
  // This exact two-line static delegation was read and verified by the parent.
  // No generic batch parser, variable expansion, shell, or executable inference.
  if (!REVIEWED_WRAPPER || !REVIEWED_NATIVE) throw new Error('Explicit reviewed wrapper and native bindings required');
  const match = /^@echo off\r?\n"([^"\r\n]+)" agentapi %\*\r?\n?$/.exec(text);
  if (!match || !equalPath(match[1], REVIEWED_NATIVE)) throw new Error('Unrecognized App agentapi wrapper');
  return { file: REVIEWED_NATIVE, prefixArgs: ['agentapi'] };
}
export async function resolveAgentapi(envPath = process.env.PATH ?? '') {
  for (const directory of envPath.split(path.delimiter)) {
    if (!directory) continue;
    for (const name of process.platform === 'win32' ? ['agentapi.exe', 'agentapi.cmd', 'agentapi.bat', 'agentapi'] : ['agentapi']) {
      const file = path.join(directory, name);
      let stat;
      try { stat = await fs.lstat(file); }
      catch (e) { if (['ENOENT', 'ENOTDIR'].includes(e.code)) continue; throw e; }
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('agentapi must be a regular file');
      if (/\.(cmd|bat)$/i.test(file)) {
        if (!equalPath(file, REVIEWED_WRAPPER)) throw new Error('Unreviewed agentapi shell wrapper');
        const bytes = await fs.readFile(file);
        const executable = parseReviewedWrapper(bytes.toString('utf8'));
        const nativeStat = await fs.lstat(executable.file);
        if (!nativeStat.isFile() || nativeStat.isSymbolicLink()) throw new Error('Reviewed native delegate unavailable');
        return { ...executable, source: 'reviewed-app-wrapper',
          wrapperSha256: createHash('sha256').update(bytes).digest('hex') };
      }
      return { file, prefixArgs: [], source: 'path-native' };
    }
  }
  throw new Error('App-injected agentapi not found');
}
export function nativeArgv(executable, args) {
  if (!Array.isArray(executable.prefixArgs) || !Array.isArray(args) || !args.every(a => typeof a === 'string')) throw new Error('Invalid native CLI arguments');
  return [...executable.prefixArgs, ...args];
}
export function metadataSummary(bytes, expectedConversationId) {
  if (!EXPECTED_PROJECT_ID || !EXPECTED_WORKSPACE || !expectedConversationId) throw new Error('Explicit identity bindings required');
  let json;
  try { json = JSON.parse(bytes.toString('utf8')); } catch { return { jsonParsed: false }; }
  const metadata = json?.response?.conversationMetadata?.metadata;
  const present = Boolean(metadata && typeof metadata === 'object' && !Array.isArray(metadata));
  const compare = (value, expected) => typeof value === 'string' && value.length ? value === expected : null;
  const workspaceValues = [];
  if (present && Array.isArray(metadata.workspaces)) for (const workspace of metadata.workspaces) {
    const uri = workspace?.workspaceFolderAbsoluteUri;
    if (typeof uri !== 'string' || !uri.startsWith('file:')) continue;
    try { workspaceValues.push(equalPath(fileURLToPath(uri), EXPECTED_WORKSPACE)); } catch { /* unsupported URI is unknown */ }
  }
  return { jsonParsed: true, metadataPathPresent: present,
    projectMatches: present ? compare(metadata.projectId, EXPECTED_PROJECT_ID) : null,
    rootConversationMatches: present ? compare(metadata.rootConversationId, expectedConversationId) : null,
    workspaceMatches: workspaceValues.length ? workspaceValues.some(Boolean) : null };
}
export function metadataStructure(bytes) {
  let json;
  try { json = JSON.parse(bytes.toString('utf8')); } catch { return { jsonParsed: false }; }
  const paths = new Map();
  let hiddenKeys = 0;
  function visit(value, prefix) {
    const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    paths.set(prefix, type);
    if (Array.isArray(value)) for (const child of value) visit(child, `${prefix}[]`);
    else if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) {
      // API field names only; map IDs, arbitrary text keys and secret branches
      // are never printed, traversed or converted to values in the summary.
      if (!/^[a-z][a-zA-Z0-9_]{0,63}$/.test(key) || /token|secret|credential|authorization|cookie/i.test(key)) { hiddenKeys++; continue; }
      visit(child, `${prefix}.${key}`);
    }
  }
  visit(json, '$');
  return { jsonParsed: true, hiddenKeys, keyPaths: [...paths].map(([path, type]) => ({ path, type })) };
}
export async function runAgentapi(executable, args, { metadataConversationId, structureOnly = false } = {}) {
  const { evidence, stdout } = await runNativeCommand(executable.file, nativeArgv(executable, args));
  const text = stdout?.toString('utf8') ?? '';
  const tail = text.slice(-64);
  const result = { exitCode: evidence.exit_code, signal: evidence.signal, spawnError: evidence.spawn_error,
    timedOut: evidence.timed_out, stdoutBytes: evidence.stdout_bytes, stdoutSha256: evidence.stdout_sha256,
    stderrBytes: evidence.stderr_bytes, stderrSha256: evidence.stderr_sha256,
    responseTruncated: evidence.response_truncated,
    mentionsSendMessage: /\bsend-message\b/.test(text) || /\bsend-message\b/.test(tail),
    mentionsGetMetadata: /\bget-conversation-metadata\b/.test(text) || /\bget-conversation-metadata\b/.test(tail) };
  if (metadataConversationId) result.metadata = stdout
    ? metadataSummary(stdout, metadataConversationId) : { jsonParsed: false };
  if (structureOnly) result.structure = stdout ? metadataStructure(stdout) : { jsonParsed: false };
  return result;
}
