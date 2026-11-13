import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureHost } from './host-launcher.mjs';
const here=path.dirname(fileURLToPath(import.meta.url));
const stateDir=path.resolve(process.env.LUNA_BRIDGE_STATE_DIR??path.join(here,'.bridge-state'));
const bridge={async call(operation,args){const {client}=await ensureHost({stateDir});return client.call(operation,args);}};
const server=new McpServer({name:'luna-dsh-plugin',version:'0.2.0'});
const output=value=>({content:[{type:'text',text:JSON.stringify(value)}]});
const agentId=z.string().min(1),requestId=z.string().uuid();
const schemas={
  capabilities:{description:'Read the running DSH plugin capabilities and model route.',schema:{}},
  spawn_agent:{description:'Create an independent API Luna agent. Include necessary context, source material paths, constraints, and acceptance criteria. The child does not automatically see this Codex conversation. Uses API credits. Returns immediately.',schema:{request_id:requestId,prompt:z.string().min(1),cwd:z.string().min(1),context:z.string().optional(),permission_mode:z.enum(['read-only','workspace-write']).default('read-only'),reasoning_effort:z.enum(['off','low','medium','high','xhigh','max']).default('medium')}},
  send_message:{description:'Send to an existing agent. followup queues the next turn; steer supplies next-step guidance while running; inject stores context without waking it. Reuse request_id on uncertain retries.',schema:{request_id:requestId,agent_id:agentId,message:z.string().min(1),mode:z.enum(['followup','steer','inject']).default('followup')}},
  agent_status:{description:'Read the actual DSH agent state, durable final output, provider error, token usage and messages.',schema:{agent_id:agentId}},
  list_agents:{description:'Find bridge-owned agents, including persisted agents after host restart.',schema:{}},
  read_messages:{description:'Read reports, questions, parent message receipts and completed turn messages since offset. This is the inbound side of Codex–DSH communication.',schema:{agent_id:agentId,offset:z.number().int().nonnegative().default(0)}},
  interrupt_agent:{description:'Cancel active and queued work through the native DSH Agent API and wait for settlement. Existing file changes remain. The same agent can receive a new task later.',schema:{agent_id:agentId}},
  close_agent:{description:'Cancel and release this agent through its native DSH handle. Retains durable session and bridge records.',schema:{agent_id:agentId}},
};
for(const [name,{description,schema}] of Object.entries(schemas))server.registerTool(name,{description,inputSchema:schema},async args=>output(await bridge.call(name,args)));
server.registerTool('wait_agent',{description:'Wait for a new message or settled state, then return the observed state. Does not restart or resend work.',inputSchema:{agent_id:agentId,after_message:z.number().int().nonnegative().default(0),wait_ms:z.number().int().nonnegative().default(10000)}},async args=>{
  const deadline=Date.now()+args.wait_ms;
  while(true){const status=await bridge.call('agent_status',{agent_id:args.agent_id});if(status.messages.length>args.after_message||!['running','starting','cancelling'].includes(status.state)||Date.now()>=deadline)return output(status);await new Promise(r=>setTimeout(r,250));}
});
await server.connect(new StdioServerTransport());
