import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createTaskStore, publishWorkerHeartbeat } from './task-store.mjs';
import { withFreshRuntimeGuard } from './worker.mjs';
import { workerConfigDigest } from './runtime-version.mjs';
import { acquireRouteReloadGate } from './route-work-gate.mjs';

const server = fileURLToPath(new URL('./server.mjs', import.meta.url));
const fixturePrefix = 'antigravity-gemini-v3-offline-';
const defaultModelBefore = 'gemini-fixture-default-v1';
const defaultModelAfter = 'gemini-fixture-default-v2';
const explicitModel = 'gemini-fixture-explicit';
const artifactText = '开头🙂正文。\n第二页仍保持 UTF-8：模型与证据。\n';
const artifactBytes = Buffer.from(artifactText, 'utf8');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const samePath = (left, right) => {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
};

function rpcCall(id, name, args = {}) {
  return { id, method: 'tools/call', params: { name, arguments: args } };
}

function rpcToolList(id = 2) {
  return { id, method: 'tools/list', params: {} };
}

function toolData(response, expectedError = false) {
  assert.equal(response?.result?.isError ?? false, expectedError);
  const result = response.result;
  if (result?.structuredContent !== undefined) return result.structuredContent;
  return JSON.parse(result.content[0].text);
}

async function exchange(fixture, requests) {
  const workspace = path.join(fixture, 'workspace');
  const manifest = path.join(workspace, 'bindings.json');
  const fixtureHome = fixture;
  const env = {
    ...process.env,
    HOME: fixtureHome,
    USERPROFILE: fixtureHome,
  };
  const messages = [
    { id: 1, method: 'initialize', params: {
      protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'v3-offline-test', version: '1' },
    } },
    { method: 'notifications/initialized' },
    ...requests,
  ].map(message => JSON.stringify({ jsonrpc: '2.0', ...message })).join('\n') + '\n';

  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [server, manifest], {
      cwd: workspace,
      env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill(), 15_000);
    timer.unref();
    child.stdout.setEncoding('utf8').on('data', value => { stdout += value; });
    child.stderr.setEncoding('utf8').on('data', value => { stderr += value; });
    child.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', code => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(messages);
  });

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, '');
  const responses = result.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line));
  assert.equal(responses.length, requests.length + 1, result.stdout);
  assert.equal(responses[0].id, 1);
  assert.equal(responses[0].result.protocolVersion, '2025-11-25');
  assert.deepEqual(responses.slice(1).map(response => response.id), requests.map(request => request.id));
  return new Map(responses.map(response => [response.id, response]));
}

async function snapshotFiles(root) {
  const output = new Map();
  async function visit(directory) {
    let entries;
    try { entries = await fs.readdir(directory, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) {
        const relative = path.relative(root, absolute).split(path.sep).join('/');
        output.set(relative, sha256(await fs.readFile(absolute)));
      }
    }
  }
  await visit(root);
  return output;
}

