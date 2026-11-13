import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRegistry } from './registry.mjs';
import { workerConfigDigest } from './runtime-version.mjs';
import { createTaskStore } from './task-store.mjs';
import { AppConfigWriterError, writeAppConfigTarget } from './app-config-writer.mjs';

const componentRoot = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(componentRoot, 'server.mjs');
const digest = value => createHash('sha256').update(value).digest('hex');
const appFileUri = value => pathToFileURL(value).href.replace(/^file:\/\/\/([a-z]):/i, (_match, drive) => `file:///${drive.toLowerCase()}%3A`);

async function fixture(t, { withProject = true, secondRoot = false, appConfigWriter } = {}) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'antigravity-registry-offline-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, '工作区 资料');
  const otherRoot = path.join(temp, 'second root');
  const configDir = path.join(temp, 'gemini', 'config');
  const projectsDir = path.join(configDir, 'projects');
  const sidecarsDir = path.join(configDir, 'sidecars');
  const manifestPath = path.join(temp, 'bindings.json');
  const workerPath = path.join(temp, 'worker entry.mjs');
  await fs.mkdir(root, { recursive: true });
  if (secondRoot) await fs.mkdir(otherRoot, { recursive: true });
  await fs.mkdir(projectsDir, { recursive: true });
  await fs.mkdir(sidecarsDir, { recursive: true });
  await fs.writeFile(workerPath, 'process.exit(0);\n');
  const projectId = '11111111-2222-4333-8444-555555555555';
  if (withProject) {
    const resources = [{ gitFolder: { folderUri: appFileUri(root), allowWrite: true } }];
    if (secondRoot) resources.push({ localFolder: { folderUri: appFileUri(otherRoot) } });
    await fs.writeFile(path.join(projectsDir, `${projectId}.json`), JSON.stringify({
      id: projectId,
      name: 'fixture project',
      projectResources: { resources },
      unmodifiedProjectSetting: { keep: true },
    }, null, 2));
  }
  const oldBinding = {
    workspace_root: path.join(temp, 'legacy workspace'),
    sidecar_root: path.join(temp, 'legacy sidecar'),
    project_id: randomUUID(),
    conversation_id: randomUUID(),
    sidecar_id: 'legacy-sidecar',
    custom_old_field: { preserve: ['v1', 'as-is'] },
  };
  const legacyTopLevel = { version: 1, bindings: [oldBinding], oldTopLevelField: { preserve: true } };
  const manifestOriginal = Buffer.from(`${JSON.stringify(legacyTopLevel, null, 4)}\n`, 'utf8');
  await fs.writeFile(manifestPath, manifestOriginal);
  const appConfig = {
    otherSetting: { keep: 'unknown' },
    sidecars: { 'other-sidecar': { enabled: false, projectId: randomUUID(), custom: 'preserve' } },
  };
  const configPath = path.join(configDir, 'config.json');
  await fs.writeFile(configPath, JSON.stringify(appConfig, null, 3));
  const registry = createRegistry({ manifestPath, appConfigDir: configDir, sidecarsDir, workerPath, nodeExecutable: process.execPath, appConfigWriter });
  return { temp, root, otherRoot, configDir, projectsDir, sidecarsDir, manifestPath, workerPath, configPath, projectId, oldBinding, legacyTopLevel, manifestOriginal, appConfig, registry };
}

async function runOldReaderBindingStatus(workspace, manifestPath) {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [serverPath, manifestPath], { cwd: workspace, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', value => { stdout += value; });
    child.stderr.setEncoding('utf8').on('data', value => { stderr += value; });
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) return reject(new Error(`old server reader exited ${code}: ${stderr}`));
      resolve({ code, stdout, stderr });
    });
    const messages = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'registry-test', version: '1' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'binding_status', arguments: {} } },
    ];
    child.stdin.end(messages.map(value => JSON.stringify(value)).join('\n') + '\n');
  });
}

test('catalog reads only App project JSON, resolves encoded local roots, and returns the complete root set', async t => {
  const f = await fixture(t, { secondRoot: true });
  const found = await f.registry.catalog({ cwd: f.root });
  assert.equal(found.state, 'unique_match');
  assert.equal(found.candidates[0].project_id, f.projectId);
  assert.equal(found.candidates[0].resource_roots.length, 2);
  assert.equal(found.candidates[0].resource_roots[0].kind, 'gitFolder');
  assert.equal(found.candidates[0].resource_roots[0].shape_status, 'verified');
  assert.equal(found.candidates[0].resource_roots[1].kind, 'localFolder');
  assert.equal(found.candidates[0].resource_roots[1].shape_status, 'unverified');
  assert.equal(found.candidates[0].resource_roots[0].path, await fs.realpath(f.root));
  assert.equal((await f.registry.catalog({ cwd: path.join(f.root, 'nested') })).state, 'error');
  assert.equal((await f.registry.catalog({ cwd: f.otherRoot })).state, 'unique_match');
});

test('the direct folderUri local-folder candidate remains marked unverified', async t => {
  const f = await fixture(t, { withProject: false });
  const projectId = randomUUID();
  await fs.writeFile(path.join(f.projectsDir, `${projectId}.json`), JSON.stringify({
    id: projectId,
    projectResources: { resources: [{ folderUri: appFileUri(f.root) }] },
  }));
  const result = await f.registry.catalog({ cwd: f.root });
  assert.equal(result.state, 'unique_match');
  assert.equal(result.candidates[0].resource_roots[0].kind, 'localFolder');
  assert.equal(result.candidates[0].resource_roots[0].shape_status, 'unverified');
  assert.equal(result.candidates[0].resource_roots[0].source, 'recognized_direct_folder_uri_candidate');
});

