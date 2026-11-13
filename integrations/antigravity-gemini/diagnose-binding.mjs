import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runNativeCommand } from './native-command.mjs';

export async function observedBinding(bytes) {
  let response;
  try { response = JSON.parse(bytes); }
  catch { throw new Error('Antigravity returned unreadable conversation metadata.'); }
  const metadata = response?.response?.conversationMetadata?.metadata;
  const workspaceUri = metadata?.workspaces?.[0]?.workspaceFolderAbsoluteUri;
  if (typeof metadata?.projectId !== 'string' || typeof metadata.rootConversationId !== 'string' ||
      !Array.isArray(metadata.workspaces) || metadata.workspaces.length !== 1 ||
      typeof workspaceUri !== 'string' || !workspaceUri.startsWith('file:')) {
    throw new Error('Antigravity metadata did not identify a project, root conversation and a single local workspace.');
  }
  return {
    project_id: metadata.projectId,
    conversation_id: metadata.rootConversationId,
    workspace_root: await fs.realpath(fileURLToPath(workspaceUri)),
  };
}

function readMetadata(executable, args) {
  return runNativeCommand(executable, args).then(({ evidence, stdout }) => {
    if (evidence.exit_code === 0 && !evidence.spawn_error && !evidence.timed_out && stdout) return stdout;
    throw new Error(evidence.timed_out ? 'get-conversation-metadata timed out.' :
      `get-conversation-metadata exited with code ${evidence.exit_code ?? 'unknown'}.`);
  });
}

export async function verifyAntigravityBinding(executable, nativeArgv, { conversationId, projectId, workspace }) {
  if (!conversationId) throw new Error('Set the verified Antigravity conversation ID before starting this Sidecar.');
  const command = 'get-conversation-metadata';
  const bytes = await readMetadata(executable.file, nativeArgv(executable, [command, conversationId]));
  const observed = await observedBinding(bytes);
  const expectedWorkspace = await fs.realpath(workspace);
  if (observed.project_id !== projectId || observed.conversation_id !== conversationId ||
      path.relative(expectedWorkspace, observed.workspace_root) !== '') {
    throw new Error('Observed Antigravity project, conversation or workspace differs from the Sidecar configuration.');
  }
  return { command, exitCode: 0, stdoutSha256: createHash('sha256').update(bytes).digest('hex'), observed_binding: observed };
}

export function publishIdentity(sidecar, publishJson, data) {
  return publishJson(path.join(sidecar, 'native-identity-result.json'), {
    version: 2, observedAt: new Date().toISOString(), appRuntimePresent: true, ...data,
  });
}

async function main() {
  if (!process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR) throw new Error('Run the diagnostic only as an App-managed Sidecar.');
  if (!path.isAbsolute(process.argv[2] ?? '')) throw new Error('Pass the absolute Sidecar directory as the first argument.');
  const sidecar = await fs.realpath(process.argv[2]);
  const { CONVERSATION_ID, publishJson } = await import(pathToFileURL(path.join(sidecar, 'protocol.mjs')));
  const { EXPECTED_PROJECT_ID, EXPECTED_WORKSPACE, resolveAgentapi, nativeArgv } =
    await import(pathToFileURL(path.join(sidecar, 'official-agentapi.mjs')));
  await publishIdentity(sidecar, publishJson, { state: 'checking' });
  try {
    const executable = await resolveAgentapi();
    const check = await verifyAntigravityBinding(executable, nativeArgv, {
      conversationId: CONVERSATION_ID, projectId: EXPECTED_PROJECT_ID, workspace: EXPECTED_WORKSPACE,
    });
    await publishIdentity(sidecar, publishJson, { state: 'verified', source: executable.source, check });
  } catch (error) {
    await publishIdentity(sidecar, publishJson, { state: 'failed' });
    throw error;
  }
  process.stdout.write('Antigravity project identity verified.\n');
}

if (process.argv[1] && path.relative(fileURLToPath(import.meta.url), path.resolve(process.argv[1])) === '') {
  try { await main(); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}