function changedFiles(before, after) {
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter(file => before.get(file) !== after.get(file))
    .sort();
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function seedLegacyDoneTask(stateRoot, requestKey) {
  const id = `codex-mcp-${requestKey}`;
  const dir = path.join(stateRoot, 'runtime', 'jobs', id);
  const nonce = randomUUID();
  const candidate = Buffer.from('既有 v1 任务产物\n', 'utf8');
  await fs.mkdir(dir, { recursive: true });
  await writeJson(path.join(dir, 'request.json'), {
    version: 1, id, nonce, prompt: 'offline legacy fixture', mode: 'technical',
    conversationId: randomUUID(),
  });
  await writeJson(path.join(dir, 'attempt.json'), { attempt: 1 });
  await fs.writeFile(path.join(dir, 'candidate.md'), candidate);
  await writeJson(path.join(dir, 'completion.json'), { version: 1, id, nonce, status: 'done' });
  return { id, dir, candidate };
}

async function publishV3Receipt(route, requestKey, text) {
  const id = `codex-mcp-${requestKey}`;
  const taskDir = path.join(route.state_root, 'runtime', 'turns', id);
  const request = await readJson(path.join(taskDir, 'request.json'));
  const candidate = Buffer.from(text, 'utf8');
  await fs.writeFile(path.join(taskDir, 'candidate.md'), candidate);
  await writeJson(path.join(taskDir, 'completion.json'), {
    version: 3,
    id,
    nonce: request.nonce,
    status: 'done',
    artifacts: [{ name: 'candidate.md', relative_path: 'candidate.md', mime_type: 'text/markdown' }],
  });
  return { request, candidate };
}

async function removeFixture(fixture) {
  const real = await fs.realpath(fixture);
  const parent = await fs.realpath(path.dirname(fixture));
  assert.equal(path.dirname(real), parent);
  assert.ok(path.basename(real).startsWith(fixturePrefix));
  await fs.rm(real, { recursive: true });
}

test('the worker refuses every App-native method before runtime verification succeeds', async () => {
  const calls = [];
  const provider = Object.fromEntries(['verifyRegistration', 'metadata', 'progress', 'observe', 'dispatch']
    .map(name => [name, async () => { calls.push(name); return name; }]));
  const stale = withFreshRuntimeGuard(provider, async () => { throw new Error('worker_runtime_stale'); });
  for (const name of Object.keys(provider)) {
    await assert.rejects(() => stale[name]('fixture'), /worker_runtime_stale/);
  }
  assert.deepEqual(calls, []);
  const current = withFreshRuntimeGuard(provider, async () => {});
  assert.equal(await current.dispatch('fixture'), 'dispatch');
  assert.deepEqual(calls, ['dispatch']);
});

test('the worker rechecks App project ownership immediately before each provider operation', async () => {
  const calls = [];
  let owned = false;
  let ownershipChecks = 0;
  const provider = { async dispatch() { calls.push('dispatch'); return 'sent'; } };
  const guarded = withFreshRuntimeGuard(provider, async () => {}, async () => {
    ownershipChecks += 1;
    if (!owned) throw new Error('app_registration_changed');
  });
  await assert.rejects(() => guarded.dispatch(), /app_registration_changed/);
  assert.equal(ownershipChecks, 1);
  assert.deepEqual(calls, [], 'native provider must not run after project ownership verification fails');
  owned = true;
  assert.equal(await guarded.dispatch(), 'sent');
  assert.equal(ownershipChecks, 2);
  assert.deepEqual(calls, ['dispatch']);
});

test('v3 stdio routes additively to v1 manifests and round-trip tasks without real App or model access', async () => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), fixturePrefix));
  try {
    const workspace = path.join(fixture, 'workspace');
    const legacyWorkspace = path.join(fixture, 'legacy-workspace');
    const appConfigDir = path.join(fixture, '.gemini', 'config');
    const projectsDir = path.join(appConfigDir, 'projects');
    const sidecarsDir = path.join(appConfigDir, 'sidecars');
    const manifestPath = path.join(workspace, 'bindings.json');
    const projectId = randomUUID();
    const oldProjectId = randomUUID();
    const oldConversationId = randomUUID();
    const legacyBinding = {
      workspace_root: legacyWorkspace,
      sidecar_root: path.join(legacyWorkspace, 'sidecar'),
      project_id: oldProjectId,
      conversation_id: oldConversationId,
      sidecar_id: 'legacy-sidecar',
      preserved_fixture_field: 'legacy-v1-binding',
    };
    const project = {
      id: projectId,
      name: 'Isolated v3 fixture',
      projectResources: { resources: [{ gitFolder: { folderUri: pathToFileURL(workspace).href } }] },
    };
    const originalManifest = { version: 1, bindings: [legacyBinding] };
    const originalConfig = {
      fixture_setting: { preserve: true },
      sidecars: { 'keep-sidecar': { enabled: false, projectId: oldProjectId, preserve: 'existing' } },
    };
    const keepDescriptor = { command: 'leave-this-sidecar-alone', extra: 'preserve' };

    await Promise.all([
      fs.mkdir(workspace, { recursive: true }),
      fs.mkdir(legacyWorkspace, { recursive: true }),
      fs.mkdir(projectsDir, { recursive: true }),
      fs.mkdir(path.join(sidecarsDir, 'keep-sidecar'), { recursive: true }),
    ]);
    const realWorkspace = await fs.realpath(workspace);
    await writeJson(path.join(projectsDir, `${projectId}.json`), project);
    await writeJson(path.join(appConfigDir, 'config.json'), originalConfig);
    await writeJson(path.join(sidecarsDir, 'keep-sidecar', 'sidecar.json'), keepDescriptor);
    await writeJson(manifestPath, originalManifest);

    const initialSnapshot = await snapshotFiles(fixture);
    const first = await exchange(fixture, [rpcToolList(), rpcCall(3, 'project_catalog')]);
    const listedTools = first.get(2).result.tools.map(tool => tool.name);
    for (const name of [
      'project_catalog', 'connect_project', 'binding_status', 'model_catalog', 'start_chat',
      'job_status', 'read_task_artifact', 'continue_chat',
    ]) assert.ok(listedTools.includes(name), `tools/list omitted ${name}`);
    const catalog = toolData(first.get(3));
    assert.equal(catalog.state, 'unique_match');
    assert.equal(catalog.candidates.length, 1);
    assert.equal(catalog.candidates[0].project_id, projectId);
    assert.equal(catalog.candidates[0].resource_roots[0].kind, 'gitFolder');
    assert.equal(catalog.candidates[0].resource_roots[0].path, await fs.realpath(workspace));

    const previewResponse = await exchange(fixture, [rpcCall(2, 'connect_project', {
      project_id: projectId, default_model: defaultModelBefore, apply: false,
    })]);
    const preview = toolData(previewResponse.get(2));
    assert.equal(preview.state, 'dry_run');
    assert.deepEqual(changedFiles(initialSnapshot, await snapshotFiles(fixture)), []);
    assert.deepEqual(preview.targets.map(target => target.name).sort(), ['app_config', 'descriptor', 'manifest']);
    assert.ok(preview.targets.every(target => target.changed));

    const applyResponse = await exchange(fixture, [rpcCall(2, 'connect_project', {
      project_id: projectId, default_model: defaultModelBefore, apply: true,
    })]);
    const applied = toolData(applyResponse.get(2));
    assert.equal(applied.state, 'configured_needs_sidecar_reload');
    assert.equal(applied.project_id, projectId);
    assert.ok(samePath(applied.state_root, path.join(realWorkspace, '.antigravity-gemini-mcp')));
    const afterApplySnapshot = await snapshotFiles(fixture);
    const changed = changedFiles(initialSnapshot, afterApplySnapshot);
    const transactionMetadataPrefix = '.gemini/config/.codex-antigravity-registry/';
    const registrationChanges = changed.filter(file => !file.startsWith(transactionMetadataPrefix));
    assert.deepEqual(registrationChanges, [
      '.gemini/config/config.json',
      `.gemini/config/sidecars/codex-${projectId}/sidecar.json`,
      'workspace/bindings.json',
    ].sort());
    assert.deepEqual(await readJson(path.join(projectsDir, `${projectId}.json`)), project);
    assert.deepEqual(await readJson(path.join(sidecarsDir, 'keep-sidecar', 'sidecar.json')), keepDescriptor);
    const connectedConfig = await readJson(path.join(appConfigDir, 'config.json'));
    assert.deepEqual(connectedConfig.fixture_setting, originalConfig.fixture_setting);
    assert.deepEqual(connectedConfig.sidecars['keep-sidecar'], originalConfig.sidecars['keep-sidecar']);
    assert.equal(connectedConfig.sidecars[`codex-${projectId}`].enabled, true);
    assert.equal(connectedConfig.sidecars[`codex-${projectId}`].projectId, projectId);

    let manifest = await readJson(manifestPath);
    assert.equal(manifest.version, 1);
    assert.deepEqual(manifest.bindings, originalManifest.bindings);
    assert.equal(manifest.routes_v3.length, 1);
    let route = manifest.routes_v3[0];
    assert.equal(route.project_id, projectId);
    assert.equal(route.default_model.id, defaultModelBefore);
    assert.equal(route.workspace_roots.length, 1);
    assert.equal(route.workspace_roots[0].path, await fs.realpath(workspace));
    assert.ok(samePath(route.state_root, path.join(realWorkspace, '.antigravity-gemini-mcp')));
    assert.ok(!Object.hasOwn(route, 'conversation_id'), 'v3 route unexpectedly requires a legacy anchor conversation');

    const statusResponse = await exchange(fixture, [
      rpcCall(2, 'binding_status'),
      rpcCall(3, 'model_catalog'),
    ]);
    const bindingStatus = toolData(statusResponse.get(2));
    const models = toolData(statusResponse.get(3));
    assert.equal(bindingStatus.route.state, 'verified');
    assert.equal(bindingStatus.app_registration.state, 'verified');
    assert.equal(bindingStatus.worker.state, 'unknown');
    assert.equal(models.default_model.id, defaultModelBefore);
    assert.equal(models.dynamic_discovery, 'unavailable');

    const legacy = await seedLegacyDoneTask(route.state_root, randomUUID());
    const legacyBefore = await snapshotFiles(legacy.dir);
    const legacyStatusResponse = await exchange(fixture, [rpcCall(2, 'job_status', {
      request_key: path.basename(legacy.id).slice('codex-mcp-'.length),
    })]);
    const legacyStatus = toolData(legacyStatusResponse.get(2));
    assert.equal(legacyStatus.state, 'done');
    assert.equal(legacyStatus.legacy_protocol, 1);
    assert.equal(legacyStatus.candidateBytes, legacy.candidate.length);
    assert.equal(legacyStatus.candidateSha256, sha256(legacy.candidate));
    assert.deepEqual(await snapshotFiles(legacy.dir), legacyBefore, 'legacy status read changed its old job files');

    const staleNoHeartbeatKey = randomUUID();
    const staleNoHeartbeat = await exchange(fixture, [rpcCall(2, 'start_chat', {
      request_key: staleNoHeartbeatKey, prompt: 'Must not be accepted without a loaded worker.', model_id: explicitModel,
    })]);
    const staleNoHeartbeatError = toolData(staleNoHeartbeat.get(2), true);
    assert.equal(staleNoHeartbeatError.code, 'worker_not_ready');
    assert.equal(await fs.stat(path.join(route.state_root, 'runtime', 'turns', `codex-mcp-${staleNoHeartbeatKey}`)).then(() => true, () => false), false,
      'an unready worker must be rejected before request files are created');

    const currentWorkerDigest = await workerConfigDigest(route);
    const publishFixtureHeartbeat = async runtimeSha256 => {
      const heartbeatRuntime = runtimeSha256 ?? currentWorkerDigest.runtime_sha256;
      return publishWorkerHeartbeat(route, 'ready', {
        ...currentWorkerDigest,
        runtime_sha256: heartbeatRuntime,
        ...(runtimeSha256 ? { digest: sha256(`${currentWorkerDigest.worker_config_sha256}:${runtimeSha256}`) } : {}),
        manifest_sha256: sha256(await fs.readFile(manifestPath)),
        app_registration: 'verified', agentapi_source: 'offline-fixture',
      });
    };
    const staleRuntimeKey = randomUUID();
    await publishFixtureHeartbeat('0'.repeat(64));
    const staleRuntime = await exchange(fixture, [rpcCall(2, 'start_chat', {
      request_key: staleRuntimeKey, prompt: 'Must not queue against stale runtime.', model_id: explicitModel,
    })]);
    const staleRuntimeError = toolData(staleRuntime.get(2), true);
    assert.equal(staleRuntimeError.code, 'worker_not_ready');
    const staleObservationId = randomUUID();
    const staleObservation = await exchange(fixture, [rpcCall(2, 'conversation_status', {
      conversation_id: staleObservationId, wait_ms: 0,
    })]);
    assert.equal(toolData(staleObservation.get(2), true).code, 'worker_not_ready');
    assert.equal(await fs.stat(path.join(route.state_root, 'runtime', 'conversation-observations', staleObservationId, 'request.json'))
      .then(() => true, () => false), false, 'stale workers must not accept native observation work');
    const staleStatus = await exchange(fixture, [rpcCall(2, 'binding_status')]);
    assert.equal(toolData(staleStatus.get(2)).worker.runtime_state, 'stale');
    assert.equal(await fs.stat(path.join(route.state_root, 'runtime', 'turns', `codex-mcp-${staleRuntimeKey}`)).then(() => true, () => false), false,
      'runtime mismatch must be rejected before request files are created');
    await publishFixtureHeartbeat();

    const invalidModels = ['', null, false, 0];
    const invalidModelCalls = invalidModels.flatMap((model_id, index) => {
      const request_key = randomUUID();
      return [
        rpcCall(30 + index * 2, 'start_chat', { request_key, prompt: 'Invalid explicit model must not fall back.', model_id }),
        rpcCall(31 + index * 2, 'submit_review', { request_key: randomUUID(), prompt: 'Invalid explicit review model.', model_id }),
      ];
    });
    const beforeInvalidModels = await snapshotFiles(path.join(route.state_root, 'runtime', 'turns'));
    const invalidModelResponse = await exchange(fixture, invalidModelCalls);
    for (const request of invalidModelCalls) {
      const error = toolData(invalidModelResponse.get(request.id), true);
      assert.equal(error.code, 'model_id_invalid');
      assert.equal(error.stage, 'input_validation');
    }
    assert.deepEqual(await snapshotFiles(path.join(route.state_root, 'runtime', 'turns')), beforeInvalidModels,
      'invalid explicit model values must not create task records or fall back to the route default');

    const providerStats = { verifyCreation: 0, dispatches: [], metadata: 0, progress: 0 };
    const fakeProvider = {
      async verifyCreation(...args) {
        providerStats.verifyCreation += 1;
        assert.equal(args.length, 0);
      },
      async dispatch(request, message) {
        const conversationId = randomUUID();
        providerStats.dispatches.push({ request, message, conversationId });
        return { acknowledged: true, conversation_id: conversationId };
      },
      async metadata(conversationId) {
        providerStats.metadata += 1;
        assert.ok(providerStats.dispatches.some(item => item.conversationId === conversationId));
        return { observed_model: 'fixture-observed-model' };
      },
      async progress() {
        providerStats.progress += 1;
        return { state: 'running', request_observed: false };
      },
    };

    const explicitKey = randomUUID();
    const explicitArgs = {
      request_key: explicitKey,
      prompt: 'Create a short offline fixture result.',
      model_id: explicitModel,
    };
    const explicitQueuedResponse = await exchange(fixture, [rpcCall(2, 'start_chat', explicitArgs)]);
    const explicitQueued = toolData(explicitQueuedResponse.get(2));
    assert.equal(explicitQueued.state, 'queued');
    assert.equal(explicitQueued.duplicate, false);
    assert.equal(explicitQueued.requested_model, explicitModel);
    assert.equal(providerStats.dispatches.length, 0, 'MCP submission dispatched without the App worker');
    const explicitId = `codex-mcp-${explicitKey}`;
    const explicitTaskPath = path.join(route.state_root, 'runtime', 'turns', explicitId);
    const explicitRequest = await readJson(path.join(explicitTaskPath, 'request.json'));
    assert.equal(explicitRequest.version, 3);
    assert.equal(explicitRequest.requested_model, explicitModel);
    assert.equal(explicitRequest.model_source, 'explicit');
    assert.equal(explicitRequest.origin_workspace_root, await fs.realpath(workspace));
    assert.ok(!Object.hasOwn(explicitRequest, 'conversation_id'), 'new chat request unexpectedly needs an anchor');

    await publishFixtureHeartbeat('0'.repeat(64));
    const configBeforeRefusedReload = await fs.readFile(path.join(appConfigDir, 'config.json'));
    const refusedReload = await exchange(fixture, [rpcCall(2, 'reload_worker')]);
    const refusedReloadError = toolData(refusedReload.get(2), true);
    assert.equal(refusedReloadError.code, 'worker_tasks_unsettled');
    assert.deepEqual(await fs.readFile(path.join(appConfigDir, 'config.json')), configBeforeRefusedReload,
      'reload must not toggle the App registration while a task remains queued');
    await publishFixtureHeartbeat();

    await publishFixtureHeartbeat('0'.repeat(64));
    const staleReplayResponse = await exchange(fixture, [rpcCall(2, 'start_chat', explicitArgs)]);
    const staleReplay = toolData(staleReplayResponse.get(2));
    assert.equal(staleReplay.duplicate, true, 'same-key replay must still read its original task while the worker is stale');
    await publishFixtureHeartbeat();

    const store = createTaskStore(route, fakeProvider);
    await store.pump(fakeProvider);
    assert.equal(providerStats.verifyCreation, 1);
    assert.equal(providerStats.dispatches.length, 1);
    assert.equal(providerStats.metadata, 1);
    assert.equal(providerStats.progress, 1);
    assert.equal(providerStats.dispatches[0].request.requested_model, explicitModel);
    assert.equal(providerStats.dispatches[0].request.conversation_id, undefined);
    const runningResponse = await exchange(fixture, [rpcCall(2, 'job_status', { request_key: explicitKey })]);
    const running = toolData(runningResponse.get(2));
    assert.equal(running.state, 'running_app');
    assert.equal(running.conversation_id, providerStats.dispatches[0].conversationId);
    assert.equal(running.observed_model, 'fixture-observed-model');

    const explicitReceipt = await publishV3Receipt(route, explicitKey, artifactText);
    assert.equal(explicitReceipt.request.nonce, explicitRequest.nonce);
    await store.pump(fakeProvider);
    const doneResponse = await exchange(fixture, [rpcCall(2, 'job_status', { request_key: explicitKey })]);
    const done = toolData(doneResponse.get(2));
    assert.equal(done.state, 'done');
    assert.equal(done.candidateSha256, sha256(artifactBytes));
    assert.deepEqual(done.artifacts.map(({ name, relative_path, mime_type, bytes, sha256: hash }) => ({
      name, relative_path, mime_type, bytes, sha256: hash,
    })), [{
      name: 'candidate.md', relative_path: 'artifact/candidate.md', mime_type: 'text/markdown',
      bytes: artifactBytes.length, sha256: sha256(artifactBytes),
    }]);

    let offset = 0;
    let assembled = '';
    let pages = 0;
    while (true) {
      const pageResponse = await exchange(fixture, [rpcCall(2, 'read_task_artifact', {
        request_key: explicitKey, name: 'candidate.md', offset_bytes: offset, length_bytes: 5,
      })]);
      const page = toolData(pageResponse.get(2));
      assert.equal(page.state, 'done');
      assert.equal(page.name, 'candidate.md');
      assert.equal(page.mime_type, 'text/markdown');
      assert.equal(page.total_bytes, artifactBytes.length);
      assert.equal(page.sha256, sha256(artifactBytes));
      assert.equal(page.content_encoding, 'utf-8');
      assert.equal(page.offset, offset);
      assert.ok(page.next_offset > offset, 'artifact paging made no progress');
      assert.equal(Buffer.from(page.content, 'utf8').toString('utf8'), page.content);
      const exactBytes = artifactBytes.subarray(page.offset, page.next_offset);
      assert.equal(exactBytes.toString('utf8'), page.content, 'page split or skipped a UTF-8 code point');
      assembled += page.content;
      pages += 1;
      offset = page.next_offset;
      if (page.eof) break;
      assert.ok(pages < 20, 'artifact pages did not reach EOF');
    }
    assert.ok(pages > 1);
    assert.equal(assembled, artifactText);
    assert.equal(sha256(Buffer.from(assembled, 'utf8')), sha256(artifactBytes));

    const explicitReplayResponse = await exchange(fixture, [rpcCall(2, 'start_chat', explicitArgs)]);
    const explicitReplay = toolData(explicitReplayResponse.get(2));
    assert.equal(explicitReplay.duplicate, true);
    assert.equal(explicitReplay.requested_model, explicitModel);
    assert.equal(providerStats.dispatches.length, 1, 'same-key replay created another App dispatch');

    const defaultKey = randomUUID();
    const defaultArgs = { request_key: defaultKey, prompt: 'Use the configured default model.' };
    const defaultQueuedResponse = await exchange(fixture, [rpcCall(2, 'start_chat', defaultArgs)]);
    const defaultQueued = toolData(defaultQueuedResponse.get(2));
    assert.equal(defaultQueued.state, 'queued');
    assert.equal(defaultQueued.requested_model, defaultModelBefore);
    const defaultTaskDir = path.join(route.state_root, 'runtime', 'turns', `codex-mcp-${defaultKey}`);
    const defaultRequest = await readJson(path.join(defaultTaskDir, 'request.json'));
    assert.equal(defaultRequest.requested_model, defaultModelBefore);
    assert.equal(defaultRequest.model_source, 'explicit connect_project configuration');
    assert.ok(!Object.hasOwn(defaultRequest, 'conversation_id'));

    await store.pump(fakeProvider);
    assert.equal(providerStats.dispatches.length, 2);
    const changedDefaultResponse = await exchange(fixture, [rpcCall(2, 'connect_project', {
      project_id: projectId, default_model: defaultModelAfter, apply: true,
    })]);
    const changedDefault = toolData(changedDefaultResponse.get(2));
    assert.equal(changedDefault.project_id, projectId);
    manifest = await readJson(manifestPath);
    route = manifest.routes_v3[0];
    assert.equal(route.default_model.id, defaultModelAfter);
    const changedCatalogResponse = await exchange(fixture, [rpcCall(2, 'model_catalog')]);
    assert.equal(toolData(changedCatalogResponse.get(2)).default_model.id, defaultModelAfter);

    const defaultReplayResponse = await exchange(fixture, [rpcCall(2, 'start_chat', defaultArgs)]);
    const defaultReplay = toolData(defaultReplayResponse.get(2));
    assert.equal(defaultReplay.duplicate, true);
    assert.equal(defaultReplay.requested_model, defaultModelBefore);
    const frozenRequest = await readJson(path.join(defaultTaskDir, 'request.json'));
    assert.equal(frozenRequest.requested_model, defaultModelBefore);
    const updatedStore = createTaskStore(route, fakeProvider);
    await updatedStore.pump(fakeProvider);
    assert.equal(providerStats.dispatches.length, 2, 'default change or same-key retry resent the existing task');

    const defaultReceipt = await publishV3Receipt(route, defaultKey, '默认模型任务已完成。\n');
    assert.equal(defaultReceipt.request.nonce, defaultRequest.nonce);
    await updatedStore.pump(fakeProvider);
    const defaultDoneResponse = await exchange(fixture, [rpcCall(2, 'job_status', { request_key: defaultKey })]);
    const defaultDone = toolData(defaultDoneResponse.get(2));
    assert.equal(defaultDone.state, 'done');
    assert.equal(defaultDone.requested_model, defaultModelBefore);
    assert.equal(providerStats.dispatches.length, 2);

    const releaseReload = await acquireRouteReloadGate(route);
    const blockedKey = randomUUID();
    const blockedConversation = randomUUID();
    try {
      const whileReloading = await exchange(fixture, [
        rpcCall(2, 'start_chat', { request_key: blockedKey, prompt: 'Must wait for route reload.' }),
        rpcCall(3, 'conversation_status', { conversation_id: blockedConversation, wait_ms: 0 }),
        rpcCall(4, 'start_chat', explicitArgs),
        rpcCall(5, 'job_status', { request_key: explicitKey }),
      ]);
      assert.equal(toolData(whileReloading.get(2), true).code, 'worker_reload_in_progress');
      assert.equal(toolData(whileReloading.get(3), true).code, 'worker_reload_in_progress');
      assert.equal(toolData(whileReloading.get(4)).duplicate, true,
        'same-key replay remains readable while new acceptance is paused');
      assert.equal(toolData(whileReloading.get(5)).state, 'done', 'task status remains readable during reload');
      assert.equal(await fs.stat(path.join(route.state_root, 'runtime', 'turns', `codex-mcp-${blockedKey}`))
        .then(() => true, () => false), false);
      assert.equal(await fs.stat(path.join(route.state_root, 'runtime', 'conversation-observations', blockedConversation, 'request.json'))
        .then(() => true, () => false), false);
    } finally { await releaseReload(); }
  } finally {
    await removeFixture(fixture);
  }
});