test('projects with the observed empty projectResources object are kept as empty and do not block a local route match', async t => {
  const f = await fixture(t);
  const emptyProject = '90ac63e8-8975-4145-9de9-245829285ff2';
  await fs.writeFile(path.join(f.projectsDir, `${emptyProject}.json`), JSON.stringify({
    id: emptyProject, name: 'project without local resources', projectResources: {},
  }));
  const catalog = await f.registry.catalog({ cwd: f.root });
  assert.equal(catalog.state, 'unique_match');
  assert.equal(catalog.completeness, 'complete');
  assert.deepEqual(catalog.candidates.map(row => row.project_id), [f.projectId]);
  assert.deepEqual(catalog.candidates[0].resource_roots.map(row => row.path), [await fs.realpath(f.root)]);
  assert.equal((await f.registry.catalog({ cwd: f.temp })).state, 'no_match');
});

test('catalog explicitly reports no, multiple, and unsupported project resource shapes', async t => {
  const none = await fixture(t, { withProject: false });
  assert.equal((await none.registry.catalog({ cwd: none.root })).state, 'no_match');
  await assert.rejects(none.registry.connect({ cwd: none.root, apply: true }), error => error.code === 'app_project_not_found');

  const multiple = await fixture(t);
  const duplicateId = randomUUID();
  await fs.writeFile(path.join(multiple.projectsDir, `${duplicateId}.json`), JSON.stringify({
    id: duplicateId, name: 'same path, different project', projectResources: { resources: [{ gitFolder: { folderUri: appFileUri(multiple.root) } }] },
  }));
  assert.equal((await multiple.registry.catalog({ cwd: multiple.root })).state, 'ambiguous');
  await assert.rejects(multiple.registry.connect({ cwd: multiple.root }), error => error.code === 'app_project_ambiguous');
  const selected = await multiple.registry.connect({ cwd: multiple.root, project_id: multiple.projectId });
  assert.equal(selected.state, 'dry_run');
  await multiple.registry.connect({ cwd: multiple.root, project_id: multiple.projectId, apply: true });
  await assert.rejects(multiple.registry.connect({ cwd: multiple.root, project_id: duplicateId, apply: true }),
    error => error.code === 'route_workspace_conflict');
  assert.equal((await multiple.registry.resolveRoute({ cwd: multiple.root })).state, 'unique_match');

  const unsupported = await fixture(t, { withProject: false });
  const unsupportedId = randomUUID();
  await fs.writeFile(path.join(unsupported.projectsDir, `${unsupportedId}.json`), JSON.stringify({
    id: unsupportedId, name: 'remote project', projectResources: { resources: [{ googleDrive: { resourceId: 'not-local' } }] },
  }));
  const schema = await unsupported.registry.catalog({ cwd: unsupported.root });
  assert.equal(schema.state, 'no_match');
  assert.equal(schema.completeness, 'partial');
  assert.equal(schema.warnings[0].code, 'catalog_schema_unsupported');
  await assert.rejects(unsupported.registry.connect({ cwd: unsupported.root }), error => error.code === 'app_catalog_incomplete');
  await assert.rejects(unsupported.registry.connect({ cwd: unsupported.root, project_id: unsupportedId }), error => error.code === 'catalog_schema_unsupported');
});

test('an unrelated unsupported project becomes a warning while an explicit verified target remains connectable', async t => {
  const f = await fixture(t);
  const unrelatedId = randomUUID();
  await fs.writeFile(path.join(f.projectsDir, `${unrelatedId}.json`), JSON.stringify({
    id: unrelatedId, name: 'unrelated project with unsupported resource',
    projectResources: { resources: [{ cloudResource: { id: 'opaque' } }] },
  }));
  const catalog = await f.registry.catalog({ cwd: f.root });
  assert.equal(catalog.state, 'unique_match');
  assert.equal(catalog.completeness, 'partial');
  assert.equal(catalog.candidates.length, 1);
  assert.equal(catalog.candidates[0].project_id, f.projectId);
  assert.equal(catalog.warnings.length, 1);
  assert.equal(catalog.warnings[0].project_id, unrelatedId);
  assert.equal(catalog.selection_requires_project_id, true);
  await assert.rejects(f.registry.connect({ cwd: f.root }), error => error.code === 'app_catalog_incomplete');
  const selected = await f.registry.connect({ cwd: f.root, project_id: f.projectId });
  assert.equal(selected.state, 'dry_run');
});

