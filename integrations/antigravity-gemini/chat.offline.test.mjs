import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { createTaskStore } from './task-store.mjs';
import { appProvider } from './app-provider.mjs';
import { transcriptSummary } from './native-chat.mjs';

const conversation = '11111111-1111-1111-1111-111111111111';
const cursor = 'a'.repeat(64);
const actualReply = '实际回复：保留中文与 emoji 🙂\n第二段。';
async function fixture(t, rejection = null) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'antigravity-chat-offline-'));
  t.after(async () => {
    const real = await fs.realpath(root);
    assert.equal(path.dirname(real), await fs.realpath(os.tmpdir()));
    assert.ok(path.basename(real).startsWith('antigravity-chat-offline-'));
    await fs.rm(real, { recursive: true, maxRetries: 5, retryDelay: 100 });
  });
  const route = { provider: 'antigravity-agentapi', project_id: 'fixture-project',
    sidecar_id: 'fixture-sidecar', workspace_roots: [{ path: root }], state_root: path.join(root, 'state') };
  const store = createTaskStore(route, { boundaryRoot: path.join(root, 'boundaries') });
  const calls = [];
  const provider = {
    async observe() { return { state: 'ready', cursor, conversation_id: conversation }; },
    async metadata() { return { conversation_id: conversation, observed_model: 'gemini-fixture' }; },
    async progress(id, request) {
      if (!request) return { state: 'ready', cursor };
      return { state: 'ready', cursor: 'b'.repeat(64), request_current: true, request_observed: true,
        reply: { role: 'assistant', status: 'DONE', step_index: 4, content: actualReply, source_truncated: false } };
    },
    async dispatch(request, message) {
      calls.push({ request, message });
      return rejection ? { native_rejected: true, native_error: rejection, acknowledged: false, conversation_id: conversation }
        : { acknowledged: true, conversation_id: conversation };
    },
  };
  return { root, route, store, provider, calls };
}
const args = (overrides = {}) => ({ operation: 'continue', task_kind: 'chat',
  conversation_id: conversation, cursor, prompt: '请回复一句确认。', materials: [], ...overrides });
const taskId = () => 'codex-mcp-' + randomUUID();

test('explicit chat metadata accepts missing local and remote workspaces without resolving them', async t => {
  const f = await fixture(t);
  for (const uri of ['file:///Z:/missing-bridge-review-' + randomUUID(), 'vscode-remote://ssh-remote+fixture/project']) {
    const workspaces = [{ workspaceFolderAbsoluteUri: uri }];
    const provider = appProvider('unused', [], f.route, { call: async () => ({
      response: { conversationMetadata: { metadata: {
        projectId: f.route.project_id, rootConversationId: conversation, workspaces,
      } } }, evidence: { exit_code: 0 },
    }) });
    const result = await provider.metadata(conversation, { task_kind: 'chat' });
    assert.equal(result.conversation_id, conversation);
    assert.deepEqual(result.workspaces, workspaces);
    assert.deepEqual(result.workspace_roots, []);
    await assert.rejects(provider.metadata(conversation, { task_kind: 'writing' }));
  }
});

test('metadata preserves stderr-only failure, timeout and exit diagnostics', async t => {
  const f = await fixture(t);
  for (const evidence of [
    { exit_code: 1, stderr_text: 'get-conversation-metadata: connection refused' },
    { exit_code: null, timed_out: true, stderr_text: 'native socket stalled' },
    { exit_code: 7, stderr_text: null },
  ]) {
    const provider = appProvider('unused', [], f.route, { call: async () => ({ response: null, evidence }) });
    await assert.rejects(provider.metadata(conversation, { task_kind: 'chat' }), error => {
      assert.ok(error.message.includes(`exit=${evidence.exit_code ?? 'unknown'}`));
      assert.ok(error.message.includes(`timed_out=${Boolean(evidence.timed_out)}`));
      if (evidence.stderr_text) assert.ok(error.message.includes(evidence.stderr_text));
      assert.doesNotMatch(error.message, /does not verify/);
      return true;
    });
  }
});

