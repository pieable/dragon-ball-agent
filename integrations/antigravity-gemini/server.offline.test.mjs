import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { hash, isTurnPending, nativeCommandTimeoutMs, turnStore, waitFor } from './turns.mjs';
import { nativeChat, transcriptSummary, verifyRegistration } from './native-chat.mjs';

const server = fileURLToPath(new URL('./server.mjs', import.meta.url));
const diagnostic = fileURLToPath(new URL('./diagnose-binding.mjs', import.meta.url));
const sourceSidecar = process.argv[2] ?? fileURLToPath(new URL('./live2d-sidecar/', import.meta.url));
const fixtureParent = os.tmpdir();

async function exchange(workspace, manifest, requests) {
  const processResult = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [server, manifest], { cwd: workspace, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', value => { stdout += value; });
    child.stderr.setEncoding('utf8').on('data', value => { stderr += value; });
    child.on('error', reject).on('close', code => resolve({ stdout, stderr, code }));
    const messages = [
      { id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'offline-test', version: '1' } } },
      { method: 'notifications/initialized' },
      ...requests,
    ];
    child.stdin.end(messages.map(message => JSON.stringify({ jsonrpc: '2.0', ...message })).join('\n') + '\n');
  });
  assert.equal(processResult.code, 0, processResult.stderr);
  assert.equal(processResult.stderr, '');
  const [handshake, ...results] = processResult.stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(handshake.id, 1);
  assert.equal(handshake.result.protocolVersion, '2025-11-25');
  assert.match(handshake.result.instructions, /Project artifact tools use the verified workspace route/);
  assert.deepEqual(results.map(result => result.id), requests.map(request => request.id));
  return results.map(({ result }) => result);
}

function call(id, name, args) {
  return { id, method: 'tools/call', params: { name, arguments: args } };
}

function data(result, isError = false) {
  assert.equal(result.isError, isError);
  return JSON.parse(result.content[0].text);
}

