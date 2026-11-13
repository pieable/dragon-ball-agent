import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

export const ROOT = path.dirname(fileURLToPath(import.meta.url));
export const CONVERSATION_ID = process.env.ANTIGRAVITY_CONVERSATION_ID ?? '';
const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
export const digest = value => createHash('sha256').update(value).digest('hex');
export function normalizeMode(mode) {
  if (mode === undefined) return 'technical';
  if (mode !== 'technical' && mode !== 'writer') throw new Error('Invalid request mode');
  return mode;
}
export function assertId(id) {
  if (typeof id !== 'string' || !idPattern.test(id)) throw new Error('Invalid job ID');
  return id;
}
export async function safeDirectory(directory, create = false) {
  // The established workspace may have migrated/junction ancestors. Trust the
  // script root's real location, then reject links in every descendant we use.
  const realRoot = await fs.realpath(ROOT);
  let relative = path.relative(path.resolve(ROOT), path.resolve(directory));
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    relative = path.relative(realRoot, path.resolve(directory));
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Directory escapes app-sidecar root');
  }
  let current = realRoot;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (create) {
      try { await fs.mkdir(current); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    }
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Directory must not traverse links');
  }
}
export async function readJson(file) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Expected a regular JSON file');
  return JSON.parse(await fs.readFile(file, 'utf8'));
}
export async function exists(file) {
  try { await fs.lstat(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; }
}
export async function publishJson(file, value) {
  const temp = `${file}.${randomUUID()}.tmp`;
  const handle = await fs.open(temp, 'wx');
  try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync(); }
  finally { await handle.close(); }
  await fs.rename(temp, file);
}
export async function exclusiveJson(file, value) {
  const handle = await fs.open(file, 'wx');
  try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync(); }
  finally { await handle.close(); }
}
export function validateRequest(r, id) {
  if (!CONVERSATION_ID) throw new Error('Explicit conversation binding required');
  const mode = normalizeMode(r?.mode);
  if (r?.version !== 1 || r.id !== assertId(id) || r.conversationId !== CONVERSATION_ID ||
      typeof r.prompt !== 'string' || !r.prompt.trim() ||
      typeof r.nonce !== 'string' || !/^[a-f0-9-]{36}$/.test(r.nonce) ||
      typeof r.createdAt !== 'string' || !Number.isFinite(Date.parse(r.createdAt)) ||
      r.promptSha256 !== digest(r.prompt)) throw new Error('Invalid request');
  return { ...r, mode };
}
export async function submit(root, id, prompt, requestedMode = 'technical') {
  if (!CONVERSATION_ID) throw new Error('Explicit conversation binding required');
  assertId(id);
  const mode = normalizeMode(requestedMode);
  if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('Prompt is empty');
  const jobs = path.join(root, 'runtime', 'jobs');
  await safeDirectory(root);
  await safeDirectory(jobs, true);
  const dir = path.join(jobs, id);
  try { await fs.mkdir(dir); }
  catch (e) {
    if (e.code !== 'EEXIST') throw e;
    await safeDirectory(dir);
    const prior = validateRequest(await readJson(path.join(dir, 'request.json')), id);
    if (prior.mode !== mode) throw new Error('Same job ID has different mode');
    if (prior.promptSha256 !== digest(prompt)) throw new Error('Same job ID has different prompt');
    return { id, duplicate: true };
  }
  const request = { version: 1, id, mode, conversationId: CONVERSATION_ID, nonce: randomUUID(),
    prompt, promptSha256: digest(prompt), createdAt: new Date().toISOString() };
  await publishJson(path.join(dir, 'request.json'), request);
  return { id, duplicate: false };
}
export function messageFor(request, dir) {
  // The entire author payload stays in its hash-validated job file, never in a
  // Windows command argument. The CLI receives only this short file instruction.
  const writer = normalizeMode(request.mode) === 'writer';
  const lead = writer
    ? `这是作者委托的候选执笔任务。先完整读取 ${path.join(dir, 'request.json')}，其中 prompt 字段完整保存作者原话与本轮上下文。` +
      `可读取 prompt 明确选择的项目原件，并按其中的写作或改稿要求形成候选；不要自行扩大原件范围。` +
      `不直接覆盖正式正文，不自行进行 Git 提交，不修改本任务目录以外的文件。` +
      `本轮只允许写 candidate.md 和 completion.json 两个任务文件，目录为 ${dir}。`
    : `本轮仅为技术测试。先完整读取 ${path.join(dir, 'request.json')}，其中 prompt 字段的完整内容就是本轮任务原话。` +
      `只允许在以下任务目录内写文件：${dir}。不要修改小说或目录外文件。`;
  return lead + `按其全文执行，不截断。任务 ID：${request.id}。\n` +
    `把完整候选原文写入 ${path.join(dir, 'candidate.md')}。\n` +
    `候选写完并关闭文件后，最后写 ${path.join(dir, 'completion.json')}，内容为 ` +
    JSON.stringify({ version: 1, id: request.id, nonce: request.nonce, status: 'done' }) +
    `。若任务失败，仍最后写同一 JSON，status 改为 failed 并加 error 字符串。不要提前写完成标记。`;
}
export async function completion(dir, request) {
  const file = path.join(dir, 'completion.json');
  if (!(await exists(file))) return null;
  const value = await readJson(file);
  if (value?.version !== 1 || value.id !== request.id || value.nonce !== request.nonce ||
      !['done', 'failed'].includes(value.status) ||
      (value.status === 'failed' && typeof value.error !== 'string')) throw new Error('Invalid completion receipt');
  if (value.status === 'done') {
    const candidate = path.join(dir, 'candidate.md');
    const stat = await fs.lstat(candidate);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Candidate must be a regular file');
    return { status: 'done', candidateSha256: digest(await fs.readFile(candidate)), candidateBytes: stat.size };
  }
  return { status: 'failed', error: value.error };
}
export async function inspectJob(root, id) {
  const dir = path.join(root, 'runtime', 'jobs', assertId(id));
  await safeDirectory(dir);
  const r = validateRequest(await readJson(path.join(dir, 'request.json')), id);
  const attempted = await exists(path.join(dir, 'attempt.json'));
  // A receipt alone cannot establish that this worker ever attempted delivery.
  if (!attempted) return { id, state: await exists(path.join(dir, 'completion.json')) ? 'completion_invalid' : 'queued' };
  try {
    const done = await completion(dir, r);
    if (done) return { id, ...done, state: done.status };
  } catch { return { id, state: 'completion_invalid' }; }
  const deliveryFile = path.join(dir, 'delivery.json');
  if (!(await exists(deliveryFile))) return { id, state: 'delivery_unknown' };
  const delivery = await readJson(deliveryFile);
  // A timed-out/failed process may have delivered before its local receipt was
  // written. Preserve unknown and never let pump send the same request again.
  if (delivery.timedOut || delivery.timed_out || delivery.spawnError || delivery.spawn_error ||
      (delivery.exitCode !== undefined && delivery.exitCode !== 0) ||
      (delivery.exit_code !== undefined && delivery.exit_code !== 0)) {
    return { id, state: 'delivery_unknown' };
  }
  return { id, state: 'completion_unknown' };
}
// Exactly one official command attempt per ID. A durable marker precedes the external effect.
// Crashes in that gap can suppress an unsent request; recovery never guesses by resending.
export async function pump(root, send, beforeAttempt) {
  const jobs = path.join(root, 'runtime', 'jobs');
  await safeDirectory(jobs, true);
  const entries = (await fs.readdir(jobs, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
  const pending = [];
  for (const entry of entries) {
    assertId(entry.name);
    const dir = path.join(jobs, entry.name);
    await safeDirectory(dir);
    if (!(await exists(path.join(dir, 'request.json')))) continue; // producer has not published yet
    const request = validateRequest(await readJson(path.join(dir, 'request.json')), entry.name);
    const state = await inspectJob(root, request.id);
    if (state.state === 'done' || state.state === 'failed') continue;
    if (state.state !== 'queued') return state; // keep this one conversation sequential
    pending.push({ dir, request });
  }
  if (!pending.length) return { state: 'idle' };
  pending.sort((a, b) => Date.parse(a.request.createdAt) - Date.parse(b.request.createdAt) || a.request.id.localeCompare(b.request.id));
  const { dir, request } = pending[0];
  if (beforeAttempt) await beforeAttempt(request.conversationId);
  try { await exclusiveJson(path.join(dir, 'attempt.json'), { version: 1, id: request.id, attemptedAt: new Date().toISOString() }); }
  catch (e) { if (e.code === 'EEXIST') return { id: request.id, state: 'delivery_unknown' }; throw e; }
  const result = await send(request.conversationId, messageFor(request, dir));
  await publishJson(path.join(dir, 'delivery.json'), { version: 1, id: request.id,
    returnedAt: new Date().toISOString(), ...result });
  return inspectJob(root, request.id);
}
export async function lockWorker(root) {
  const dir = path.join(root, 'runtime');
  await safeDirectory(dir, true);
  const file = path.join(dir, 'worker.lock');
  if (process.platform === 'win32') {
    // Refuse an unreviewed mixed-version handoff. The parent may remove this
    // legacy file only after establishing that the old worker is gone.
    if (await exists(file)) throw new Error('Legacy worker.lock requires verified old-worker shutdown');
    const identity = (await fs.realpath(root)).toLowerCase();
    const pipe = `\\\\.\\pipe\\codex-antigravity-worker-${digest(identity)}`;
    const server = net.createServer(socket => socket.destroy()); // mutex only; no data or command protocol
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen({ path: pipe, exclusive: true }, () => { server.removeListener('error', reject); resolve(); });
    });
    return () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
  // This project targets Windows. Retain the prior conservative file lock on
  // other systems; only Windows has the verified crash-releasing pipe behavior.
  await exclusiveJson(file, { pid: process.pid, createdAt: new Date().toISOString() });
  return () => fs.unlink(file);
}
