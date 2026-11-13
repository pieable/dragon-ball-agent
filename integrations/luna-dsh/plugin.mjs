import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { setApprovalPolicy } from '@deepseek-ai/dsh-user-approval';
import { BridgeState } from './plugin-state.mjs';
import { startPluginTransport } from './plugin-transport.mjs';

export const name = 'luna-subagent-bridge';
export const inject = ['agents', 'sessions', 'tools', 'permissionPresets', 'approval', 'sessionPersistence'];
const here = path.dirname(fileURLToPath(import.meta.url));
const hostContext = `Execution context: You are an API Luna execution agent in DeepSeek Harness, delegated by the Codex parent. The parent owns the user conversation and final decisions. This task is your scope; the global/project AGENTS and relevant Skills provide the user's working requirements. Codex-specific tool names in those files describe another host: use the tools actually supplied in this session for the same authorized operation (DSH filesystem/search/PowerShell and skill loader). Do not invent unavailable FastCtx, apply_patch, browser, image generation, or Codex agent tools. If a required capability is absent, report that concrete dependency with report_to_parent and continue independent work. report_to_parent delivers a durable message to the parent inbox; the parent reads it via MCP. No parent conversation is automatically inherited beyond the context supplied below. This host pins OpenAI API Luna; do not launch another model or native Codex to obtain capabilities.`;