test('isolated MCP stdio round trip uses the established queue without dispatching to Antigravity', async () => {
  assert.ok(sourceSidecar, 'Pass the source app-sidecar directory as the first argument.');
  const fixture = await fs.mkdtemp(path.join(fixtureParent, 'antigravity-mcp-offline-'));
  try {
    const workspace = path.join(fixture, 'bound-workspace');
    const otherWorkspace = path.join(fixture, 'other-workspace');
    const root = path.join(workspace, 'sidecar');
    const manifest = path.join(fixture, 'bindings.json');
    await fs.mkdir(root, { recursive: true });
    await fs.mkdir(otherWorkspace);
    const protocolPath = path.join(root, 'protocol.mjs');
    await fs.writeFile(protocolPath, (await fs.readFile(path.join(sourceSidecar, 'protocol.mjs'), 'utf8')).replace("process.env.ANTIGRAVITY_CONVERSATION_ID ?? ''", JSON.stringify(randomUUID())));
    const protocol = await import(pathToFileURL(protocolPath));
    const binding = { workspace_root: workspace, sidecar_root: root, project_id: randomUUID(), conversation_id: protocol.CONVERSATION_ID };
    const writeManifest = bindings => fs.writeFile(manifest, JSON.stringify({ version: 1, bindings }));
    await writeManifest([binding]);
    const metadataPath = path.join(fixture, 'raw-metadata.json');
    const fakeAgentapi = path.join(fixture, 'fake-agentapi.mjs');
    await fs.writeFile(fakeAgentapi, `import { readFile } from 'node:fs/promises';
if (process.argv[2] !== 'get-conversation-metadata' || process.argv[3] !== ${JSON.stringify(binding.conversation_id)}) process.exit(1);
process.stdout.write(await readFile(${JSON.stringify(metadataPath)}));
`);
    await fs.writeFile(path.join(root, 'official-agentapi.mjs'), `export const EXPECTED_PROJECT_ID = ${JSON.stringify(binding.project_id)};
export const EXPECTED_WORKSPACE = ${JSON.stringify(workspace)};
export const resolveAgentapi = async () => ({ file: process.execPath, source: 'offline-fixture' });
export const nativeArgv = (executable, args) => [${JSON.stringify(fakeAgentapi)}, ...args];
`);
    const identityPath = path.join(root, 'native-identity-result.json');
    const writeMetadata = projectId => fs.writeFile(metadataPath, JSON.stringify({ response: { conversationMetadata: { metadata: {
      projectId, rootConversationId: binding.conversation_id,
      workspaces: [{ workspaceFolderAbsoluteUri: pathToFileURL(workspace).href }],
    } } } }));
    const diagnose = () => promisify(execFile)(process.execPath, [diagnostic, root], {
      env: { ...process.env, ANTIGRAVITY_EXECUTABLE_DATA_DIR: fixture }, windowsHide: true,
    });
    await writeMetadata(randomUUID());
    await assert.rejects(diagnose(), /Observed Antigravity project/);
    assert.equal((await protocol.readJson(identityPath)).state, 'failed');
    await writeMetadata(binding.project_id);
    await diagnose();
    const identity = await protocol.readJson(identityPath);
    assert.equal(identity.version, 2);
    assert.equal(identity.check.observed_binding.project_id, binding.project_id);
    assert.equal(identity.check.stdoutSha256, protocol.digest(await fs.readFile(metadataPath)));
    await writeMetadata(randomUUID());
    await assert.rejects(diagnose(), /Observed Antigravity project/);
    const [recheckFailed] = await exchange(workspace, manifest, [call(2, 'binding_status')]);
    assert.match(data(recheckFailed, true).error, /no successful/);
    await writeMetadata(binding.project_id);
    await diagnose();
    const imagePath = path.join(workspace, '示例 image.png');
    await fs.writeFile(imagePath, Buffer.from('89504e470d0a1a0a00000000', 'hex'));
    const spoofedPath = path.join(workspace, 'text.png');
    const outsideImage = path.join(otherWorkspace, 'other.png');
    await fs.copyFile(imagePath, outsideImage);
    await fs.writeFile(spoofedPath, 'This is text.');
    const requestKey = randomUUID();
    const jobId = `codex-mcp-${requestKey}`;
    const args = { request_key: requestKey, prompt: '对比眼睛', image_paths: [imagePath] };
    await protocol.submit(root, 'existing-writer', 'Old project content', 'writer');

    const [unbound, forbidden] = await exchange(otherWorkspace, manifest, [
      call(2, 'binding_status'), call(3, 'submit_review', args),
    ]);
    assert.equal(data(unbound).state, 'unbound');
    assert.match(data(forbidden, true).error, /No Antigravity binding/);

    await writeManifest([{ ...binding, workspace_root: otherWorkspace }]);
    const [wrongRoot] = await exchange(otherWorkspace, manifest, [call(2, 'submit_review', args)]);
    assert.match(data(wrongRoot, true).error, /Sidecar resolves outside/);
    await writeManifest([{ ...binding, conversation_id: randomUUID() }]);
    const [wrongConversation] = await exchange(workspace, manifest, [call(2, 'submit_review', args)]);
    assert.match(data(wrongConversation, true).error, /does not match/);
    await writeManifest([binding, { ...binding, workspace_root: otherWorkspace, conversation_id: randomUUID() }]);
    const [sharedProject] = await exchange(workspace, manifest, [call(2, 'submit_review', args)]);
    assert.match(data(sharedProject, true).error, /project cannot serve multiple/);
    await writeManifest([binding]);
    const editedLegacy = { version: 1, appRuntimePresent: true, observedAt: identity.observedAt, verified_binding: binding,
      checks: [{ command: 'get-conversation-metadata', exitCode: 0, metadata: { projectMatches: true, rootConversationMatches: true, workspaceMatches: true } }] };
    await fs.writeFile(identityPath, JSON.stringify(editedLegacy));
    const [unverified] = await exchange(workspace, manifest, [call(2, 'submit_review', args)]);
    assert.match(data(unverified, true).error, /no successful/);
    await fs.writeFile(identityPath, JSON.stringify({ ...identity,
      check: { ...identity.check, observed_binding: { ...identity.check.observed_binding, project_id: randomUUID() } } }));
    const [mismatchedEvidence] = await exchange(workspace, manifest, [call(2, 'submit_review', args)]);
    assert.match(data(mismatchedEvidence, true).error, /Recorded identity evidence/);
    await fs.writeFile(identityPath, JSON.stringify(identity));

    const [list, bound, oldJob, relative, spoofed, outside, override, unsupportedModel, queued, duplicate, collision, status] = await exchange(workspace, manifest, [
      { id: 2, method: 'tools/list' },
      call(3, 'binding_status', {}),
      call(4, 'job_status', { request_key: 'existing-writer' }),
      call(5, 'submit_review', { ...args, image_paths: ['relative.png'] }),
      call(6, 'submit_review', { ...args, image_paths: [spoofedPath] }),
      call(7, 'submit_review', { ...args, image_paths: [outsideImage] }),
      call(8, 'submit_review', { ...args, workspace_root: otherWorkspace }),
      call(9, 'submit_review', { ...args, model_id: 'gemini-3.8-flash-medium' }),
      call(10, 'submit_review', args),
      call(11, 'submit_review', args),
      call(12, 'submit_review', { ...args, prompt: 'different review' }),
      call(13, 'job_status', { request_key: requestKey }),
    ]);
    assert.deepEqual(list.tools.map(tool => tool.name), ['project_catalog', 'connect_project', 'binding_status', 'reload_worker', 'submit_review', 'model_catalog', 'read_task_artifact', 'job_status', 'start_chat', 'continue_chat', 'send_message', 'read_conversation', 'conversation_status', 'cancel_job', 'takeover_job']);
    assert.match(list.tools.find(tool => tool.name === 'submit_review').description, /OpenAI Codex.*challenge unsupported claims/);
    assert.equal('maxLength' in list.tools.find(tool => tool.name === 'submit_review').inputSchema.properties.prompt, false);
    assert.equal(data(bound).state, 'bound');
    assert.equal(data(bound).conversation_id, protocol.CONVERSATION_ID);
    assert.match(data(oldJob, true).error, /UUID/);
    assert.match(data(relative, true).error, /absolute local/);
    assert.match(data(spoofed, true).error, /signature/);
    assert.match(data(outside, true).error, /inside the bound/);
    assert.match(data(override, true).error, /Unexpected tool argument/);
    assert.equal(data(unsupportedModel, true).code, 'legacy_model_selection_unsupported');
    assert.deepEqual(data(queued), { id: jobId, state: 'queued', duplicate: false, conversation_id: protocol.CONVERSATION_ID });
    assert.equal(data(duplicate).duplicate, true);
    assert.match(data(collision, true).error, /different prompt/);
    assert.equal(data(status).state, 'queued');

    const jobs = path.join(root, 'runtime', 'jobs');
    assert.deepEqual((await fs.readdir(jobs)).sort(), [jobId, 'existing-writer'].sort());
    const dir = path.join(jobs, jobId);
    assert.deepEqual(await fs.readdir(dir), ['request.json']);
    const request = await protocol.readJson(path.join(dir, 'request.json'));
    assert.equal(request.mode, 'technical');
    assert.match(request.prompt, /^发件方：我是 OpenAI Codex，是 AI 助手。/);
    assert.match(request.prompt, /主动找反例.*证据不足/);
    assert.ok(request.prompt.includes(JSON.stringify([await fs.realpath(imagePath)])));
    assert.ok(request.prompt.endsWith('Review brief:\n对比眼睛'));

    const oldDir = path.join(jobs, 'existing-writer');
    const oldRequest = await protocol.readJson(path.join(oldDir, 'request.json'));
    const complete = async (directory, record, contents) => {
      await fs.writeFile(path.join(directory, 'candidate.md'), contents);
      await protocol.publishJson(path.join(directory, 'completion.json'), { version: 1, id: record.id, nonce: record.nonce, status: 'done' });
    };
    await protocol.pump(root, async () => { await complete(oldDir, oldRequest, 'Old result'); return { code: 0 }; });
    await protocol.pump(root, async (conversation, message) => {
      assert.equal(conversation, protocol.CONVERSATION_ID);
      assert.ok(message.includes(path.join(dir, 'request.json')));
      return { code: 0 };
    });
    const [unknown] = await exchange(workspace, manifest, [call(2, 'job_status', { request_key: requestKey })]);
    assert.equal(data(unknown).state, 'completion_unknown');

    const expected = '# 画面审稿\n闭眼线条更平。';
    await complete(dir, request, expected);
    const [done] = await exchange(workspace, manifest, [call(2, 'job_status', { request_key: requestKey })]);
    assert.equal(data(done).state, 'done');
    assert.equal(data(done).candidate_markdown, expected);
    assert.equal(data(done).candidateSha256, protocol.digest(expected));
    assert.equal(data(done).candidate_path, path.join(dir, 'candidate.md'));

    const legacyKey = randomUUID();
    const legacyId = `codex-mcp-${legacyKey}`;
    const legacyBody = request.prompt.slice(request.prompt.indexOf('Perform this independent technical review'));
    await protocol.submit(root, legacyId, legacyBody, 'technical');
    const legacyPath = path.join(jobs, legacyId, 'request.json');
    const originalBytes = await fs.readFile(legacyPath);
    const [legacyRetry, legacyCollision] = await exchange(workspace, manifest, [
      call(2, 'submit_review', { ...args, request_key: legacyKey }),
      call(3, 'submit_review', { ...args, request_key: legacyKey, prompt: 'different review' }),
    ]);
    assert.equal(data(legacyRetry).duplicate, true);
    assert.match(data(legacyCollision, true).error, /different prompt/);
    assert.deepEqual(await fs.readFile(legacyPath), originalBytes);
  } finally {
    // Delete only the isolated fixture directory created by this test invocation.
    const resolvedRoot = await fs.realpath(fixture);
    const resolvedTemp = await fs.realpath(fixtureParent);
    assert.equal(path.dirname(resolvedRoot), resolvedTemp);
    assert.ok(path.basename(resolvedRoot).startsWith('antigravity-mcp-offline-'));
    await fs.rm(resolvedRoot, { recursive: true });
  }
});