test('dry-run reports three hashed targets without writing; apply preserves v1 and App fields and is idempotent', async t => {
  const f = await fixture(t, { secondRoot: true });
  const beforeConfig = await fs.readFile(f.configPath);
  const preview = await f.registry.connect({ cwd: f.root });
  assert.equal(preview.state, 'dry_run');
  assert.equal(preview.targets.length, 3);
  assert.deepEqual(preview.targets.map(target => target.name), ['descriptor', 'manifest', 'app_config']);
  assert.equal(preview.targets.every(target => /^[a-f0-9]{64}$/.test(target.target_sha256)), true);
  assert.equal(preview.targets.every(target => target.changed), true);
  assert.equal((await fs.readFile(f.configPath)).equals(beforeConfig), true);
  assert.equal((await fs.readFile(f.manifestPath)).equals(f.manifestOriginal), true);
  assert.equal(await fs.access(path.join(f.sidecarsDir, `codex-${f.projectId}`, 'sidecar.json')).then(() => true, () => false), false);
  assert.equal(await fs.access(path.join(f.configDir, '.codex-antigravity-registry')).then(() => true, () => false), false);

  const applied = await f.registry.connect({ cwd: f.root, apply: true });
  assert.equal(applied.state, 'configured_needs_sidecar_reload');
  assert.equal(applied.sidecar_id, `codex-${f.projectId}`);
  assert.equal(applied.workspace_roots.length, 2);
  assert.equal(applied.state_root, path.join(applied.route.workspace_roots[0].path, '.antigravity-gemini-mcp'));
  const manifest = JSON.parse(await fs.readFile(f.manifestPath, 'utf8'));
  assert.equal(manifest.version, 1);
  assert.deepEqual(manifest.bindings, f.legacyTopLevel.bindings);
  assert.deepEqual(manifest.oldTopLevelField, f.legacyTopLevel.oldTopLevelField);
  assert.equal(manifest.routes_v3.length, 1);
  const config = JSON.parse(await fs.readFile(f.configPath, 'utf8'));
  assert.deepEqual(config.otherSetting, f.appConfig.otherSetting);
  assert.deepEqual(config.sidecars['other-sidecar'], f.appConfig.sidecars['other-sidecar']);
  assert.deepEqual(config.sidecars[`codex-${f.projectId}`], { enabled: true, projectId: f.projectId });
  const descriptor = JSON.parse(await fs.readFile(path.join(f.sidecarsDir, `codex-${f.projectId}`, 'sidecar.json'), 'utf8'));
  assert.equal(descriptor.command, process.execPath);
  assert.deepEqual(descriptor.args, [f.workerPath, '--serve', f.manifestPath, `codex-${f.projectId}`]);
  assert.equal(descriptor.restart_policy, 'never');
  assert.deepEqual(await fs.readdir(f.projectsDir), [`${f.projectId}.json`]);

  const hashesBeforeRepeat = await Promise.all([f.manifestPath, f.configPath, path.join(f.sidecarsDir, `codex-${f.projectId}`, 'sidecar.json')].map(async file => digest(await fs.readFile(file))));
  const second = await f.registry.connect({ cwd: f.root, apply: true });
  assert.equal(second.state, 'already_configured');
  const hashesAfterRepeat = await Promise.all([f.manifestPath, f.configPath, path.join(f.sidecarsDir, `codex-${f.projectId}`, 'sidecar.json')].map(async file => digest(await fs.readFile(file))));
  assert.deepEqual(hashesAfterRepeat, hashesBeforeRepeat);
});

test('resource reorder preserves the route state owner, duplicate key, and single dispatch; root-set changes require migration', async t => {
  const f = await fixture(t, { secondRoot: true });
  await f.registry.connect({ cwd: f.root, default_model: { id: 'gemini-4-argon-medium', source: 'fixture' }, apply: true });
  const routeA = (await f.registry.resolveRoute({ cwd: f.root })).route;
  const stateRoot = routeA.state_root;
  const storeA = createTaskStore(routeA);
  const key = `codex-mcp-${randomUUID()}`;
  const request = { operation: 'start', title: 'Stable owner task', prompt: 'Run once.', task_kind: 'writing', materials: [] };
  const first = await storeA.submit(key, request);
  assert.equal(first.duplicate, false);
  const requestFile = path.join(stateRoot, 'runtime', 'turns', key, 'request.json');
  assert.equal((await fs.stat(requestFile)).isFile(), true);
  let dispatchCount = 0;
  const native = {
    verifyCreation: async () => {},
    dispatch: async () => { dispatchCount += 1; return { acknowledged: false, timed_out: true }; },
  };
  await storeA.pump(native);
  assert.equal(dispatchCount, 1);

  const projectFile = path.join(f.projectsDir, `${f.projectId}.json`);
  const project = JSON.parse(await fs.readFile(projectFile, 'utf8'));
  project.projectResources.resources.reverse();
  await fs.writeFile(projectFile, JSON.stringify(project, null, 2));
  const reconnected = await f.registry.connect({ cwd: f.root, project_id: f.projectId, apply: true });
  assert.equal(reconnected.state, 'already_configured');
  const routeB = (await f.registry.resolveRoute({ cwd: f.root })).route;
  assert.equal(routeB.state_root, stateRoot);
  assert.deepEqual(routeB.workspace_roots, routeA.workspace_roots);
  const storeB = createTaskStore(routeB);
  const duplicate = await storeB.submit(key, request);
  assert.equal(duplicate.duplicate, true);
  await storeB.pump(native);
  assert.equal(dispatchCount, 1);
  assert.equal((await fs.stat(requestFile)).isFile(), true);

  const addedRoot = path.join(f.temp, 'added resource root');
  await fs.mkdir(addedRoot);
  project.projectResources.resources.push({ gitFolder: { folderUri: appFileUri(addedRoot) } });
  await fs.writeFile(projectFile, JSON.stringify(project, null, 2));
  const manifestBefore = await fs.readFile(f.manifestPath);
  await assert.rejects(f.registry.connect({ cwd: f.root, project_id: f.projectId, apply: true }),
    error => error.code === 'route_workspace_migration_required');
  assert.deepEqual(await fs.readFile(f.manifestPath), manifestBefore);
  const configBefore = await fs.readFile(f.configPath);
  await assert.rejects(f.registry.setSidecarEnabled({ cwd: f.root, enabled: false }),
    error => error.code === 'route_workspace_migration_required');
  assert.deepEqual(await fs.readFile(f.configPath), configBefore);
  assert.equal((await fs.stat(requestFile)).isFile(), true);
  assert.equal(dispatchCount, 1);
});