export async function apply(ctx, config = {}) {
  const stateDir = path.resolve(config.stateDir ?? process.env.LUNA_BRIDGE_STATE_DIR ?? path.join(here, '.bridge-state'));
  const state = new BridgeState(stateDir);
  const handles = new Map(), monitors = new Map();
  let closing = false, ready = false;
  const safe = value => {
    const text = JSON.stringify(value), key = process.env.LUNA_OPENAI_API_KEY;
    return JSON.parse(key ? text.split(key).join('[REDACTED_API_KEY]') : text);
  };
  const save = record => { Object.assign(record,safe(record));return state.save(record); };
  const get = id => { const record = state.agents.get(id); if (!record) throw new Error('Unknown bridge agent'); return record; };
  const report = async (record, kind, data) => {
    if(data.session_sequence!==undefined && record.messages.some(m=>m.kind===kind&&m.session_sequence===data.session_sequence))return;
    record.messages.push({ sequence: record.messages.length, kind, ...safe(data), at: new Date().toISOString() });
    await save(record);
  };
  const setup = record => (agentCtx, agent) => {
    ctx.get('permissionPresets').set(agent.session, record.permission_mode);
    setApprovalPolicy(agent.session, 'never');
    agentCtx.tools.register(defineTool({
      name: 'report_to_parent',
      description: 'Send a progress report, question, or blocker to the Codex parent. The parent can read it and send guidance while you work. Continue independent authorized work; a report does not itself guarantee the parent has read it.',
      parameters: { kind: { type: 'string', enum: ['progress','question','blocker'] }, message: { type: 'string', required: true } },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type:'text',text:value }] },
      async execute() { return 'Report recorded in the session for parent retrieval'; },
    }));
  };
  async function own(record) {
    if (handles.has(record.agent_id)) return handles.get(record.agent_id).agent;
    const handle = await ctx.agents.resume({ resumeSessionId: record.session_id, agentOptions: { provider:'luna-api',model:'gpt-6-luna',reasoningEffort:record.reasoning_effort }, setup: setup(record) });
    handle.agent.model.select({provider:'luna-api',model:'gpt-6-luna',reasoningEffort:record.reasoning_effort});
    handles.set(record.agent_id, handle);
    return handle.agent;
  }
  function monitor(record, agent) {
    if (monitors.has(record.agent_id)) return;
    const promise = (async () => {
      for (;;) {
        const generation = record.generation ?? 0;
        await agent.whenIdle();
        await ctx.sessions.flush(agent.session);
        await state.exclusive('events:'+record.agent_id,async()=>{});
        if (generation !== record.generation) continue;
        if (record.state !== 'closed') record.state = record.reason?.kind === 'completed' ? 'completed' : record.reason?.kind === 'error' ? 'failed' : record.state === 'cancelling' ? 'cancelled' : 'idle';
        await save(record);
        if (generation === record.generation) break;
      }
    })().catch(async error => { if(record.state!=='closed'){record.state='failed';record.error=error.message;await save(record);} }).finally(() => monitors.delete(record.agent_id));
    monitors.set(record.agent_id,promise);
  }
  async function capture(record,event,replay=false) {
    if(event.seq <= (record.last_session_sequence ?? -1)) return;
    if (event.type==='turn/start') { record.state=replay?'interrupted':'running'; record.reason=null; record.error=null; }
    if (event.type==='assistant/message') {
      const text=event.data.message.content.filter(b=>b.type==='text').map(b=>b.text).join('');
      if(text){record.result=text;await report(record,'assistant',{text,session_sequence:event.seq});}
      if(event.data.usage&&!record.usage.some(u=>u.session_sequence===event.seq))record.usage.push({...event.data.usage,session_sequence:event.seq});
    }
    if(event.type==='tool/call'&&event.data.name==='report_to_parent') {
      record.pending_report_calls??={};
      record.pending_report_calls[event.seq]={call_id:event.data.callId,arguments:event.data.arguments};
    }
    if(event.type==='tool/result') {
      for(const seq of event.sourceEventSeqs??[]) {
        const call=record.pending_report_calls?.[seq];
        if(!call)continue;
        if(event.data.message?.isError===false) {
          const args=typeof call.arguments==='string'?JSON.parse(call.arguments):call.arguments;
          await report(record,args.kind??'progress',{text:args.message,call_id:call.call_id,session_sequence:event.seq});
        }
        delete record.pending_report_calls[seq];
      }
    }
    if(event.type==='turn/end'){
      record.reason=event.data.reason;record.error=event.data.reason?.error?.message;
      await report(record,'turn_end',{reason:event.data.reason,session_sequence:event.seq});
      if(replay)record.state=record.reason?.kind==='completed'?'completed':record.reason?.kind==='error'?'failed':'interrupted';
    }
    record.last_session_sequence=event.seq;
    await save(record);
  }
  // Serialize ingestion as well as disk writes: event evidence has one ordered cursor.
  ctx.on('session/event', async (session,event) => {
    const record = [...state.agents.values()].find(r => r.session_id === session.id);
    if(record)await state.exclusive('events:'+record.agent_id,()=>capture(record,event));
  });
  ctx.on('agent/error', async ({agent,error}) => {
    const record=state.agents.get(agent.id);if(record){record.error=error.message;record.state='failed';await save(record);}
  });
  const dispatch = async (operation,args) => {
    if (closing) throw new Error('Plugin is shutting down');
    if (!ready) throw new Error('Plugin is initializing');
    if(operation==='shutdown') {
      setTimeout(async()=>{await transport.close();ctx.get('appExit')?.(0);},50);
      return {stopping:true};
    }
    if(operation==='capabilities')return {provider:'luna-api',model:'gpt-6-luna',operations:['spawn_agent','send_message','interrupt_agent','close_agent','agent_status','list_agents','read_messages'],transport:'DSH plugin',nested_delegation:false,shared_instructions_root:process.env.DSH_AGENTS_HOME??null,context_inheritance:'Explicit MCP context plus native global/project AGENTS and discovered Skills'};
    if(operation==='list_agents')return [...state.agents.values()].map(({messages,result,usage,...r})=>r);
    if(operation==='agent_status')return safe(get(args.agent_id));
    if(operation==='read_messages'){const r=get(args.agent_id);const offset=args.offset??0;return {messages:r.messages.slice(offset),next_offset:r.messages.length};}
    if(operation==='spawn_agent')return state.once(args.request_id,{operation,...args},async()=>{
      const cwd=await fs.realpath(args.cwd);if(!(await fs.stat(cwd)).isDirectory())throw new Error('cwd must be a directory');
      const permission=args.permission_mode??'read-only';if(!['read-only','workspace-write'].includes(permission))throw new Error('Unsupported permission mode');
      const effort=args.reasoning_effort??'medium';if(!['off','low','medium','high','xhigh','max'].includes(effort))throw new Error('Unsupported reasoning effort');
      if(typeof args.prompt!=='string'||!args.prompt.trim())throw new Error('prompt is required');
      const id=`session-${randomUUID()}`;
      const record={agent_id:id,session_id:id,cwd,permission_mode:permission,reasoning_effort:effort,state:'starting',generation:0,messages:[],usage:[],created_at:new Date().toISOString()};
      return state.exclusive(id,async()=>{
      await save(record);
      try {
        const handle=await ctx.agents.create({sessionId:id,meta:{cwd},agentOptions:{provider:'luna-api',model:'gpt-6-luna',reasoningEffort:effort},setup:setup(record)});
        handles.set(id,handle);
        const prompt=`${hostContext}\n\nDelegation background:\n${args.context??'(No additional context supplied.)'}\n\nCurrent task:\n${args.prompt}`;
        record.generation++;
        handle.agent.followup(createUserMessage({content:[{type:'text',text:prompt}],source:{kind:'user'}}));
        record.state='running';await save(record);monitor(record,handle.agent);
        return {agent_id:id,state:record.state};
      }catch(error){record.state='failed';record.error=error.message;await save(record);throw error;}
      });
    });
    if(operation==='send_message')return state.once(args.request_id,{operation,...args},()=>state.exclusive(args.agent_id,async()=>{
      const record=get(args.agent_id);if(record.state==='closed')throw new Error('Agent is closed');
      if(typeof args.message!=='string'||!args.message.trim())throw new Error('message is required');
      const mode=args.mode??'followup';if(!['followup','steer','inject'].includes(mode))throw new Error('Unsupported message mode');
      const agent=await own(record);
      if(mode!=='inject')record.generation=(record.generation??0)+1;
      agent[mode](createUserMessage({content:[{type:'text',text:args.message}],source:{kind:'user'}}));
      await report(record,'parent_message',{text:args.message,mode,request_id:args.request_id});
      if(mode!=='inject'){record.state='running';await save(record);monitor(record,agent);}
      return {agent_id:record.agent_id,accepted:true,mode};
    }));
    if(operation==='interrupt_agent'||operation==='close_agent')return state.exclusive(args.agent_id,async()=>{
      const record=get(args.agent_id),handle=handles.get(record.agent_id);
      if(record.state==='closed')return safe(record);
      if(handle){record.state='cancelling';handle.agent.cancel({kind:'user'});await handle.agent.whenIdle();await monitors.get(record.agent_id);await ctx.sessions.flush(handle.agent.session);}
      record.state=operation==='close_agent'?'closed':'cancelled';await save(record);
      if(operation==='close_agent'&&handle){await handle.dispose();handles.delete(record.agent_id);}
      return safe(record);
    });
    throw new Error(`Unknown operation: ${operation}`);
  };
  const transport=await startPluginTransport({stateDir:path.join(stateDir,'transport'),dispatch,onClose:async()=>{closing=true;for(const h of handles.values())h.agent.cancel({kind:'user'});await Promise.all([...handles.values()].map(h=>h.dispose()));}});
  await state.load();
  for(const record of state.agents.values()) {
    let reader;
    const wasClosed=record.state==='closed';
    try {
      reader=await ctx.sessionPersistence.open(record.session_id,'read');
      const {events}=await reader.read();
      for(const event of events)await capture(record,event,true);
      if(wasClosed)record.state='closed';
      record.recovery_error=null;await save(record);
    } catch(error) {record.recovery_error=error.message;await save(record);}
    finally {await reader?.close();}
  }
  ready=true;
  ctx.effect(()=>()=>transport.close(),'luna-subagent-bridge.transport');
}