test('Live2D preflight failure leaves the job queued and permits later delivery', async () => {
  const fixture = await fs.mkdtemp(path.join(fixtureParent, 'antigravity-mcp-offline-'));
  try {
    const protocolPath = path.join(fixture, 'protocol.mjs');
    await fs.writeFile(protocolPath, (await fs.readFile(path.join(sourceSidecar, 'protocol.mjs'), 'utf8')).replace("process.env.ANTIGRAVITY_CONVERSATION_ID ?? ''", JSON.stringify(randomUUID())));
    const protocol = await import(pathToFileURL(protocolPath));
    await protocol.submit(fixture, 'probe', 'Synthetic technical review');
    const dir = path.join(fixture, 'runtime', 'jobs', 'probe');
    const marker = path.join(dir, 'attempt.json');
    let sends = 0;
    const send = async () => { sends++; assert.ok(await protocol.exists(marker)); return { code: 0 }; };
    await assert.rejects(protocol.pump(fixture, send, async () => { throw new Error('Identity mismatch'); }), /Identity mismatch/);
    assert.equal(sends, 0);
    assert.equal(await protocol.exists(marker), false);
    assert.equal((await protocol.inspectJob(fixture, 'probe')).state, 'queued');
    await protocol.pump(fixture, send, async id => assert.equal(id, protocol.CONVERSATION_ID));
    assert.equal(sends, 1);
  } finally {
    const resolvedRoot = await fs.realpath(fixture);
    assert.equal(path.dirname(resolvedRoot), await fs.realpath(fixtureParent));
    assert.ok(path.basename(resolvedRoot).startsWith('antigravity-mcp-offline-'));
    await fs.rm(resolvedRoot, { recursive: true });
  }
});

