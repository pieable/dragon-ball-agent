import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const fail = (code, message) => Object.assign(new Error(message), { code });
const splitZ = text => text.split('\0').filter(Boolean);

async function command(executable, args, { cwd, input = '' } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, windowsHide: true, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [], err = [];
    child.stdout.on('data', b => out.push(b)); child.stderr.on('data', b => err.push(b));
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(Buffer.concat(out).toString('utf8')) : reject(Object.assign(fail('COMMAND_FAILED', `${executable} exited ${code}: ${Buffer.concat(err).toString('utf8').trim()}`), { exitCode: code })));
    child.stdin.on('error', () => {}); child.stdin.end(input);
  });
}
const git = (cwd, ...args) => command('git', ['--no-optional-locks', ...args], { cwd });

export function validateRelativePath(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0') || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) throw fail('UNSAFE_PATH', `Not a portable relative file path: ${JSON.stringify(value)}`);
  const parts = value.split('/');
  for (const part of parts) {
    if (!part || part === '.' || part === '..' || /[<>:"|?*\x00-\x1f]/.test(part) || /[ .]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) || part.toLowerCase() === '.git') throw fail('UNSAFE_PATH', `Unsafe Windows file component in ${JSON.stringify(value)}`);
  }
  return value;
}

export function sensitivePath(value) {
  const parts = value.toLowerCase().split('/'), name = parts.at(-1);
  if (parts.some(p => ['.ssh', '.aws', '.azure', '.gnupg'].includes(p))) return 'credential directory';
  if (/^\.env(?:\.|$)/.test(name) && !/^\.env\.(?:example|sample|template)(?:\.|$)/.test(name)) return 'environment credentials candidate';
  if (/\.(?:pem|p12|pfx|key)$/.test(name) || /^id_(?:rsa|dsa|ecdsa|ed25519)(?:$|\.)/.test(name)) return 'private key candidate';
  if (['.npmrc', '.pypirc', '.netrc', '_netrc', 'credentials.json', 'credentials', 'service-account.json'].includes(name)) return 'credential configuration candidate';
  return null;
}

async function windowsReparse(paths) {
  if (process.platform !== 'win32' || !paths.length) return [];
  const script = "$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.UTF8Encoding]::new();$p=ConvertFrom-Json -InputObject ([Console]::In.ReadToEnd());$r=@();foreach($x in $p){$i=Get-Item -LiteralPath $x -Force;if($i.Attributes -band [IO.FileAttributes]::ReparsePoint){$r+=$x}};ConvertTo-Json -InputObject $r -Compress";
  return JSON.parse(await command('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { input: JSON.stringify(paths) }));
}

async function inspectChain(target, windows = true) {
  const resolved = path.resolve(target), parsed = path.parse(resolved); let current = parsed.root;
  const chain = [current];
  for (const segment of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) { current = path.join(current, segment); chain.push(current); }
  const existing = [];
  for (const item of chain) {
    let stat;
    try { stat = await fs.lstat(item); } catch (e) { if (e.code === 'ENOENT') break; throw e; }
    if (stat.isSymbolicLink()) throw fail('UNSAFE_OBJECT', `Symbolic link or junction: ${item}`);
    if (!samePath(await fs.realpath(item), item)) throw fail('UNSAFE_OBJECT', `Redirected path: ${item}`);
    existing.push(item);
    if (item !== resolved && !stat.isDirectory()) throw fail('UNSAFE_OBJECT', `Non-directory ancestor: ${item}`);
  }
  // Batch collectors avoid starting PowerShell once per source file.
  if (windows instanceof Set) for (const item of existing) windows.add(item);
  else if (windows) { const reparse = await windowsReparse(existing); if (reparse.length) throw fail('UNSAFE_OBJECT', `Reparse point: ${reparse.join(', ')}`); }

}

async function rootFor(source) {
  const root = path.resolve(source); await inspectChain(root);
  if (!(await fs.lstat(root)).isDirectory()) throw fail('UNSAFE_OBJECT', 'Source must be a directory');
  const top = await fs.realpath((await git(root, 'rev-parse', '--show-toplevel')).trim());
  if (!samePath(root, top)) throw fail('NOT_REPOSITORY_ROOT', 'Source must be the Git working-tree root');
  return root;
}

async function fileState(root, relative, bytes = false, windows = true) {
  validateRelativePath(relative); const target = path.join(root, ...relative.split('/')); await inspectChain(target, windows);
  let stat;
  try { stat = await fs.lstat(target); } catch (e) { if (e.code === 'ENOENT') return { path: relative, exists: false, sha256: null, size: 0 }; throw e; }
  if (!stat.isFile()) throw fail('UNSAFE_OBJECT', `Not a regular file: ${relative}`);
  const data = await fs.readFile(target);
  // The snapshot's truth is the read bytes, not a stat size from before the read.
  return { path: relative, exists: true, sha256: digest(data), size: data.length, ...(bytes ? { bytes: data } : {}) };
}

export async function scanSource(source, { includeUntracked = true, includeIgnored = [] } = {}) {
  if (typeof includeUntracked !== 'boolean' || !Array.isArray(includeIgnored)) throw fail('INVALID_SELECTION', 'Invalid snapshot selection');
  const root = await rootFor(source), issues = [], excluded = [], files = [];
  let head = null;
  const refs = (await git(root, 'rev-parse', '--verify', '--quiet', 'HEAD').catch(e => { if (e.code === 'COMMAND_FAILED' && e.exitCode === 1) return ''; throw e; })).trim();
  if (refs) head = refs;
  const entries = new Map(), add = (name, mode, stage = '0') => { const old = entries.get(name) ?? { modes: new Set(), stages: new Set() }; if (mode) old.modes.add(mode); old.stages.add(stage); entries.set(name, old); };
  if (head) for (const row of splitZ(await git(root, 'ls-tree', '-rz', head))) { const tab = row.indexOf('\t'); add(row.slice(tab + 1), row.slice(0, tab).split(' ')[0]); }
  for (const row of splitZ(await git(root, 'ls-files', '--stage', '-z'))) { const tab = row.indexOf('\t'), [mode, , stage] = row.slice(0, tab).split(' '); add(row.slice(tab + 1), mode, stage); }
  if (includeUntracked) for (const name of splitZ(await git(root, 'ls-files', '--others', '--exclude-standard', '-z'))) add(name);
  for (const name of includeIgnored) { try { validateRelativePath(name); add(name); } catch (e) { issues.push({ path: name, code: e.code, message: e.message }); } }
  const sparse = new Set(splitZ(await git(root, 'ls-files', '-v', '-z')).filter(x => x[0]?.toUpperCase() === 'S').map(x => x.slice(2)));
  const aliases = new Map(), prepared = [], windowsPaths = new Set();
  for (const [name, meta] of [...entries].sort(([a], [b]) => a.localeCompare(b))) {
    try {
      validateRelativePath(name);
      const folded = name.toLowerCase(); if (aliases.has(folded) && aliases.get(folded) !== name) throw fail('CASE_COLLISION', `Windows path collision: ${aliases.get(folded)} / ${name}`); aliases.set(folded, name);
      const sensitive = sensitivePath(name); if (sensitive) { excluded.push({ path: name, reason: sensitive }); continue; }
      if ([...meta.stages].some(s => s !== '0')) throw fail('UNMERGED_INDEX', `Unmerged index entry: ${name}`);
      if (meta.modes.has('160000')) throw fail('SUBMODULE', `Submodule needs a separate workspace decision: ${name}`);
      if (meta.modes.has('120000')) throw fail('UNSAFE_OBJECT', `Git symbolic-link entry: ${name}`);
      await inspectChain(path.join(root, ...name.split('/')), windowsPaths);
      prepared.push(name);
    } catch (e) { issues.push({ path: name, code: e.code ?? 'READ_FAILED', message: e.message }); }
  }
  const reparses = await windowsReparse([...windowsPaths]);
  for (const name of prepared) {
    try {
      const target = path.join(root, ...name.split('/'));
      if (reparses.some(p => samePath(p, target) || target.toLowerCase().startsWith(p.toLowerCase() + path.sep))) throw fail('UNSAFE_OBJECT', `Reparse-point path: ${name}`);
      const state = await fileState(root, name, false, false);
      if (!state.exists && sparse.has(name)) throw fail('SPARSE_MISSING', `Sparse checkout omission is not a deletion: ${name}`);
      files.push(state);
    } catch (e) { issues.push({ path: name, code: e.code ?? 'READ_FAILED', message: e.message }); }
  }
  return { source: root, head, selection: { includeUntracked, includeIgnored: [...includeIgnored] }, files, excluded, issues };
}

export async function snapshotFiles(source, plan, dest) {
  if (!plan || !Array.isArray(plan.files) || !Array.isArray(plan.issues) || plan.issues.length) throw fail('INVALID_PLAN', 'A complete issue-free snapshot plan is required');
  const root = await rootFor(source), destination = path.resolve(dest);
  if (plan.source && !samePath(root, path.resolve(plan.source))) throw fail('SOURCE_MISMATCH', 'Snapshot plan belongs to another source');
  const relative = path.relative(root, destination);
  if (relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) throw fail('UNSAFE_DESTINATION', 'Snapshot destination must be outside the source working tree');
  await inspectChain(path.dirname(destination));
  try { await fs.lstat(destination); throw fail('DESTINATION_EXISTS', 'Snapshot destination must not exist'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const current = await scanSource(root, plan.selection);
  const canonical = p => JSON.stringify({ head: p.head, files: p.files, excluded: p.excluded, issues: p.issues });
  if (canonical(current) !== canonical(plan)) throw fail('SOURCE_CHANGED', 'Source selection, object types or bytes changed after planning');
  for (const expected of plan.files) {
    validateRelativePath(expected.path); if (sensitivePath(expected.path)) throw fail('INVALID_PLAN', 'Sensitive path cannot be injected into a snapshot plan');
  }
  // The first scan validates the whole plan. Copy one file buffer at a time,
  // and rescan after copying so a change to an already-copied file cannot
  // produce a successful snapshot. A failed private destination stays marked
  // partial for the workflow owner to inspect and clean up.
  await fs.mkdir(destination);
  try {
    const directoryPaths = new Set(), parents = new Set(plan.files.filter(item => item.exists).map(item => path.dirname(path.join(destination, ...item.path.split('/')))));
    for (const parent of parents) { await fs.mkdir(parent, { recursive: true }); await inspectChain(parent, directoryPaths); }
    const reparses = await windowsReparse([...directoryPaths]);
    if (reparses.length) throw fail('UNSAFE_DESTINATION', `Reparse point in snapshot destination: ${reparses.join(', ')}`);
    for (const expected of plan.files) {
      const actual = await fileState(root, expected.path, true, false);
      if (actual.exists !== expected.exists || actual.sha256 !== expected.sha256 || actual.size !== expected.size) throw fail('SOURCE_CHANGED', `Source changed while copying: ${expected.path}`);
      if (!actual.exists) continue;
      const target = path.join(destination, ...actual.path.split('/')); await inspectChain(path.dirname(target), false); await fs.writeFile(target, actual.bytes, { flag: 'wx' });
    }
    if (canonical(await scanSource(root, plan.selection)) !== canonical(plan)) throw fail('SOURCE_CHANGED', 'Source changed during snapshot creation');
  } catch (error) { error.snapshotDir = destination; error.destinationPartial = true; throw error; }
  return { destination, files: plan.files.map(f => ({ ...f })), head: plan.head };
}
