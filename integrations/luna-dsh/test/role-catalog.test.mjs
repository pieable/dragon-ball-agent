import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRoleCatalog, requireRole, LUNA_ROLES } from '../role-catalog.mjs';
const root = fileURLToPath(new URL('../.tests-tmp/', import.meta.url));
async function fixture(t) {
  await fs.mkdir(root, { recursive: true });
  const home = await fs.mkdtemp(path.join(root, 'roles-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await fs.mkdir(path.join(home, 'agents'));
  await fs.writeFile(path.join(home, 'config.toml'), 'secret_key="DO_NOT_RETURN_THIS"\n[features]\nmemories=true\n');
  const efforts = ['medium', 'low', 'high', 'max'];
  for (const [i, name] of LUNA_ROLES.entries()) await fs.writeFile(path.join(home, 'agents', name + '.toml'), `name="${name}"\ndescription="中文角色"\nmodel="gpt-6-luna"\nmodel_reasoning_effort="${efforts[i]}"\ndeveloper_instructions="""保持原始上下文\n逐项验证。"""\n[features]\nmemories=false\n[skills]\ninclude_instructions=false\n`);
  return home;
}
test('Unicode, exact effort and selective config fields are preserved', async t => {
  const home = await fixture(t), c = await loadRoleCatalog({ codexHome: home });
  assert.deepEqual(c.roles.map(r => r.effort), ['medium', 'low', 'high', 'max']);
  assert.equal(requireRole(c, 'worker').developer_instructions, '保持原始上下文\n逐项验证。');
  assert.equal(c.roles[0].skills.include_instructions, false);
  assert.equal(c.roles[0].features.memories, false);
  assert.equal(c.global_features.memories, true);
  assert.ok(!JSON.stringify(c).includes('DO_NOT_RETURN_THIS'));
  assert.equal(c.codex_only.length, 3);
});
test('source hash changes and explicit path binding is resolved', async t => {
  const home = await fixture(t), c = await loadRoleCatalog({ codexHome: home });
  const p = path.join(home, 'agents', 'worker.toml');
  await fs.appendFile(p, '\n# changed\n');
  const d = await loadRoleCatalog({ codexHome: home });
  assert.notEqual(c.roles[0].source.sha256, d.roles[0].source.sha256);
  await fs.rename(p, path.join(home, 'custom.toml'));
  await fs.appendFile(path.join(home, 'config.toml'), '\n[agents.worker]\nconfig_file="custom.toml"\n');
  assert.equal(requireRole(await loadRoleCatalog({ codexHome: home }), 'worker').source.path, path.join(home, 'custom.toml'));
});
test('unknown and reserved roles cannot migrate; non-Luna model never rewritten', async t => {
  const home = await fixture(t);
  const p = path.join(home, 'agents', 'worker.toml');
  await fs.writeFile(p, (await fs.readFile(p, 'utf8')).replace('gpt-6-luna', 'gpt-6.1-sol'));
  const c = await loadRoleCatalog({ codexHome: home });
  assert.equal(c.roles[0].model, 'gpt-6.1-sol');
  assert.throws(() => requireRole(c, 'worker'), { code: 'ROLE_MODEL_CHANGED' });
  for (const name of ['default', 'content-designer', 'visual-usability-tester']) assert.throws(() => requireRole(c, name), { code: 'ROLE_CODEX_ONLY' });
  for (const name of ['reviewer', 'astra-specialist', 'operator', '../worker']) assert.throws(() => requireRole(c, name), { code: 'ROLE_NOT_SUPPORTED' });
});
test('missing, invalid TOML and missing effort stay explicit', async t => {
  const home = await fixture(t);
  await fs.rm(path.join(home, 'agents', 'worker.toml'));
  await fs.writeFile(path.join(home, 'agents', 'explorer.toml'), 'bad = [');
  const p = path.join(home, 'agents', 'code-executor.toml');
  await fs.writeFile(p, (await fs.readFile(p, 'utf8')).replace('model_reasoning_effort="high"', ''));
  const c = await loadRoleCatalog({ codexHome: home });
  assert.throws(() => requireRole(c, 'worker'), { code: 'SOURCE_MISSING' });
  assert.throws(() => requireRole(c, 'explorer'), { code: 'INVALID_TOML' });
  assert.throws(() => requireRole(c, 'code-executor'), { code: 'ROLE_EFFORT_INVALID' });
  await fs.writeFile(path.join(home, 'config.toml'), 'secret_key = "DO_NOT_LEAK\n');
  await assert.rejects(loadRoleCatalog({ codexHome: home }), e => e.code === 'INVALID_TOML' && !e.message.includes('DO_NOT_LEAK'));
});
