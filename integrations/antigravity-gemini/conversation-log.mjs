import { readFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const idPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const truncation = /\n<truncated \d+ bytes>\n/;

function timestamp(value) {
  if (/^\d+$/.test(String(value))) {
    const n = BigInt(value);
    return Number(n > 100000000000000000n ? n / 1000000n : n);
  }
  return Date.parse(value);
}

// Only this whitelist crosses the transcript boundary. Thinking/tool payloads are
// deliberately never spread into the returned object or error diagnostics.
function visible(row) {
  const role = row.type === 'USER_INPUT' ? 'user' : row.type === 'PLANNER_RESPONSE' ? 'assistant' : null;
  if (!role || typeof row.content !== 'string') return null;
  return { step_index: row.step_index, role, status: row.status,
    created_at: row.created_at, content: row.content,
    source_truncated: row.truncated_fields?.includes('content') === true || truncation.test(row.content) };
}

function recover(message, chunks) {
  const parts = message.content.split(truncation);
  if (parts.length !== 2 || !parts[0] || !parts[1]) return;
  const omittedBytes = Number(message.content.match(/\n<truncated (\d+) bytes>\n/)[1]);
  const prefix = message.role === 'assistant' ? 'agent' : 'user';
  const matches = new Set();
  for (const chunk of chunks) {
    if (message.step_index < Number(chunk.chunk_first_step) || message.step_index > Number(chunk.chunk_last_step)) continue;
    let offsets;
    try { offsets = JSON.parse(Buffer.isBuffer(chunk[`${prefix}_step_byte_offsets`]) || chunk[`${prefix}_step_byte_offsets`] instanceof Uint8Array
      ? Buffer.from(chunk[`${prefix}_step_byte_offsets`]).toString('utf8') : chunk[`${prefix}_step_byte_offsets`]); } catch { continue; }
    const body = Buffer.from(chunk[`${prefix}_body`] ?? '', 'utf8');
    if (!Array.isArray(offsets) || !offsets.every((entry, i) => Array.isArray(entry) && entry.length === 2 &&
      Number.isSafeInteger(entry[0]) && Number.isSafeInteger(entry[1]) && entry[1] >= 0 && entry[1] <= body.length &&
      (i === 0 || (entry[0] > offsets[i - 1][0] && entry[1] > offsets[i - 1][1])))) continue;
    const i = offsets.findIndex(([step]) => step === message.step_index);
    if (i < 0) continue;
    const bytes = body.subarray(offsets[i][1], offsets[i + 1]?.[1] ?? body.length);
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { continue; }
    // FTS concatenates messages with a newline separator; preserve original
    // whitespace by accepting only the exact suffix, optionally one separator.
    for (const candidate of [text, text.endsWith('\n') ? text.slice(0, -1) : text]) {
      if (candidate.startsWith(parts[0]) && candidate.endsWith(parts[1]) &&
        Buffer.byteLength(candidate) - Buffer.byteLength(parts[0]) - Buffer.byteLength(parts[1]) === omittedBytes) matches.add(candidate);
    }
  }
  return matches.size === 1 ? [...matches][0] : undefined;
}

export async function readConversationMessages(conversationId, { geminiRoot = join(homedir(), '.gemini') } = {}) {
  if (!idPattern.test(conversationId)) throw new Error('Invalid conversation ID');
  const root = join(geminiRoot, 'antigravity');
  const directory = join(root, 'brain', conversationId);
  const path = join(directory, '.system_generated', 'logs', 'transcript.jsonl');
  for (const entry of [directory, join(directory, '.system_generated'), join(directory, '.system_generated', 'logs'), path]) {
    const stat = await lstat(entry);
    if (stat.isSymbolicLink()) throw new Error('Conversation transcript path contains a symbolic link');
  }
  const bytes = await readFile(path);
  const rows = bytes.toString('utf8').split(/\r?\n/).filter(line => line.trim()).map((line, index) => {
    try { return JSON.parse(line); } catch { throw new Error(`Invalid transcript JSON at line ${index + 1}`); }
  });
  const messages = rows.map(visible).filter(Boolean);
  let recovery_error;
  if (messages.some(message => message.source_truncated)) {
    let db;
    try {
      db = new DatabaseSync(join(root, 'conversation_summaries.db'), { readOnly: true });
      const chunks = db.prepare(`SELECT chunk_first_step, chunk_last_step,
        CAST(last_modified_time AS TEXT) AS last_modified_time, step_count,
        CAST(last_step_created_at AS TEXT) AS last_step_created_at,
        user_step_byte_offsets, agent_step_byte_offsets, user_body, agent_body
        FROM conversations_fts WHERE conversation_id = ?`).all(conversationId);
      // Antigravity stores global metadata in a separate, body-less FTS row.
      const metadata = chunks.filter(c => Number(c.step_count) > 0);
      for (const message of messages.filter(m => m.source_truncated)) {
        const created = Date.parse(message.created_at);
        if (!Number.isSafeInteger(message.step_index) || !Number.isFinite(created) || !metadata.some(c =>
          Number(c.step_count) > message.step_index && timestamp(c.last_modified_time) >= created && timestamp(c.last_step_created_at) >= created)) continue;
        const restored = recover(message, chunks);
        if (restored !== undefined) { message.content = restored; message.source_truncated = false; }
      }
    } catch (error) {
      recovery_error = { code: error.code ?? 'INDEX_READ_FAILED', message: error.message };
    } finally { db?.close(); }
  }
  return { messages, cursor: createHash('sha256').update(bytes).digest('hex'), ...(recovery_error ? { recovery_error } : {}) };
}
