import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import path from 'node:path';
import os from 'node:os';
import {loadRoleCatalog} from './role-catalog.mjs';
import { fileURLToPath } from 'node:url';
import { ensureHost } from './host-launcher.mjs';
import {WorktreeWorkflow} from './worktree-workflow.mjs';
import fs from 'node:fs/promises';
const here=path.dirname(fileURLToPath(import.meta.url));
const stateDir=path.resolve(process.env.LUNA_BRIDGE_STATE_DIR??path.join(here,'.bridge-state'));
const bridge={async call(operation,args){const {client,capabilities}=await ensureHost({stateDir});if(['spawn_agent','list_roles','pending_parent_tasks','resolve_parent_task'].includes(operation)&&capabilities.role_protocol_version!==1)throw new Error('The running host predates the four-role adapter. Restart the idle plugin host before dispatch; no model task was submitted.');if((operation==='set_reasoning_effort'||args.reasoning_effort!==undefined)&&capabilities.effort_protocol_version!==1)throw new Error('Restart the idle plugin host to load dynamic reasoning support; no change or task was submitted.');return client.call(operation,args);}};
const server=new McpServer({name:'luna-dsh-plugin',version:'0.2.0'});
const workflow=new WorktreeWorkflow();
const output=value=>({content:[{type:'text',text:JSON.stringify(value)}]});
const agentId=z.string().min(1),requestId=z.string().uuid();
const roleUses={worker:'Own a bounded implementation task, including local diagnosis, edits and tests; no delegation. Explicit workspace-write required for edits.',explorer:'Read-only local evidence gathering and relationship tracing; cannot write or delegate.', 'code-executor':'Own an implementation stage, stabilize shared interfaces, delegate workers/explorers/researchers, integrate and validate; route Codex-only review/visual tests back to parent.', 'web-researcher':'Investigate the live web with actual hosted search, fetch primary sources, compare evidence and report citations; no delegation. Search uses additional API credits.'};
let roleDiscovery;
try{const c=await loadRoleCatalog({codexHome:process.env.LUNA_CODEX_HOME??process.env.DSH_AGENTS_HOME??process.env.CODEX_HOME??path.join(os.homedir(),'.codex')});roleDiscovery=c.roles.map(r=>`${r.name} (${r.error?'unavailable: '+r.error.message:r.effort}): ${roleUses[r.name]}`).join('\n');}
catch(error){roleDiscovery=`Role source unavailable: ${error.message}`;}

