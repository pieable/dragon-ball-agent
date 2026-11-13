import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const componentRoot = path.dirname(fileURLToPath(import.meta.url));
const sharedRuntimeFiles = [
  'local-bindings.mjs', 'runtime-version.mjs', 'runtime-config.mjs', 'native-command.mjs', 'native-chat.mjs',
  'diagnose-binding.mjs', 'turns.mjs', 'task-store.mjs', 'app-provider.mjs', 'worker.mjs', 'conversation-log.mjs', 'conversation-boundary.mjs',
  'live2d-sidecar/official-agentapi.mjs', 'live2d-sidecar/parent-lifetime.mjs',
];

const digest = value => createHash('sha256').update(value).digest('hex');

export function routeWorkerIdentity(route) {
  return {
    route_id: route.route_id,
    provider: route.provider,
    project_id: route.project_id,
    sidecar_id: route.sidecar_id,
    workspace_roots: route.workspace_roots.map(root => ({ kind: root.kind, path: root.path, uri: root.uri ?? null }))
      .sort((a, b) => a.path.localeCompare(b.path)),
    state_root: route.state_root,
    sidecar_root: route.sidecar_root,
  };
}

export async function runtimeDigest(root = componentRoot) {
  const parts = [];
  for (const relative of sharedRuntimeFiles) {
    const bytes = await fs.readFile(path.join(root, relative));
    parts.push(`${relative}:${digest(bytes)}`);
  }
  return digest(parts.join('\n'));
}

export async function workerConfigDigest(route, root = componentRoot) {
  const code = await runtimeDigest(root);
  return { worker_config_sha256: digest(JSON.stringify(routeWorkerIdentity(route))), runtime_sha256: code,
    digest: digest(`${digest(JSON.stringify(routeWorkerIdentity(route)))}:${code}`) };
}