test('exclusive App config writer holds one .NET handle, rejects an existing writer and blocks write or replacement', async t => {
  const f = await fixture(t);
  const file = path.join(f.temp, 'writer fixture.json');
  const baseline = Buffer.from('{"secret":"do not log","sidecars":{}}\n');
  const target = Buffer.from('{"secret":"do not log","sidecars":{"x":{"enabled":true}}}\n');
  await fs.writeFile(file, baseline);
  let signalLocked;
  const locked = new Promise(resolve => { signalLocked = resolve; });
  const write = writeAppConfigTarget({ path: file, baseline_sha256: digest(baseline), target_sha256: digest(target),
    target_bytes: target, test_hold_after_lock_ms: 1600, on_locked: signalLocked });
  let timeout;
  try {
    await Promise.race([locked, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('writer did not expose its held-handle signal')), 5000); })]);
  } finally { clearTimeout(timeout); }
  await assert.rejects(writeAppConfigTarget({ path: file, baseline_sha256: digest(baseline), target_sha256: digest(target), target_bytes: target }),
    error => error.code === 'app_config_writer_busy');
  await assert.rejects(fs.writeFile(file, Buffer.from('external edit')));
  const replacement = path.join(f.temp, 'replacement.json');
  await fs.writeFile(replacement, Buffer.from('replacement'));
  const replaceFile = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    '[System.IO.File]::Replace($args[0], $args[1], $null)', replacement, file], {
    encoding: 'utf8', windowsHide: true, timeout: 5000,
  });
  assert.notEqual(replaceFile.status, 0);
  await assert.rejects(fs.rename(replacement, file));
  const written = await write;
  assert.equal(written.state, 'written');
  assert.deepEqual(await fs.readFile(file), target);
});

test('the established v1 binding reader still accepts its manifest envelope beside routes_v3', async t => {
  const f = await fixture(t);
  await f.registry.connect({ cwd: f.root, apply: true });
  const unmatchedWorkspace = path.join(f.temp, 'unmatched old-reader workspace');
  await fs.mkdir(unmatchedWorkspace);
  const oldReader = await runOldReaderBindingStatus(unmatchedWorkspace, f.manifestPath);
  assert.equal(oldReader.code, 0);
  assert.equal(oldReader.stderr, '');
  const messages = oldReader.stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(messages[0].result.protocolVersion, '2025-11-25');
  assert.ok(messages[1]?.result, JSON.stringify(messages));
  const status = JSON.parse(messages[1].result.content[0].text);
  assert.equal(status.state, 'unbound');
  assert.equal(status.registry.route.state, 'missing');
  assert.equal(status.registry.route.value, null);
});

test('v3 connect rejects an existing legacy owner or an exact legacy workspace root', async t => {
  const f = await fixture(t);
  const overlappingRoot = { ...f.oldBinding, workspace_root: f.root };
  const workspaceConflict = Buffer.from(JSON.stringify({ ...f.legacyTopLevel, bindings: [overlappingRoot] }, null, 2));
  await fs.writeFile(f.manifestPath, workspaceConflict);
  await assert.rejects(f.registry.connect({ cwd: f.root }), error => error.code === 'legacy_route_workspace_conflict');
  assert.deepEqual(await fs.readFile(f.manifestPath), workspaceConflict);
  const ownerConflict = Buffer.from(JSON.stringify({ ...f.legacyTopLevel, bindings: [{ ...f.oldBinding, project_id: f.projectId }] }, null, 2));
  await fs.writeFile(f.manifestPath, ownerConflict);
  await assert.rejects(f.registry.connect({ cwd: f.root }), error => error.code === 'legacy_route_owner_conflict');
  assert.deepEqual(await fs.readFile(f.manifestPath), ownerConflict);
  assert.equal(await fs.access(path.join(f.sidecarsDir, `codex-${f.projectId}`, 'sidecar.json')).then(() => true, () => false), false);
});