test('stdio chat tasks retain exact material and candidate versions, require current continuation and recover after takeover', async () => {
  const fixture = await fs.mkdtemp(path.join(fixtureParent, 'antigravity-mcp-offline-'));
  try {
    const workspace = path.join(fixture, 'workspace');
    const root = path.join(workspace, 'sidecar');
    await fs.mkdir(root, { recursive: true });
    const protocolPath = path.join(root, 'protocol.mjs');
    await fs.writeFile(protocolPath, (await fs.readFile(path.join(sourceSidecar, 'protocol.mjs'), 'utf8')).replace("process.env.ANTIGRAVITY_CONVERSATION_ID ?? ''", JSON.stringify(randomUUID())));
    const protocol = await import(pathToFileURL(protocolPath));
    const projectId = randomUUID();
    const manifest = path.join(fixture, 'bindings.json');
    const conversation = randomUUID();
    const foreignConversation = randomUUID();
    const binding = { workspace_root: workspace, sidecar_root: root, project_id: projectId,
      conversation_id: protocol.CONVERSATION_ID, sidecar_id: 'fixture-sidecar' };
    await fs.writeFile(manifest, JSON.stringify({ version: 1, bindings: [binding] }));
    await fs.writeFile(path.join(root, 'official-agentapi.mjs'), `export const EXPECTED_PROJECT_ID = ${JSON.stringify(projectId)};
export const EXPECTED_WORKSPACE = ${JSON.stringify(workspace)};
`);
    await protocol.publishJson(path.join(root, 'native-identity-result.json'), {
      version: 2, state: 'verified', observedAt: new Date().toISOString(), appRuntimePresent: true,
      check: { command: 'get-conversation-metadata', exitCode: 0, stdoutSha256: hash('metadata'),
        observed_binding: { workspace_root: workspace, project_id: projectId, conversation_id: protocol.CONVERSATION_ID } },
    });
    const store = turnStore(protocol, workspace);
    const remoteMetadata = new Map([[conversation, { observed_model: null }]]);
    let dispatchCount = 0;
    let cursor = hash('first turn');
    let dispatch;
    const native = {
      metadata: async id => {
        if (!remoteMetadata.has(id)) throw new Error('Outside workspace');
        return remoteMetadata.get(id);
      },
      observe: async (id, request) => {
        const metadata = await native.metadata(id);
        return { ...metadata, state: 'ready', conversation_id: id, cursor, request_observed: request?.id === dispatch?.request.id };
      },
      verifyCreation: async () => {},
      progress: async () => ({ state: 'ready', cursor }),
      dispatch: async (request, message) => {
        dispatchCount++;
        dispatch = { request, message };
        return { acknowledged: true, conversation_id: conversation };
      },
    };
    const invoke = async (name, args, isError = false) => {
      const [result] = await exchange(workspace, manifest, [call(2, name, args)]);
      return data(result, isError);
    };
    const observe = async conversationId => {
      const pending = await invoke('conversation_status', { conversation_id: conversationId, wait_ms: 0 });
      assert.equal(pending.state, 'observation_pending');
      await store.pump(native, false);
      const read = await protocol.readJson(path.join(root, 'runtime', 'conversation-observations', conversationId, 'observation.json'));
      return read;
    };
    const materialPath = path.join(workspace, 'note.md');
    const outsidePath = path.join(fixture, 'outside.md');
    const originalBytes = Buffer.from([0xef, 0xbb, 0xbf, 0x78, 0x0d, 0x0a]);
    await fs.writeFile(materialPath, originalBytes);
    await fs.writeFile(outsidePath, 'private');
    const key = randomUUID();
    const start = { request_key: key, title: 'Neutral',
      prompt: 'Write the fixture. Ask if its label is missing.', materials: [{ path: materialPath, sha256: hash(originalBytes) }] };
    assert.match((await invoke('start_chat', { ...start, request_key: randomUUID(), materials: [{ path: outsidePath }] }, true)).error, /inside the bound workspace/);
    const first = await invoke('start_chat', start);
    assert.equal(first.state, 'queued');
    assert.equal(first.requested_model, 'gemini-3.8-flash-medium');
    assert.deepEqual(await fs.readFile(first.material_versions[0].snapshot_path), originalBytes);
    await fs.writeFile(materialPath, 'changed');
    assert.equal((await invoke('start_chat', start)).duplicate, true);
    assert.match((await invoke('start_chat', { ...start, prompt: 'changed request' }, true)).error, /different turn arguments/);
    // Pause after agentapi acknowledged the request, before ownership metadata
    // returns. MCP wait should time out as pending, not report lost delivery.
    const normalMetadata = native.metadata;
    let releaseMetadata;
    const metadataGate = new Promise(resolve => { releaseMetadata = resolve; });
    native.metadata = async id => { await metadataGate; return normalMetadata(id); };
    const dispatching = store.pump(native, false);
    try {
      assert.equal(await waitFor(() => protocol.exists(path.join(first.task_path, 'dispatch.json')), Boolean, 4000), true);
      const pending = await invoke('job_status', { request_key: key, wait_ms: 150 });
      assert.equal(pending.state, 'verifying_delivery');
      assert.equal(isTurnPending(pending), true);
      assert.equal(pending.delivery_confirmed, false);
      assert.equal(pending.conversation_id, null);
    } finally {
      releaseMetadata();
      await dispatching;
      native.metadata = normalMetadata;
    }
    assert.match(dispatch.message, /Only the files listed in materials/);
    assert.ok(!dispatch.message.includes(start.prompt));
    assert.equal((await invoke('job_status', { request_key: key })).state, 'running_app');
    assert.equal((await invoke('cancel_job', { request_key: key })).cancelled, false);
    const receipt = { version: 2, id: dispatch.request.id, nonce: dispatch.request.nonce };
    await protocol.publishJson(path.join(first.task_path, 'completion.json'), null);
    await store.pump(native, false);
    assert.equal((await invoke('job_status', { request_key: key })).state, 'completion_invalid');
    await protocol.publishJson(path.join(first.task_path, 'completion.json'), { ...receipt, nonce: randomUUID(), status: 'done' });
    await store.pump(native, false);
    assert.equal((await invoke('job_status', { request_key: key })).state, 'completion_invalid');
    await protocol.publishJson(path.join(first.task_path, 'completion.json'), {
      ...receipt, status: 'needs_input', question: 'Which label?', options: ['A', 'B'],
    });
    const normalRead = fs.readFile;
    fs.readFile = async (file, ...options) => {
      if (file === path.join(first.task_path, 'completion.json')) {
        throw Object.assign(new Error('temporarily held by the App'), { code: 'EBUSY' });
      }
      return normalRead(file, ...options);
    };
    try { await store.pump(native, false); }
    finally { fs.readFile = normalRead; }
    await store.pump(native, false);
    const needsInput = await invoke('job_status', { request_key: key });
    assert.equal(needsInput.state, 'needs_input');
    assert.equal(needsInput.conversation_id, conversation);
    assert.deepEqual(needsInput.options, ['A', 'B']);
    assert.equal((await observe(foreignConversation)).state, 'conversation_unverified');
    const observed = await observe(conversation);
    assert.equal(observed.state, 'ready');
    const continueArgs = { conversation_id: conversation, cursor: observed.cursor, prompt: 'Use A.' };
    const staleKey = randomUUID();
    await invoke('continue_chat', { request_key: staleKey, ...continueArgs });
    cursor = hash('user advanced the chat');
    await store.pump(native, false);
    assert.equal((await invoke('job_status', { request_key: staleKey })).state, 'cursor_conflict');
    assert.equal(dispatchCount, 1);
    const cancelledKey = randomUUID();
    await invoke('continue_chat', { request_key: cancelledKey, ...continueArgs, cursor });
    const verify = native.observe;
    native.observe = async (...args) => {
      const result = await verify(...args);
      assert.equal((await invoke('cancel_job', { request_key: cancelledKey })).cancelled, true);
      return result;
    };
    await store.pump(native, false);
    native.observe = verify;
    assert.equal(dispatchCount, 1);
    const nextKey = randomUUID();
    const next = await invoke('continue_chat', { request_key: nextKey, ...continueArgs, cursor });
    await store.pump(native, false);
    assert.equal(dispatch.request.prompt, 'Use A.');
    assert.equal(dispatch.request.conversation_id, conversation);
    assert.deepEqual(dispatch.request.materials, []);
    const candidate = Buffer.from('\uFEFFfirst line\r\n末行\n');
    await fs.writeFile(path.join(next.task_path, 'candidate.md'), candidate);
    await protocol.publishJson(path.join(next.task_path, 'completion.json'), {
      version: 2, id: dispatch.request.id, nonce: dispatch.request.nonce, status: 'done',
    });
    await store.pump(native, false);
    const done = await invoke('job_status', { request_key: nextKey });
    assert.equal(done.state, 'done');
    assert.equal(done.candidateSha256, hash(candidate));
    await fs.writeFile(path.join(next.task_path, 'candidate.md'), 'overwritten');
    assert.deepEqual(await fs.readFile(done.candidate_path), candidate);
    const usedCursorKey = randomUUID();
    await invoke('continue_chat', { request_key: usedCursorKey, ...continueArgs, cursor });
    await store.pump(native, false);
    assert.equal((await invoke('job_status', { request_key: usedCursorKey })).state, 'cursor_conflict');
    assert.equal((await observe(conversation)).state, 'app_active_or_unsettled');
    assert.equal(dispatchCount, 2);
    const unknownKey = randomUUID();
    await invoke('start_chat', { request_key: unknownKey, prompt: 'New task.' });
    native.dispatch = async request => { dispatch = { request }; dispatchCount++; return { acknowledged: false, timed_out: true }; };
    await store.pump(native, false);
    const timedOut = await invoke('job_status', { request_key: unknownKey, wait_ms: 150 });
    assert.equal(timedOut.state, 'delivery_unknown');
    assert.equal(isTurnPending(timedOut), false);
    assert.equal(timedOut.reason, 'native_command_timeout');
    await invoke('takeover_job', { request_key: unknownKey, conversation_id: foreignConversation });
    await store.pump(native, false);
    assert.match((await invoke('job_status', { request_key: unknownKey })).takeover_rejected, /Could not verify/);
    await invoke('takeover_job', { request_key: unknownKey, conversation_id: conversation });
    await store.pump(native, false);
    const takenOver = await invoke('job_status', { request_key: unknownKey });
    assert.equal(takenOver.state, 'manual_takeover');
    assert.equal(takenOver.conversation_id, conversation);
    assert.equal(dispatchCount, 3);

    const crashKey = randomUUID();
    const crashed = await invoke('start_chat', { request_key: crashKey, prompt: 'Claim persisted before a process restart.' });
    const claimDir = path.join(crashed.task_path, 'claim');
    await fs.mkdir(claimDir);
    const old = new Date(Date.now() - nativeCommandTimeoutMs - 1000).toISOString();
    await protocol.publishJson(path.join(claimDir, 'record.json'), { action: 'dispatch', at: old });
    const restartedStore = turnStore(protocol, workspace);
    const missing = await restartedStore.status(crashed.id);
    assert.equal(missing.state, 'delivery_unknown');
    assert.equal(missing.reason, 'dispatch_receipt_missing');
    await protocol.publishJson(path.join(crashed.task_path, 'dispatch.json'), {
      acknowledged: true, conversation_id: conversation, returned_at: old,
    });
    const expired = await invoke('job_status', { request_key: crashKey, wait_ms: 150 });
    assert.equal(expired.state, 'delivery_unknown');
    assert.equal(expired.reason, 'delivery_verification_timeout');
    await restartedStore.pump(native, false);
    assert.equal((await restartedStore.status(crashed.id)).state, 'running_app');
    assert.equal(dispatchCount, 3);
    await restartedStore.requestTakeover(crashed.id, conversation);
    await restartedStore.pump(native, false);

    remoteMetadata.set(protocol.CONVERSATION_ID, { observed_model: null });
    native.dispatch = async request => ({ acknowledged: true, conversation_id: request.conversation_id });
    const legacyCursorKey = randomUUID();
    await invoke('continue_chat', { request_key: legacyCursorKey, ...continueArgs, conversation_id: protocol.CONVERSATION_ID, cursor });
    await store.pump(native, false, { conversation_id: protocol.CONVERSATION_ID, cursor, armed_at: new Date().toISOString() });
    assert.equal((await invoke('job_status', { request_key: legacyCursorKey })).state, 'cursor_conflict');
    const anchorKey = randomUUID();
    await invoke('continue_chat', { request_key: anchorKey, ...continueArgs, conversation_id: protocol.CONVERSATION_ID, cursor });
    await store.pump(native, false);
    assert.equal((await invoke('job_status', { request_key: anchorKey })).state, 'running_app');
    const unrelatedKey = randomUUID();
    await invoke('continue_chat', { request_key: unrelatedKey, ...continueArgs });
    assert.equal((await store.pump(native, true)).anchor_blocked, true);
    assert.equal((await invoke('job_status', { request_key: unrelatedKey })).state, 'cursor_conflict');
  } finally {
    const real = await fs.realpath(fixture);
    assert.equal(path.dirname(real), await fs.realpath(fixtureParent));
    assert.match(path.basename(real), /^antigravity-mcp-offline-/);
    await fs.rm(real, { recursive: true });
  }
});

