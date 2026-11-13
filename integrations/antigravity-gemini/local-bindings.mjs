import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
const keys = new Set(['ANTIGRAVITY_REVIEWED_WRAPPER', 'ANTIGRAVITY_REVIEWED_NATIVE',
  'ANTIGRAVITY_EXPECTED_PROJECT_ID', 'ANTIGRAVITY_EXPECTED_WORKSPACE', 'ANTIGRAVITY_CONVERSATION_ID']);
export async function readLocalBindings(file, expectedSha256) {
  if (!path.isAbsolute(file)) throw new Error('Local binding file must be absolute');
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Local bindings must be a regular non-link file');
  const bytes = await fs.readFile(file);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (expectedSha256 !== undefined && (!/^[a-f0-9]{64}$/.test(expectedSha256) || sha256 !== expectedSha256)) throw new Error('Local binding hash changed; regenerate reviewed descriptor');
  const values = JSON.parse(bytes.toString('utf8'));
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('Local bindings must be an object');
  for (const [key, value] of Object.entries(values)) {
    if (!keys.has(key) || typeof value !== 'string' || !value.trim() || /[\r\n\0]/.test(value)) throw new Error('Unsupported local binding field or value');
  }
  if (!values.ANTIGRAVITY_REVIEWED_WRAPPER || !values.ANTIGRAVITY_REVIEWED_NATIVE) throw new Error('Both reviewed executable paths are required');
  for (const key of ['ANTIGRAVITY_REVIEWED_WRAPPER', 'ANTIGRAVITY_REVIEWED_NATIVE', 'ANTIGRAVITY_EXPECTED_WORKSPACE']) {
    if (values[key] && !path.isAbsolute(values[key])) throw new Error('Local binding paths must be absolute');
  }
  return { values, sha256 };
}
export async function loadWorkerBindings(args, env = process.env) {
  if (!args.length) return;
  if (args.length !== 3 || args[0] !== '--local-bindings') throw new Error('Invalid worker binding arguments');
  const { values } = await readLocalBindings(args[1], args[2]);
  for (const key of keys) delete env[key];
  Object.assign(env, values);
}