test('explicit reconnect preserves the App schema marker and archives the prior waiting-for-reload journal', async t => {
  const f = await fixture(t);
  const sidecarId = `codex-${f.projectId}`;
  const first = await f.registry.connect({ cwd: f.root, project_id: f.projectId, apply: true });
  assert.equal(first.state, 'configured_needs_sidecar_reload');
  const journalPath = path.join(f.configDir, '.codex-antigravity-registry', 'transactions', `${sidecarId}.json`);
  const originalJournal = await fs.readFile(journalPath);
  const appManagedProjectId = randomUUID();
  await fs.writeFile(path.join(f.projectsDir, `${appManagedProjectId}.json`), JSON.stringify({
    id: appManagedProjectId, name: sidecarId,
    projectResources: { resources: [{ gitFolder: { folderUri: appFileUri(f.root) } }] },
  }));
  const config = JSON.parse(await fs.readFile(f.configPath, 'utf8'));
  config.sidecars[sidecarId] = { enabled: true, projectId: appManagedProjectId, schemaVersion: 1, app_owned_flag: 'preserve' };
  await fs.writeFile(f.configPath, JSON.stringify(config, null, 2));
  const manifestBefore = await fs.readFile(f.manifestPath);
  const descriptorPath = path.join(f.sidecarsDir, sidecarId, 'sidecar.json');
  const descriptorBefore = await fs.readFile(descriptorPath);

  const preview = await f.registry.connect({ cwd: f.root, project_id: f.projectId });
  assert.equal(preview.state, 'dry_run');
  assert.deepEqual(preview.targets.map(target => target.name), ['descriptor', 'manifest', 'app_config']);
  assert.equal(preview.targets[0].changed, false);
  assert.equal(preview.targets[1].changed, false);
  assert.equal(preview.targets[2].changed, true);
  const second = await f.registry.connect({ cwd: f.root, project_id: f.projectId, apply: true });
  assert.equal(second.state, 'configured_needs_sidecar_reload');

  const rewrittenConfig = JSON.parse(await fs.readFile(f.configPath, 'utf8'));
  assert.deepEqual(rewrittenConfig.sidecars[sidecarId], {
    enabled: true, projectId: f.projectId, schemaVersion: 1, app_owned_flag: 'preserve',
  });
  assert.deepEqual(await fs.readFile(f.manifestPath), manifestBefore);
  assert.deepEqual(await fs.readFile(descriptorPath), descriptorBefore);
  const historyPath = path.join(path.dirname(journalPath), 'history', `${sidecarId}-${first.transaction_id}.json`);
  const archivedJournal = JSON.parse(await fs.readFile(historyPath, 'utf8'));
  assert.equal(archivedJournal.transaction_id, first.transaction_id);
  assert.equal(archivedJournal.targets.app_config.journal_bytes_redacted, true);
  assert.equal(archivedJournal.targets.app_config.baseline_bytes_base64, undefined);
  assert.equal(archivedJournal.targets.app_config.target_bytes_base64, undefined);
  const completedJournal = JSON.parse(originalJournal.toString('utf8'));
  assert.equal(completedJournal.targets.app_config.journal_bytes_redacted, true);
  assert.equal(completedJournal.targets.app_config.target_bytes_base64, undefined);
  const newJournal = JSON.parse(await fs.readFile(journalPath, 'utf8'));
  assert.equal(newJournal.supersedes_transaction_id, first.transaction_id);
});

test('projectId reconciliation refuses a same-name App project with different resource roots', async t => {
  const f = await fixture(t);
  const sidecarId = `codex-${f.projectId}`;
  await f.registry.connect({ cwd: f.root, project_id: f.projectId, apply: true });
  const otherRoot = path.join(f.temp, 'different managed root');
  await fs.mkdir(otherRoot);
  const managedId = randomUUID();
  await fs.writeFile(path.join(f.projectsDir, `${managedId}.json`), JSON.stringify({ id: managedId,
    name: sidecarId, projectResources: { resources: [{ gitFolder: { folderUri: appFileUri(otherRoot) } }] } }));
  const config = JSON.parse(await fs.readFile(f.configPath, 'utf8'));
  config.sidecars[sidecarId] = { enabled: true, projectId: managedId, schemaVersion: 1 };
  await fs.writeFile(f.configPath, JSON.stringify(config, null, 2));
  const configBefore = await fs.readFile(f.configPath);
  const manifestBefore = await fs.readFile(f.manifestPath);
  await assert.rejects(f.registry.connect({ cwd: f.root, project_id: f.projectId }),
    error => error.code === 'sidecar_managed_project_mismatch');
  assert.deepEqual(await fs.readFile(f.configPath), configBefore);
  assert.deepEqual(await fs.readFile(f.manifestPath), manifestBefore);
});

test('concurrent external manifest edits stop the transaction without replacing the edit', async t => {
  const f = await fixture(t);
  const originalLink = fs.link;
  let edited = false;
  fs.link = async (...args) => {
    const result = await originalLink(...args);
    if (!edited && args[1] === path.join(f.sidecarsDir, `codex-${f.projectId}`, 'sidecar.json')) {
      edited = true;
      await fs.writeFile(f.manifestPath, JSON.stringify({ ...f.legacyTopLevel, externalEdit: 'keep this' }, null, 2));
    }
    return result;
  };
  try {
    await assert.rejects(f.registry.connect({ cwd: f.root, apply: true }), error => error.code === 'registry_external_edit_conflict' && error.stage === 'manifest_written');
  } finally {
    fs.link = originalLink;
  }
  const manifest = JSON.parse(await fs.readFile(f.manifestPath, 'utf8'));
  assert.equal(manifest.externalEdit, 'keep this');
  assert.equal(manifest.routes_v3, undefined);
  assert.equal(await fs.access(path.join(f.sidecarsDir, `codex-${f.projectId}`, 'sidecar.json')).then(() => true, () => false), true);
  assert.equal(JSON.parse(await fs.readFile(f.configPath, 'utf8')).sidecars[`codex-${f.projectId}`], undefined);
});

