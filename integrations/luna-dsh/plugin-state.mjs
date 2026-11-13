import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

export const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export async function atomicJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  try { await fs.writeFile(temp, JSON.stringify(value, null, 2)); await fs.rename(temp, file); }
  finally { await fs.rm(temp, { force: true }); }
}
export class BridgeState {
  constructor(dir) { this.dir = dir; this.agents = new Map(); this.requests = new Map(); this.locks = new Map(); }
  async load() {
    await fs.mkdir(path.join(this.dir, 'agents'), { recursive: true });
    for (const name of await fs.readdir(path.join(this.dir, 'agents'))) {
      if (!name.endsWith('.json')) continue;
      const record = JSON.parse(await fs.readFile(path.join(this.dir, 'agents', name), 'utf8'));
      if (['running','starting','cancelling'].includes(record.state)) {
        record.state = 'interrupted'; record.error = 'The plugin host stopped before the run settled. Inspect previous results before sending new work.';
        await this.save(record);
      }
      this.agents.set(record.agent_id, record);
    }
    await fs.mkdir(path.join(this.dir, 'requests'), { recursive: true });
    for (const name of await fs.readdir(path.join(this.dir, 'requests'))) {
      if (!name.endsWith('.json')) continue;
      const item = JSON.parse(await fs.readFile(path.join(this.dir, 'requests', name), 'utf8'));
      this.requests.set(item.request_id, item);
    }
  }
  async save(record) {
    this.agents.set(record.agent_id, record);
    const snapshot=structuredClone(record);
    await this.exclusive(`save:${record.agent_id}`,()=>atomicJson(path.join(this.dir, 'agents', `${record.agent_id}.json`), snapshot));
  }
  async exclusive(key, work) {
    const prior = this.locks.get(key) ?? Promise.resolve();
    const current = prior.catch(() => {}).then(work);
    this.locks.set(key, current);
    try { return await current; } finally { if (this.locks.get(key) === current) this.locks.delete(key); }
  }
  async once(requestId, input, work) {
    if (!/^[0-9a-f-]{36}$/i.test(requestId)) throw new Error('request_id must be a UUID');
    return this.exclusive(`request:${requestId}`, async () => {
      const fingerprint = hash(input), existing = this.requests.get(requestId);
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new Error('request_id belongs to different content');
        if (existing.error) throw new Error(existing.error);
        return existing.result ?? { request_id: requestId, state: 'interrupted', message: 'A prior submission was recorded but no receipt survived. It was not resubmitted.' };
      }
      const claim = { request_id: requestId, fingerprint, created_at: new Date().toISOString() };
      const file = path.join(this.dir, 'requests', `${requestId}.json`);
      await atomicJson(file, claim); this.requests.set(requestId, claim);
      try { claim.result = await work(); await atomicJson(file, claim); return claim.result; }
      catch (error) { claim.error = error.message; await atomicJson(file, claim); throw error; }
    });
  }
}