test('App transcript cursor follows latest user boundary and command parsing only uses verified evidence', async () => {
  const id = randomUUID();
  const other = randomUUID();
  const projectId = randomUUID();
  const nonce = randomUUID();
  const user = { type: 'USER_INPUT', status: 'DONE', content: `<USER_REQUEST>\nOpenAI Codex task job / ${nonce}.\n</USER_REQUEST>` };
  const response = { type: 'PLANNER_RESPONSE', status: 'DONE', content: 'complete', thinking: 'private' };
  const bytes = (...rows) => Buffer.from(rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  assert.equal(transcriptSummary(bytes(user)).state, 'app_active_or_unsettled');
  assert.equal(transcriptSummary(bytes(user, response, user)).state, 'app_active_or_unsettled');
  const settled = bytes({ type: 'GENERIC', status: 'RUNNING' }, user, response);
  assert.deepEqual(transcriptSummary(settled, { id: 'job', nonce }), {
    state: 'ready', cursor: hash(settled), request_observed: true, request_current: true,
  });
  assert.equal(transcriptSummary(Buffer.from('partial')).state, 'transcript_unavailable');
  const config = await fs.mkdtemp(path.join(fixtureParent, 'antigravity-mcp-offline-'));
  try {
    const workspace = await fs.realpath(config);
    const route = { anchor: id, sidecarId: 'local-sidecar', workspace, projectId };
    await fs.mkdir(path.join(config, 'projects'));
    await fs.writeFile(path.join(config, 'config.json'), JSON.stringify({ sidecars: { 'local-sidecar': { enabled: true, projectId } } }));
    const project = { id: projectId, projectResources: { resources: [{ gitFolder: { folderUri: pathToFileURL(workspace).href } }] } };
    await fs.writeFile(path.join(config, 'projects', projectId + '.json'), JSON.stringify(project));
    await verifyRegistration(config, route);
    await assert.rejects(verifyRegistration(config, { ...route, sidecarId: 'missing' }), /registration/);
    const calls = [];
    const api = nativeChat({}, () => [], route, {
      call: async (_exe, _argv, args) => {
        calls.push(args);
        const [command] = args;
        const evidence = { exit_code: 0, stdout_sha256: hash(command) };
        if (command === 'new-conversation') return { evidence, response: { newConversation: { conversationId: id }, other: { conversationId: other } } };
        return { evidence, response: { conversationMetadata: { metadata: {
          projectId, rootConversationId: id, workspaces: [{ workspaceFolderAbsoluteUri: pathToFileURL(workspace).href }],
        } } } };
      },
      geminiRoot: workspace,
    });
    const result = await api.dispatch({ operation: 'start', title: 'Neutral', requested_model: 'gemini-3.8-flash-medium' }, 'short');
    assert.equal(result.conversation_id, id);
    assert.deepEqual(calls[0], ['new-conversation', '--model=gemini-3.8-flash-medium', '--title=Neutral', 'short']);
    assert.equal((await api.metadata(id)).observed_model, null);
    await assert.rejects(api.metadata(other), /ownership differs/);
  } finally {
    const real = await fs.realpath(config);
    assert.equal(path.dirname(real), await fs.realpath(fixtureParent));
    assert.match(path.basename(real), /^antigravity-mcp-offline-/);
    await fs.rm(real, { recursive: true });
  }
});

test('shared worker executable loads a registered fixture and dispatches through the native command boundary', async () => {
  const fixture = await fs.mkdtemp(path.join(fixtureParent, 'antigravity-mcp-offline-'));
  let worker;
  let closed;
  try {
    const workspace = path.join(fixture, 'workspace');
    const root = path.join(workspace, 'sidecar');
    const configDir = path.join(fixture, '.gemini', 'config');
    await fs.mkdir(root, { recursive: true });
    await fs.mkdir(path.join(configDir, 'projects'), { recursive: true });
    const protocolPath = path.join(root, 'protocol.mjs');
    await fs.writeFile(protocolPath, (await fs.readFile(path.join(sourceSidecar, 'protocol.mjs'), 'utf8')).replace("process.env.ANTIGRAVITY_CONVERSATION_ID ?? ''", JSON.stringify(randomUUID())));
    await fs.copyFile(path.join(sourceSidecar, 'parent-lifetime.mjs'), path.join(root, 'parent-lifetime.mjs'));
    const protocol = await import(pathToFileURL(protocolPath));
    const projectId = randomUUID();
    const conversation = randomUUID();
    const sidecarId = 'registered-offline';
    const workspaceUri = pathToFileURL(workspace).href;
    const manifest = path.join(fixture, 'bindings.json');
    await fs.writeFile(manifest, JSON.stringify({ version: 1, bindings: [{
      workspace_root: workspace, sidecar_root: root, project_id: projectId, conversation_id: protocol.CONVERSATION_ID, sidecar_id: sidecarId,
    }] }));
    await fs.writeFile(path.join(configDir, 'config.json'), JSON.stringify({ sidecars: { [sidecarId]: { enabled: true, projectId } } }));
    await fs.writeFile(path.join(configDir, 'projects', projectId + '.json'), JSON.stringify({
      id: projectId, projectResources: { resources: [{ gitFolder: { folderUri: workspaceUri } }] },
    }));
    const fake = path.join(fixture, 'fake-agentapi.mjs');
    await fs.writeFile(fake, `import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
const [command, ...args] = process.argv.slice(2);
const workspace = ${JSON.stringify(workspace)};
const newId = ${JSON.stringify(conversation)};
let response;
if (command === 'get-conversation-metadata') {
  if (![${JSON.stringify(protocol.CONVERSATION_ID)}, newId].includes(args[0])) process.exit(2);
  response = { conversationMetadata: { metadata: {
    rootConversationId: args[0], projectId: ${JSON.stringify(projectId)},
    workspaces: [{ workspaceFolderAbsoluteUri: ${JSON.stringify(workspaceUri)} }],
  } } };
} else if (command === 'new-conversation') {
  const message = args[2];
  if (args[0] !== '--model=gemini-3.8-flash-medium' || !message.includes(workspace)) process.exit(3);
  const requestPath = message.split('\\n').find(line => line.startsWith('Read ')).split('/request.json.')[0].slice(5);
  if (path.isAbsolute(requestPath)) process.exit(4);
  const task = path.join(workspace, requestPath);
  const req = JSON.parse(await fs.readFile(path.join(task, 'request.json'), 'utf8'));
  if (req.prompt !== 'Neutral App fixture') process.exit(5);
  await fs.writeFile(path.join(task, 'candidate.md'), 'exact neutral artifact\\r\\n');
  await fs.writeFile(path.join(task, 'completion.json'), JSON.stringify({ version: 2, id: req.id, nonce: req.nonce, status: 'done' }));
  response = { newConversation: { cascadeId: newId } };
} else process.exit(6);
process.stdout.write(JSON.stringify({ response }));
`);
    await fs.writeFile(path.join(root, 'official-agentapi.mjs'), `export const EXPECTED_PROJECT_ID = ${JSON.stringify(projectId)};
export const EXPECTED_WORKSPACE = ${JSON.stringify(workspace)};
export const resolveAgentapi = async () => ({ file: process.execPath, source: 'offline-fixture' });
export const nativeArgv = (_executable, args) => [${JSON.stringify(fake)}, ...args];
`);
    const program = fileURLToPath(new URL('./worker.mjs', import.meta.url));
    worker = spawn(process.execPath, [program, '--serve', manifest, sidecarId], {
      cwd: fixture, windowsHide: true, env: { ...process.env, USERPROFILE: fixture, HOME: fixture, ANTIGRAVITY_EXECUTABLE_DATA_DIR: fixture },
    });
    let errors = '';
    worker.stderr.on('data', chunk => { errors += chunk; });
    closed = new Promise(resolve => worker.once('close', resolve));
    const identity = path.join(root, 'native-identity-result.json');
    assert.equal(await waitFor(() => protocol.exists(identity), Boolean, 4000), true, errors);
    const key = randomUUID();
    const [started] = await exchange(workspace, manifest, [call(2, 'start_chat', { request_key: key, prompt: 'Neutral App fixture' })]);
    assert.equal(data(started).duplicate, false);
    const [finished] = await exchange(workspace, manifest, [call(2, 'job_status', { request_key: key, wait_ms: 6000 })]);
    const job = data(finished);
    assert.equal(job.state, 'done', errors);
    assert.equal(job.conversation_id, conversation);
    assert.equal(job.candidate_markdown, 'exact neutral artifact\r\n');
  } finally {
    if (worker) {
      worker.kill();
      await closed;
    }
    const real = await fs.realpath(fixture);
    assert.equal(path.dirname(real), await fs.realpath(fixtureParent));
    assert.match(path.basename(real), /^antigravity-mcp-offline-/);
    await fs.rm(real, { recursive: true });
  }
});

