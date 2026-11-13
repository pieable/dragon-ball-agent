import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const idPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const cursorPattern = /^[a-f0-9]{64}$/;

async function safeDirectory(directory) {
  const parent = path.dirname(directory);
  if (parent !== directory) await safeDirectory(parent);
  if (parent !== directory) {
    try { await fs.mkdir(directory); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe conversation boundary directory.');
}

// A durable claim is intentionally never released: a process may stop after
// remote delivery but before it can persist a receipt. Keep that evidence.
export async function claimConversationBoundary(conversationId, cursor, {
  requestId, stateRoot,
  root = path.join(os.homedir(), '.gemini', 'antigravity', 'codex-bridge-boundaries'),
} = {}) {
  if (!idPattern.test(conversationId ?? '') || !cursorPattern.test(cursor ?? '')) {
    throw new Error('Invalid conversation boundary identity.');
  }
  if (typeof requestId !== 'string' || !requestId.trim() || typeof stateRoot !== 'string' ||
      !path.isAbsolute(stateRoot) || typeof root !== 'string' || !path.isAbsolute(root)) {
    throw new Error('Conversation boundary requires requestId and absolute stateRoot/root.');
  }
  const directory = path.join(path.resolve(root), conversationId);
  await safeDirectory(directory);
  const file = path.join(directory, `${cursor}.json`);
  let handle;
  try { handle = await fs.open(file, 'wx'); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Unsafe conversation boundary claim.');
    return false;
  }
  try {
    await handle.writeFile(JSON.stringify({ version: 1, conversation_id: conversationId, cursor,
      request_id: requestId, state_root: path.resolve(stateRoot), claimed_at: new Date().toISOString() }) + '\n');
    await handle.sync();
  } finally { await handle.close(); }
  return true;
}