test('an external App config edit committed before registration is reported and preserved', async t => {
  const f = await fixture(t);
  const originalLink = fs.link;
  const sidecarPath = path.join(f.sidecarsDir, `codex-${f.projectId}`, 'sidecar.json');
  let edited = false;
  fs.link = async (...args) => {
    const result = await originalLink(...args);
    if (!edited && args[1] === sidecarPath) {
      edited = true;
      const config = JSON.parse(await fs.readFile(f.configPath, 'utf8'));
      config.external_writer = { secret: 'preserve external value' };
      await fs.writeFile(f.configPath, JSON.stringify(config, null, 2));
    }
    return result;
  };
  let error;
  try { await f.registry.connect({ cwd: f.root, apply: true }); }
  catch (caught) { error = caught; }
  finally { fs.link = originalLink; }
  assert.equal(edited, true);
  assert.equal(error?.code, 'app_config_external_edit_conflict');
  assert.equal(error.message.includes('preserve external value'), false);
  const config = JSON.parse(await fs.readFile(f.configPath, 'utf8'));
  assert.deepEqual(config.external_writer, { secret: 'preserve external value' });
  assert.equal(config.sidecars[`codex-${f.projectId}`], undefined);
  await assert.rejects(f.registry.connect({ cwd: f.root, apply: true }), error => error.code === 'registry_recovery_required');
  assert.deepEqual(JSON.parse(await fs.readFile(f.configPath, 'utf8')).external_writer, { secret: 'preserve external value' });
});

test('a partial App config write leaves recovery material and never overwrites unknown bytes', async t => {
  let calls = 0;
  const appConfigWriter = async args => {
    calls += 1;
    if (calls === 1) {
      const handle = await fs.open(args.path, 'r+');
      try {
        await handle.truncate(0);
        await handle.write(Buffer.from('{"partial":"write'));
        await handle.sync();
      } finally { await handle.close(); }
      throw new AppConfigWriterError('app_config_write_interrupted', 'The App config write did not reach verified completion.');
    }
    return writeAppConfigTarget(args);
  };
  const f = await fixture(t, { appConfigWriter });
  await assert.rejects(f.registry.connect({ cwd: f.root, apply: true }), error => error.code === 'app_config_write_interrupted');
  const partialBytes = await fs.readFile(f.configPath);
  const journalPath = path.join(f.configDir, '.codex-antigravity-registry', 'transactions', `codex-${f.projectId}.json`);
  const journalBeforeRetry = JSON.parse(await fs.readFile(journalPath, 'utf8'));
  assert.equal(journalBeforeRetry.stage, 'manifest_written');
  assert.equal(journalBeforeRetry.targets.app_config.write_started, true);
  assert.equal(typeof journalBeforeRetry.targets.app_config.baseline_bytes_base64, 'string');
  assert.equal(typeof journalBeforeRetry.targets.app_config.target_bytes_base64, 'string');
  await assert.rejects(f.registry.connect({ cwd: f.root, apply: true }), error => error.code === 'registry_recovery_required');
  assert.deepEqual(await fs.readFile(f.configPath), partialBytes);
  const journalAfterRetry = JSON.parse(await fs.readFile(journalPath, 'utf8'));
  assert.equal(journalAfterRetry.targets.app_config.target_sha256, journalBeforeRetry.targets.app_config.target_sha256);
});

test('setSidecarEnabled changes only the current route registration and preserves App-owned fields', async t => {
  const f = await fixture(t);
  await f.registry.connect({ cwd: f.root, apply: true });
  const sidecarId = `codex-${f.projectId}`;
  const config = JSON.parse(await fs.readFile(f.configPath, 'utf8'));
  config.sidecars[sidecarId].schemaVersion = 1;
  config.sidecars[sidecarId].app_owned_flag = { keep: true };
  await fs.writeFile(f.configPath, JSON.stringify(config, null, 2));
  const manifestBefore = await fs.readFile(f.manifestPath);
  const descriptorPath = path.join(f.sidecarsDir, sidecarId, 'sidecar.json');
  const descriptorBefore = await fs.readFile(descriptorPath);
  const disabled = await f.registry.setSidecarEnabled({ cwd: f.root, enabled: false });
  assert.equal(disabled.state, 'configured');
  assert.equal(disabled.enabled, false);
  const disabledConfig = JSON.parse(await fs.readFile(f.configPath, 'utf8'));
  assert.deepEqual(disabledConfig.sidecars[sidecarId], {
    enabled: false, projectId: f.projectId, schemaVersion: 1, app_owned_flag: { keep: true },
  });
  assert.deepEqual(await fs.readFile(f.manifestPath), manifestBefore);
  assert.deepEqual(await fs.readFile(descriptorPath), descriptorBefore);
  assert.equal((await f.registry.setSidecarEnabled({ cwd: f.root, enabled: false })).state, 'already_configured');
  const enabled = await f.registry.setSidecarEnabled({ cwd: f.root, enabled: true });
  assert.equal(enabled.state, 'configured');
  assert.equal(JSON.parse(await fs.readFile(f.configPath, 'utf8')).sidecars[sidecarId].enabled, true);
  const conflicting = JSON.parse(await fs.readFile(f.configPath, 'utf8'));
  conflicting.sidecars[sidecarId].projectId = randomUUID();
  await fs.writeFile(f.configPath, JSON.stringify(conflicting, null, 2));
  const conflictBytes = await fs.readFile(f.configPath);
  await assert.rejects(f.registry.setSidecarEnabled({ cwd: f.root, enabled: false }), error => error.code === 'app_sidecar_owner_conflict');
  assert.deepEqual(await fs.readFile(f.configPath), conflictBytes);
});

