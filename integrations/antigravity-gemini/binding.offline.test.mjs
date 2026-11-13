import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

function isolated(code, bindings = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('ANTIGRAVITY_')) delete env[key];
  return execFileSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: new URL('.', import.meta.url), env: { ...env, ...bindings }, encoding: 'utf8', windowsHide: true,
  });
}
test('public legacy adapter requires explicit identity and wrapper bindings', () => {
  isolated(String.raw`import assert from 'node:assert/strict';
    import { parseReviewedWrapper, metadataSummary } from './live2d-sidecar/official-agentapi.mjs';
    import { validateRequest } from './live2d-sidecar/protocol.mjs';
    assert.throws(() => parseReviewedWrapper('@echo off\n"C:/fixture/native.exe" agentapi %*\n'), /Explicit/);
    assert.throws(() => metadataSummary(Buffer.from('{}'), 'fixture'), /Explicit/);
    assert.throws(() => validateRequest({}, 'fixture'), /Explicit/);`);
});
test('bound wrapper still rejects different delegates and shell commands', () => {
  isolated(String.raw`import assert from 'node:assert/strict';
    import { parseReviewedWrapper } from './live2d-sidecar/official-agentapi.mjs';
    assert.equal(parseReviewedWrapper('@echo off\n"C:/fixture/native.exe" agentapi %*\n').file, 'C:/fixture/native.exe');
    assert.throws(() => parseReviewedWrapper('@echo off\n"C:/other.exe" agentapi %*\n'), /Unrecognized/);
    assert.throws(() => parseReviewedWrapper('@echo off\n"C:/fixture/native.exe" agentapi %* & echo unsafe\n'), /Unrecognized/);`, {
      ANTIGRAVITY_REVIEWED_WRAPPER: 'C:/fixture/agentapi.bat', ANTIGRAVITY_REVIEWED_NATIVE: 'C:/fixture/native.exe',
    });
});


test('local bindings reject arbitrary environment injection and symlinks', async t => {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const os = await import('node:os');
  const { readLocalBindings, loadWorkerBindings } = await import('./local-bindings.mjs');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'binding-offline-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'adapter.local.json');
  const binding = { ANTIGRAVITY_REVIEWED_WRAPPER: path.join(root, 'agentapi.bat'), ANTIGRAVITY_REVIEWED_NATIVE: process.execPath };
  await fs.writeFile(file, JSON.stringify({ ...binding, NODE_OPTIONS: '--inspect' }));
  await assert.rejects(readLocalBindings(file), /Unsupported/);
  await fs.writeFile(file, JSON.stringify(binding));
  const { sha256 } = await readLocalBindings(file);
  const env = { ANTIGRAVITY_EXPECTED_PROJECT_ID: 'stale', UNRELATED: 'keep' };
  await loadWorkerBindings(['--local-bindings', file, sha256], env);
  assert.equal(env.ANTIGRAVITY_EXPECTED_PROJECT_ID, undefined);
  assert.equal(env.UNRELATED, 'keep');
  const link = path.join(root, 'linked.json');
  try { await fs.symlink(file, link, 'file'); }
  catch (error) { if (error.code === 'EPERM') { t.diagnostic('symlink creation unavailable; other assertions passed'); return; } throw error; }
  await assert.rejects(readLocalBindings(link), /non-link/);
});
