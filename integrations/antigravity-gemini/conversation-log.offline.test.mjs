import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readConversationMessages } from './conversation-log.mjs';

const id = '11111111-1111-1111-1111-111111111111';
const date = '2026-11-13T05:00:00Z';
async function fixture(t, { stale = false, wrong = false, noIndex = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'conversation-log-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const logs = join(root, 'antigravity', 'brain', id, '.system_generated', 'logs');
  await mkdir(logs, { recursive: true });
  const content = '开头\n<truncated 22 bytes>\n结尾';
  const rows = [
    { step_index: 0, type: 'USER_INPUT', status: 'DONE', created_at: date, content: '问题' },
    { step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: date, content: '前一条中文🙂' },
    { step_index: 2, type: 'TOOL', status: 'DONE', content: 'tool-secret' },
    { step_index: 3, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: date, content, thinking: 'thinking-secret', truncated_fields: ['thinking', 'content'] },
  ];
  const bytes = Buffer.from(rows.map(JSON.stringify).join('\n') + '\n');
  await writeFile(join(logs, 'transcript.jsonl'), bytes);
  const full = '开头中文🙂恢复全文结尾';
  if (!noIndex) {
    const db = new DatabaseSync(join(root, 'antigravity', 'conversation_summaries.db'));
    db.exec(`CREATE TABLE conversations_fts (conversation_id, chunk_first_step, chunk_last_step, last_modified_time, step_count, last_step_created_at, user_step_byte_offsets, agent_step_byte_offsets, user_body, agent_body)`);
    const insert = db.prepare('INSERT INTO conversations_fts VALUES (?,?,?,?,?,?,?,?,?,?)');
    const first = '前一条中文🙂\n';
    insert.run(id, 0, 3, '0', 0, '0', '', Buffer.from(JSON.stringify([[1, 0], [wrong ? 4 : 3, Buffer.byteLength(first)]])), '', first + full);
    const nanos = String(BigInt(Date.parse(date) + (stale ? -1000 : 1000)) * 1000000n);
    insert.run(id, 0, 0, nanos, stale ? 2 : 4, nanos, '', '', '', '');
    db.close();
  }
  return { root, bytes, full, logs };
}

test('recovers Unicode byte offsets, returns only visible messages and raw-byte cursor', async t => {
  const f = await fixture(t);
  const result = await readConversationMessages(id, { geminiRoot: f.root });
  assert.equal(result.messages.length, 3);
  assert.equal(result.messages.at(-1).content, f.full);
  assert.equal(result.messages.at(-1).source_truncated, false);
  assert.equal(result.cursor, createHash('sha256').update(f.bytes).digest('hex'));
  assert.doesNotMatch(JSON.stringify(result), /thinking-secret|tool-secret|truncated_fields/);
});

for (const options of [{ stale: true }, { wrong: true }, { noIndex: true }]) {
  test(`unverified index remains explicitly truncated: ${JSON.stringify(options)}`, async t => {
    const f = await fixture(t, options);
    const result = await readConversationMessages(id, { geminiRoot: f.root });
    assert.equal(result.messages.at(-1).source_truncated, true);
    assert.match(result.messages.at(-1).content, /truncated/);
    if (options.noIndex) assert.ok(result.recovery_error);
  });
}

test('rejects traversal and malformed last record rather than returning misleading cursor', async t => {
  await assert.rejects(readConversationMessages('../secret'), /Invalid conversation ID/);
  const f = await fixture(t);
  await writeFile(join(f.logs, 'transcript.jsonl'), Buffer.concat([f.bytes, Buffer.from('{"thinking":')]));
  await assert.rejects(readConversationMessages(id, { geminiRoot: f.root }), /Invalid transcript JSON at line 5/);
});