test('journal resumes when the manifest target write completed before its phase was recorded', async t => {
  const f = await fixture(t);
  const originalRename = fs.rename;
  let injected = false;
  fs.rename = async (from, to) => {
    const result = await originalRename(from, to);
    if (!injected && to === f.manifestPath) {
      injected = true;
      const error = new Error('simulated interruption after manifest rename');
      error.code = 'SIMULATED_CRASH';
      throw error;
    }
    return result;
  };
  try {
    await assert.rejects(f.registry.connect({ cwd: f.root, apply: true }), error => error.cause_code === 'SIMULATED_CRASH');
  } finally {
    fs.rename = originalRename;
  }
  assert.equal(injected, true);
  const recovered = await f.registry.connect({ cwd: f.root, apply: true });
  assert.equal(recovered.state, 'configured_needs_sidecar_reload');
  assert.equal(recovered.resumed, true);
  assert.equal(JSON.parse(await fs.readFile(f.manifestPath, 'utf8')).routes_v3.length, 1);
  assert.equal(JSON.parse(await fs.readFile(f.configPath, 'utf8')).sidecars[`codex-${f.projectId}`].enabled, true);
});

test('journal resumes an exact App config target completed before phase recording', async t => {
  let injected = false;
  const appConfigWriter = async args => {
    const result = await writeAppConfigTarget(args);
    if (!injected) {
      injected = true;
      const error = new Error('simulated interruption after exclusive App config write');
      error.code = 'SIMULATED_CRASH';
      throw error;
    }
    return result;
  };
  const f = await fixture(t, { appConfigWriter });
  await assert.rejects(f.registry.connect({ cwd: f.root, apply: true }), error => error.cause_code === 'SIMULATED_CRASH');
  assert.equal(injected, true);
  const journalPath = path.join(f.configDir, '.codex-antigravity-registry', 'transactions', `codex-${f.projectId}.json`);
  const journal = JSON.parse(await fs.readFile(journalPath, 'utf8'));
  assert.equal(journal.stage, 'manifest_written');
  assert.equal(journal.targets.app_config.write_started, true);
  assert.equal(typeof journal.targets.app_config.baseline_bytes_base64, 'string');
  assert.equal(typeof journal.targets.app_config.target_bytes_base64, 'string');
  const recovered = await f.registry.connect({ cwd: f.root, apply: true });
  assert.equal(recovered.state, 'configured_needs_sidecar_reload');
  assert.equal(recovered.resumed, true);
  assert.equal(JSON.parse(await fs.readFile(f.configPath, 'utf8')).sidecars[`codex-${f.projectId}`].enabled, true);
});

test('default model is explicit, provenance is honest, and updating it preserves unknown route fields', async t => {
  const f = await fixture(t);
  await f.registry.connect({ cwd: f.root, default_model: { id: 'gemini-4-argon-high', source: 'operator-selected test evidence' }, apply: true });
  const routeBefore = (await f.registry.resolveRoute({ cwd: f.root })).route;
  const heartbeatDigest = await workerConfigDigest(routeBefore);
  const manifest = JSON.parse(await fs.readFile(f.manifestPath, 'utf8'));
  manifest.routes_v3[0].operator_extension = { keep: true };
  await fs.writeFile(f.manifestPath, JSON.stringify(manifest, null, 2));
  const configured = await f.registry.setDefaultModel({ cwd: f.root, model_id: 'example-unverified-id', source: 'explicit test source' });
  assert.equal(configured.state, 'configured');
  const updated = JSON.parse(await fs.readFile(f.manifestPath, 'utf8')).routes_v3[0];
  assert.deepEqual(updated.operator_extension, { keep: true });
  assert.equal(updated.default_model.id, 'example-unverified-id');
  assert.equal(updated.default_model.source, 'explicit test source');
  assert.equal(Number.isFinite(Date.parse(updated.default_model.configured_at)), true);
  const stillReady = await f.registry.status({ cwd: f.root, workerHeartbeat: {
    sidecar_id: routeBefore.sidecar_id,
    project_id: routeBefore.project_id,
    state: 'ready',
    at: new Date().toISOString(),
    ...heartbeatDigest,
  } });
  assert.equal(stillReady.worker.state, 'verified');
  assert.equal(stillReady.worker.route_config_state, 'verified');
  assert.equal(stillReady.worker.runtime_state, 'verified');
  const catalog = await f.registry.modelCatalog({ cwd: f.root });
  assert.equal(catalog.provider, 'antigravity-agentapi');
  assert.equal(catalog.dynamic_discovery, 'unavailable');
  assert.equal(catalog.default_model.id, 'example-unverified-id');
  assert.deepEqual(catalog.models.map(model => model.id), ['gemini-4-argon-medium', 'gemini-4-argon-high', 'gemini-3.8-flash-medium']);
  assert.equal(catalog.models.every(model => model.source === 'official CLI docs' && model.agentapi_accepted === 'unknown' && model.account_observed === 'unknown'), true);
  await assert.rejects(f.registry.setDefaultModel({ cwd: f.root, model_id: '   ', source: 'explicit' }), error => error.code === 'model_default_invalid');
});