test('outside-of-project metadata is accepted for explicit chat and rejected for writing', async t => {
  const f = await fixture(t);
  const invocations = [];
  const provider = appProvider('unused', [], f.route, { call: async (...values) => {
    invocations.push(values);
    return { response: { conversationMetadata: { metadata: {
      projectId: 'outside-of-project', rootConversationId: conversation, workspaces: [], modelName: 'gemini-fixture',
    } } }, evidence: { exit_code: 0 } };
  } });
  const result = await provider.metadata(conversation, { task_kind: 'chat' });
  assert.equal(result.project_id, 'outside-of-project');
  assert.deepEqual(result.workspace_roots, []);
  await assert.rejects(provider.metadata(conversation, { task_kind: 'writing' }), /does not verify/);
  assert.ok(invocations.every(call => call[2][0] === 'get-conversation-metadata'));
});

test('plain chat dispatches once, archives real reply without receipt, same key does not resend', async t => {
  const f = await fixture(t);
  const id = taskId();
  await f.store.submit(id, args());
  await f.store.pump(f.provider);
  const result = await f.store.status(id);
  assert.equal(result.state, 'done');
  assert.equal(result.source, 'app_conversation');
  assert.equal(result.candidate_markdown, actualReply);
  assert.equal(result.reply_step_index, 4);
  assert.equal(await fs.readFile(result.candidate_path, 'utf8'), actualReply);
  await assert.rejects(fs.access(path.join(f.route.state_root, 'runtime', 'turns', id, 'completion.json')), { code: 'ENOENT' });
  assert.equal(f.calls.length, 1);
  assert.ok(f.calls[0].message.includes('请回复一句确认。'));
  assert.doesNotMatch(f.calls[0].message, /completion\.json|request\.json/);
  assert.equal((await f.store.submit(id, args())).duplicate, true);
  await f.store.pump(f.provider);
  assert.equal(f.calls.length, 1);
  const reusedBoundary = taskId();
  await f.store.submit(reusedBoundary, args());
  await f.store.pump(f.provider);
  assert.equal((await f.store.status(reusedBoundary)).state, 'cursor_conflict');
  assert.equal(f.calls.length, 1);
});

test('stale cursor is rejected before dispatch', async t => {
  const f = await fixture(t);
  const id = taskId();
  await f.store.submit(id, args({ cursor: 'c'.repeat(64) }));
  await f.store.pump(f.provider);
  assert.equal((await f.store.status(id)).state, 'cursor_conflict');
  assert.equal(f.calls.length, 0);
});

test('native rejection becomes failed and retains the actual native error', async t => {
  const error = 'send-message: conversation not found (native detail 42)';
  const f = await fixture(t, error);
  const id = taskId();
  await f.store.submit(id, args());
  await f.store.pump(f.provider);
  const result = await f.store.status(id);
  assert.equal(result.state, 'failed');
  assert.equal(result.error, error);
  assert.equal(result.evidence, 'native_rejected');
  await f.store.pump(f.provider);
  assert.equal(f.calls.length, 1);
});

