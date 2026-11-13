import { setTimeout as delay } from 'node:timers/promises';
import { ROOT, CONVERSATION_ID, pump, lockWorker, safeDirectory, publishJson } from './protocol.mjs';
import { EXPECTED_PROJECT_ID, EXPECTED_WORKSPACE, nativeArgv, resolveAgentapi, runAgentapi } from './official-agentapi.mjs';
import { parentIsAlive } from './parent-lifetime.mjs';
import { publishIdentity, verifyAntigravityBinding } from '../diagnose-binding.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runtimeConfig } from '../runtime-config.mjs';

export async function serve(root, send, { ownerPid = process.ppid, onState = console.log, beforeAttempt } = {}) {
  if (!parentIsAlive(ownerPid)) return;
  await safeDirectory(root);
  const unlock = await lockWorker(root);
  let stopping = false, prior;
  const stop = () => { stopping = true; };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  try {
    while (!stopping && parentIsAlive(ownerPid)) {
      const state = await pump(root, send, beforeAttempt);
      const message = JSON.stringify(state);
      if (message !== prior) { onState(message); prior = message; }
      await delay(runtimeConfig.workerPollMs);
    }
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    await unlock();
  }
}
async function main() {
  const mode = process.argv[2];
  if (mode !== '--serve' || process.argv.length !== 3) throw new Error('Use --serve');
  if (!process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR) throw new Error('Run only as an App-managed sidecar');
  const ownerPid = process.ppid;
  const executable = await resolveAgentapi();
  const verify = async conversationId => {
    try {
      return await verifyAntigravityBinding(executable, nativeArgv, {
        conversationId, projectId: EXPECTED_PROJECT_ID, workspace: EXPECTED_WORKSPACE,
      });
    } catch (error) {
      await publishIdentity(ROOT, publishJson, { state: 'failed' });
      throw error;
    }
  };
  await verify(CONVERSATION_ID);
  await serve(ROOT, (conversationId, prompt) => runAgentapi(executable, ['send-message', conversationId, prompt]),
    { ownerPid, beforeAttempt: verify });
}
const invoked = process.argv[1] && path.resolve(process.argv[1]);
const ownFile = fileURLToPath(import.meta.url);
if (invoked && (process.platform === 'win32' ? invoked.toLowerCase() === ownFile.toLowerCase() : invoked === ownFile)) {
  main().catch(e => { console.error(e.message); process.exitCode = 1; });
}