test('connecting or changing project B does not stale project A worker identity', async t => {
  const f = await fixture(t);
  await f.registry.connect({ cwd: f.root, default_model: { id: 'gemini-4-argon-medium', source: 'A fixture' }, apply: true });
  const routeA = (await f.registry.resolveRoute({ cwd: f.root })).route;
  const heartbeatA = { sidecar_id: routeA.sidecar_id, project_id: routeA.project_id, state: 'ready',
    at: new Date().toISOString(), ...(await workerConfigDigest(routeA)) };
  const rootB = path.join(f.temp, 'independent project B');
  await fs.mkdir(rootB);
  const projectB = '5bf4cb67-2b91-4e80-8ed0-cff05ded8a90';
  await fs.writeFile(path.join(f.projectsDir, `${projectB}.json`), JSON.stringify({ id: projectB,
    name: 'independent fixture project', projectResources: { resources: [{ gitFolder: { folderUri: appFileUri(rootB) } }] } }));
  await f.registry.connect({ cwd: rootB, default_model: { id: 'gemini-4-argon-high', source: 'B fixture' }, apply: true });
  await f.registry.setDefaultModel({ cwd: rootB, model_id: 'example-model-b', source: 'updated B fixture' });
  const statusA = await f.registry.status({ cwd: f.root, workerHeartbeat: heartbeatA });
  assert.equal(statusA.worker.state, 'verified');
  assert.equal(statusA.worker.route_config_state, 'verified');
  assert.equal(statusA.worker.runtime_state, 'verified');
});

test('route resolution requires exact root membership and status keeps route, App registration, and heartbeat separate', async t => {
  const f = await fixture(t, { secondRoot: true });
  await f.registry.connect({ cwd: f.root, apply: true });
  assert.equal((await f.registry.resolveRoute({ cwd: f.root })).state, 'unique_match');
  assert.equal((await f.registry.resolveRoute({ cwd: f.otherRoot })).state, 'unique_match');
  const childRoot = path.join(f.root, 'child');
  await fs.mkdir(childRoot);
  assert.equal((await f.registry.resolveRoute({ cwd: childRoot })).state, 'route_not_found');
  const unknown = await f.registry.status({ cwd: f.root });
  assert.equal(unknown.route.state, 'verified');
  assert.equal(unknown.app_registration.state, 'verified');
  assert.equal(unknown.worker.state, 'unknown');
  const stale = await f.registry.status({ cwd: f.root, workerHeartbeat: { sidecar_id: 'other', project_id: f.projectId, state: 'ready' } });
  assert.equal(stale.worker.state, 'stale');
  const route = (await f.registry.resolveRoute({ cwd: f.root })).route;
  const expected = await workerConfigDigest(route);
  const live = await f.registry.status({ cwd: f.root, workerHeartbeat: { sidecar_id: `codex-${f.projectId}`, project_id: f.projectId, state: 'ready', ...expected, last_seen_at: new Date().toISOString() } });
  assert.equal(live.worker.state, 'verified');
});


test('registered descriptor boots worker with reviewed private bindings before adapter import', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t);
  const bin = path.join(f.temp, 'fixture-bin');
  await fs.mkdir(bin);
  const native = path.join(bin, 'fixture-native.exe');
  await fs.copyFile(process.execPath, native);
  const wrapper = path.join(bin, 'agentapi.bat');
  await fs.writeFile(wrapper, `@echo off\n"${native}" agentapi %*\n`);
  const privateFile = path.join(f.temp, 'adapter.local.json');
  await fs.writeFile(privateFile, JSON.stringify({ ANTIGRAVITY_REVIEWED_WRAPPER: wrapper, ANTIGRAVITY_REVIEWED_NATIVE: native }));
  const registry = createRegistry({ manifestPath: f.manifestPath, appConfigDir: f.configDir,
    sidecarsDir: f.sidecarsDir, workerPath: path.join(componentRoot, 'worker.mjs'), nodeExecutable: process.execPath,
    localBindingsPath: privateFile });
  const result = await registry.connect({ cwd: f.root, apply: true });
  const descriptor = JSON.parse(await fs.readFile(path.join(f.sidecarsDir, result.sidecar_id, 'sidecar.json'), 'utf8'));
  assert.equal(descriptor.args[4], '--local-bindings');
  assert.equal(descriptor.args[5], privateFile);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('ANTIGRAVITY_')) delete env[key];
  await fs.cp(f.configDir, path.join(f.temp, '.gemini', 'config'), { recursive: true });
  Object.assign(env, { PATH: bin, USERPROFILE: f.temp, HOME: f.temp, ANTIGRAVITY_EXECUTABLE_DATA_DIR: f.configDir });
  const child = spawn(descriptor.command, descriptor.args, { cwd: f.root, env, windowsHide: true });
  const closed = new Promise(r => child.once('close', r));
  let stderr = ''; child.stderr.on('data', b => { stderr += b; });
  try {
    const heartbeatPath = path.join(result.route.state_root, 'runtime', 'worker-heartbeat.json');
    let heartbeat;
    for (let n = 0; n < 100; n++) {
      heartbeat = await fs.readFile(heartbeatPath, 'utf8').then(JSON.parse, () => null);
      if (heartbeat?.state === 'ready' || heartbeat?.state === 'failed') break;
      await new Promise(r => setTimeout(r, 50));
    }
    assert.equal(heartbeat?.state, 'ready', JSON.stringify(heartbeat) + stderr);
    assert.equal(heartbeat.agentapi_source, 'reviewed-app-wrapper');
  } finally {
    child.kill(); await closed;
  }
  await fs.writeFile(privateFile, '{}');
  const denied = spawnSync(descriptor.command, descriptor.args, { cwd: f.root, env, encoding: 'utf8', windowsHide: true });
  assert.notEqual(denied.status, 0);
  assert.match(denied.stderr, /binding hash changed/);
});