async function progressFixture(t, { oldLast = 'done', laterLast = 'done', systemInput = false, spoof = null } = {}) {
  const f = await fixture(t);
  const request = { id: taskId(), nonce: randomUUID(), task_kind: 'chat' };
  const directory = path.join(f.root, 'antigravity', 'brain', conversation, '.system_generated', 'logs');
  await fs.mkdir(directory, { recursive: true });
  const row = (step_index, type, content, status = 'DONE') => ({ step_index, type, content, status,
    created_at: '2026-11-13T09:00:00Z', thinking: 'private-thinking-never-return' });
  const marker = `OpenAI Codex task ${request.id} / ${request.nonce}.`;
  const system = content => `The following is a <SYSTEM_MESSAGE> not actually sent by the user...\n<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-13T06:34:44Z sender=system priority=MESSAGE_PRIORITY_HIGH content=${content}\n</SYSTEM_MESSAGE>`;
  const first = spoof === 'bare' ? marker : spoof === 'quoted' ? system(`unrelated delivery\n${marker}`) : system(marker);
  const rows = [
    row(0, systemInput ? 'SYSTEM_MESSAGE' : 'USER_INPUT', systemInput ? first : `<USER_REQUEST>${marker}\nold request</USER_REQUEST>`),
    row(1, 'PLANNER_RESPONSE', 'old marker final answer', oldLast === 'pending' ? 'RUNNING' : 'DONE'),
    ...(oldLast === 'tool' ? [row(2, 'TOOL', 'private-tool-never-return')] : []),
    row(3, systemInput ? 'SYSTEM_MESSAGE' : 'USER_INPUT', systemInput ? system('later unrelated request') : 'later unrelated user request'),
    row(4, laterLast === 'tool' ? 'TOOL' : 'PLANNER_RESPONSE', 'later unrelated answer'),
  ];
  if (oldLast === 'tool_call') rows[1].tool_calls = [{ id: 'call-fixture', name: 'read_file', arguments: { path: 'fixture' } }];
  await fs.writeFile(path.join(directory, 'transcript.jsonl'), rows.map(JSON.stringify).join('\n') + '\n');
  const provider = appProvider('unused', [], f.route, { geminiRoot: f.root, call: async () => {
    throw new Error('progress must not invoke native commands');
  } });
  return provider.progress(conversation, request);
}

test('progress returns the requested marker interval reply, not a later user turn', async t => {
  const result = await progressFixture(t);
  assert.equal(result.reply.content, 'old marker final answer');
  assert.equal(result.reply.step_index, 1);
  assert.equal(result.request_current, false);
  assert.doesNotMatch(JSON.stringify(result), /private-thinking-never-return|private-tool-never-return|later unrelated answer/);
});

for (const oldLast of ['tool', 'pending', 'tool_call']) {
  test(`progress does not promote unfinished requested interval (${oldLast}) to final reply`, async t => {
    const result = await progressFixture(t, { oldLast });
    assert.equal(result.reply, undefined);
    assert.doesNotMatch(JSON.stringify(result), /private-thinking-never-return|private-tool-never-return/);
  });
}

test('planner DONE with content and pending tool_calls is not a ready cursor', () => {
  const rows = [
    { step_index: 0, type: 'USER_INPUT', status: 'DONE', content: 'please inspect' },
    { step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', content: 'I will read the file.',
      tool_calls: [{ id: 'call-fixture', name: 'read_file', arguments: { path: 'fixture' } }] },
  ];
  const summary = transcriptSummary(Buffer.from(rows.map(JSON.stringify).join('\n')));
  assert.equal(summary.state, 'app_active_or_unsettled');
  assert.equal(summary.cursor, undefined);
  rows[1].tool_calls = [];
  assert.equal(transcriptSummary(Buffer.from(rows.map(JSON.stringify).join('\n'))).state, 'ready');
});

test('progress retains completed requested reply while later unrelated turn is still active', async t => {
  const result = await progressFixture(t, { laterLast: 'tool' });
  assert.equal(result.reply?.content, 'old marker final answer');
});

test('native SYSTEM_MESSAGE envelope associates its marker and next system message cuts reply interval', async t => {
  const result = await progressFixture(t, { systemInput: true });
  assert.equal(result.request_observed, true);
  assert.equal(result.request_current, false);
  assert.equal(result.reply?.content, 'old marker final answer');
  assert.equal(result.reply?.step_index, 1);
});

for (const spoof of ['bare', 'quoted']) {
  test(`arbitrary system text cannot impersonate a dispatched marker (${spoof})`, async t => {
    const result = await progressFixture(t, { systemInput: true, spoof });
    assert.equal(result.request_observed, false);
    assert.equal(result.reply, undefined);
  });
}