const schemas={
  pending_parent_tasks:{description:'Read requests from code-executor for Codex-only reviewer or visual validation. Requests have not yet been executed.',schema:{}},
  resolve_parent_task:{description:'Deliver the actual result of a requested Codex-only review/test to its executor and resume it.',schema:{request_id:requestId,agent_id:agentId,task_id:z.string().uuid(),result:z.string().min(1)}},
  list_roles:{description:'Read the four current Luna role definitions, source hashes and initial default reasoning levels. Reserved Codex roles are not migrated.',schema:{}},
  capabilities:{description:'Read the running DSH plugin capabilities and model route.',schema:{}},
  spawn_agent:{description:`Dispatch one of four source-backed Luna roles:\n${roleDiscovery}\nRole effort is an initial default; override reasoning_effort when useful. Provide the task contract, context, source paths, cwd, acceptance criteria and explicit write permission. The child does not inherit the Codex conversation automatically. Returns agent_id immediately. Read reports with read_messages/wait_agent; continue the same owner with send_message. Default, Content Designer and visual-usability-tester remain in Codex.`,schema:{request_id:requestId,role:z.enum(['worker','explorer','code-executor','web-researcher']),prompt:z.string().min(1),cwd:z.string().min(1),context:z.string().optional(),permission_mode:z.enum(['read-only','workspace-write']).default('read-only'),reasoning_effort:z.enum(['off','low','medium','high','xhigh','max']).optional()}},
  send_message:{description:'Send to an existing agent. followup queues the next turn; steer supplies next-step guidance while running; inject stores context without waking it. Optional reasoning_effort changes this agent from its next model request, including remaining steps of a running turn, not an in-flight request. Omission preserves its current effort. Reuse request_id on uncertain retries.',schema:{request_id:requestId,agent_id:agentId,message:z.string().min(1),mode:z.enum(['followup','steer','inject']).default('followup'),reasoning_effort:z.enum(['off','low','medium','high','xhigh','max']).optional()}},
  set_reasoning_effort:{description:'Select the same agent’s reasoning level for its next model request. Preserves its session, role and permissions; does not wake an idle agent or change an in-flight request. For a clean stage boundary, wait until idle before setting. New OpenAI-route agents use in-history configuration updates; legacy luna-api sessions retain their route.',schema:{request_id:requestId,agent_id:agentId,reasoning_effort:z.enum(['off','low','medium','high','xhigh','max'])}},
  agent_status:{description:'Read the actual DSH agent state, durable final output, provider error, token usage and messages.',schema:{agent_id:agentId}},
  list_agents:{description:'Find bridge-owned agents, including persisted agents after host restart.',schema:{}},
  read_messages:{description:'Read reports, questions, parent message receipts and completed turn messages since offset. This is the inbound side of Codex–DSH communication.',schema:{agent_id:agentId,offset:z.number().int().nonnegative().default(0)}},
  interrupt_agent:{description:'Cancel active and queued work through the native DSH Agent API and wait for settlement. Existing file changes remain. The same agent can receive a new task later.',schema:{agent_id:agentId}},
  close_agent:{description:'Cancel and release this agent through its native DSH handle. Retains durable session and bridge records.',schema:{agent_id:agentId}},
};
for(const [name,{description,schema}] of Object.entries(schemas))server.registerTool(name,{description,inputSchema:schema},async args=>{const value=await bridge.call(name,args);if(name==='capabilities')value.parent_worktree_workflow={enabled:process.env.LUNA_ENABLE_WORKTREE_WORKFLOW==='1',automatic_acl_changes:false,automatic_apply:false,automatic_discard:false};return output(value);});
if(process.env.LUNA_ENABLE_WORKTREE_WORKFLOW==='1'){
async function requireIdle(work){
 let files;try{files=await fs.readdir(path.join(stateDir,'agents'));}catch(e){if(e.code==='ENOENT')return;throw e;}
 for(const file of files.filter(f=>f.endsWith('.json'))){const r=JSON.parse(await fs.readFile(path.join(stateDir,'agents',file),'utf8'));const relative=path.relative(work,r.cwd??'');if((relative===''||(!relative.startsWith('..')&&!path.isAbsolute(relative)))&&['starting','running','cancelling'].includes(r.state))throw Error(`Stop or settle agent ${r.agent_id} before transferring this workspace`);}
}
server.registerTool('prepare_worktree',{description:'Parent-only Git preparation inside the approved Codex workspace. Uses current tracked bytes and selected untracked files, excludes credential candidates, creates a detached worktree and private baseline. No ACL changes or model calls. A new native write-sandbox grant still requires user confirmation for this exact worktree. Keep Git operations with the parent.',inputSchema:{request_id:requestId,source:z.string().min(1),includeUntracked:z.boolean().default(true),includeIgnored:z.array(z.string()).default([])}},async args=>output(await workflow.prepare(args)));
server.registerTool('worktree_status',{description:'Inspect a prepared worktree, exclusions, transfer state, conflicts and exact working path. Private snapshots remain outside Luna write scope.',inputSchema:{id:requestId}},async({id})=>output(await workflow.status(id)));
server.registerTool('collect_worktree',{description:'Freeze the settled worktree candidate outside the agent write root and show changed file hashes/existence relative to the current-byte task baseline. No source edits. Stop its active agents first.',inputSchema:{id:requestId,includeIgnored:z.array(z.string()).default([])}},async({id,includeIgnored})=>{await requireIdle((await workflow.status(id)).work);return output(await workflow.collect(id,{includeIgnored}));});
server.registerTool('apply_worktree',{description:'Parent-only apply of the collected authorized task delta to its original source. Requires a coordinated source-writer window. Any source HEAD/file/hash/type conflict stops before transfer; journal and raw snapshots preserve recovery. Does not stage/commit or change ACL. Call only within user-approved editing scope.',inputSchema:{id:requestId}},async({id})=>{const j=await workflow.status(id);await requireIdle(j.work);await requireIdle(j.source);return output(await workflow.apply(id));});
server.registerTool('recover_worktree',{description:'Reconcile an interrupted transfer journal against both saved versions. Does not overwrite source files. Conflicting later edits remain untouched; inspect before rollback.',inputSchema:{id:requestId}},async({id})=>output(await workflow.recover(id)));
server.registerTool('rollback_worktree',{description:'Restore only this transfer’s saved original bytes after verifying source still matches this transfer output. Refuses to overwrite later edits. No git reset or ACL changes.',inputSchema:{id:requestId}},async({id})=>{const j=await workflow.status(id);await requireIdle(j.source);return output(await workflow.rollback(id));});
server.registerTool('cleanup_worktree',{description:'Remove only this recorded disposable Git worktree after agents stop. Requires the collected candidate to match, unless discard=true explicitly authorizes dropping uncollected work. Removes ignored/generated worktree content too. Keeps private evidence and rollback snapshots.',inputSchema:{id:requestId,discard:z.boolean().default(false)}},async({id,discard})=>{await requireIdle((await workflow.status(id)).work);return output(await workflow.cleanup(id,{discard}));});
}
server.registerTool('wait_agent',{description:'Wait for a new message or settled state, then return the observed state. Does not restart or resend work.',inputSchema:{agent_id:agentId,after_message:z.number().int().nonnegative().default(0),wait_ms:z.number().int().nonnegative().default(10000)}},async args=>{
  const deadline=Date.now()+args.wait_ms;
  while(true){const status=await bridge.call('agent_status',{agent_id:args.agent_id});if(status.messages.length>args.after_message||!['running','starting','cancelling'].includes(status.state)||Date.now()>=deadline)return output(status);await new Promise(r=>setTimeout(r,250));}
});
await server.connect(new StdioServerTransport());
