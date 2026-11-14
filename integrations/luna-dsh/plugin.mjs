import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { setApprovalPolicy } from '@deepseek-ai/dsh-user-approval';
import { BridgeState } from './plugin-state.mjs';
import { startPluginTransport } from './plugin-transport.mjs';
import { loadRoleCatalog, requireRole } from './role-catalog.mjs';
import { runMeteredSearch } from './metered-search.mjs';
import { installCoordinatorTools } from './coordination-tools.mjs';
import { withActiveParent, queueNotification } from './coordination-lifecycle.mjs';
import { normalizeEffort, selectionFor } from './reasoning-selection.mjs';

export const name = 'luna-subagent-bridge';
export const inject = ['agents', 'sessions', 'tools', 'permissionPresets', 'approval', 'sessionPersistence', 'systemPrompt'];
const here = path.dirname(fileURLToPath(import.meta.url));
const hostContext = `Execution context: You are an API Luna execution agent in DeepSeek Harness, delegated by the Codex parent. The parent owns the user conversation and final decisions. This task is your scope; the global/project AGENTS and relevant Skills provide the user's working requirements. Codex-specific tool names in those files describe another host: use the tools actually supplied in this session for the same authorized operation (DSH filesystem/search/PowerShell and skill loader). Do not invent unavailable FastCtx, apply_patch, browser, image generation, or Codex agent tools. If a required capability is absent, report that concrete dependency with report_to_parent and continue independent work. report_to_parent delivers a durable message to the parent inbox; the parent reads it via MCP. No parent conversation is automatically inherited beyond the context supplied below. This host pins OpenAI API Luna; do not launch another model or native Codex to obtain capabilities.`;

export async function apply(ctx, config = {}) {
  const stateDir = path.resolve(config.stateDir ?? process.env.LUNA_BRIDGE_STATE_DIR ?? path.join(here, '.bridge-state'));
  const state = new BridgeState(stateDir);
  const handles = new Map(), monitors = new Map(), childWaiters=new Set(),notifications=new Map(),stops=new Map();
  let closing = false, ready = false;
  const safe = value => {
    const text = JSON.stringify(value), key = process.env.LUNA_OPENAI_API_KEY;
    return JSON.parse(key ? text.split(key).join('[REDACTED_API_KEY]') : text);
  };
  const redactRecord = value => {
    const key=process.env.LUNA_OPENAI_API_KEY;
    if(!key)return value;
    if(typeof value==='string')return value.includes(key)?value.split(key).join('[REDACTED_API_KEY]'):value;
    if(value===null||typeof value!=='object')return value;
    if(Object.isFrozen(value))return safe(value);
    for(const name of Object.keys(value)) {
      const next=redactRecord(value[name]);if(next!==value[name])value[name]=next;
    }
    return value;
  };
  const save = record => {redactRecord(record);return state.save(record);};
  const publicRecord = record => {const {role_instructions,delegation_context,...visible}=record;return safe(visible);};
  const catalog = () => loadRoleCatalog({codexHome:config.codexHome??process.env.DSH_AGENTS_HOME});
  const get = id => { const record = state.agents.get(id); if (!record) throw new Error('Unknown bridge agent'); return record; };
  const report = async (record, kind, data) => {
    if(data.session_sequence!==undefined && record.messages.some(m=>m.kind===kind&&m.session_sequence===data.session_sequence))return;
    record.messages.push({ sequence: record.messages.length, kind, ...safe(data), at: new Date().toISOString() });
    await save(record);
  };
  const setup = record => (agentCtx, agent) => {
    ctx.get('permissionPresets').set(agent.session, record.permission_mode);
    setApprovalPolicy(agent.session, 'never');
    if(!record.role_instructions)throw new Error('Legacy untyped agent cannot be resumed as a named role');
    agentCtx.systemPrompt.section({name:'luna:role',order:10150,text:record.role_instructions,interpolate:false});
    agentCtx.systemPrompt.section({name:'luna:host',order:10210,text:hostContext,interpolate:false});
    if(record.role==='code-executor')agentCtx.systemPrompt.section({name:'luna:coordination',order:10220,text:'Use the supplied native spawn_agent/send_message/wait_agent tools to manage Luna children. reviewer and visual-usability-tester stay in Codex: submit their complete contracts with request_parent_task, then consume the actual returned results before claiming those checks complete. Child completion is synchronized into your conversation; verify evidence and continue integration.',interpolate:false});
    if(record.role==='explorer') {
      const allowed=new Set(['read','glob','grep','skill','pwsh','read_image','job_output','job_list']);
      agentCtx.tools.restrict({allow:ctx.tools.schemas().map(t=>t.name).filter(n=>allowed.has(n))});
    }

    agentCtx.tools.register(defineTool({
      name: 'report_to_parent',
      description: 'Send a progress report, question, or blocker to the Codex parent. The parent can read it and send guidance while you work. Continue independent authorized work; a report does not itself guarantee the parent has read it.',
      parameters: { kind: { type: 'string', enum: ['progress','question','blocker'] }, message: { type: 'string', required: true } },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type:'text',text:value }] },
      async execute() { return 'Report recorded in the session for parent retrieval'; },
    }));
    if(record.role==='web-researcher')agentCtx.tools.register(defineTool({
      name:'search_web',description:'Search the live web using OpenAI hosted web search with API Luna. Returns actual search sources, URL citations and usage. Each call incurs an additional API request and search charge; use fetch to inspect chosen primary sources.',
      parameters:{query:{type:'string',required:true}},
      output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},
      async execute(args,exec){return JSON.stringify(await runMeteredSearch({query:args.query,effort:record.reasoning_effort==='off'?'none':record.reasoning_effort,signal:exec.signal},{record,save,sanitize:safe}));},
    }));
    if(record.role==='code-executor')installCoordinatorTools({
      record,register:definition=>agentCtx.tools.register(defineTool(definition)),
      dispatch:(operation,args)=>coordinatorDispatch(record,operation,args),
      inheritContext:count=>inheritTurns(record,count),
    });
    record.available_tools=ctx.tools.schemas(agent).map(t=>t.name);
  };
  async function inheritTurns(record,count) {
    const handle=handles.get(record.agent_id);if(handle)await ctx.sessions.flush(handle.agent.session);
    const reader=await ctx.sessionPersistence.open(record.session_id,'read');
    try {
      const {events}=await reader.read();const starts=events.filter(e=>e.type==='turn/start');
      const first=starts[Math.max(0,starts.length-count)]?.seq??0;
      const boundary=events.filter(e=>e.type==='turn/end'&&e.seq<first).at(-1)?.seq??-1;
      return JSON.stringify(events.filter(e=>e.seq>boundary&&['user/message','assistant/message','tool/result'].includes(e.type)).map(e=>({type:e.type,sequence:e.seq,message:e.type==='user/message'?e.data:e.data.message})));
    } finally {await reader.close();}
  }
  async function coordinatorDispatch(parent,operation,args) {
    if(!['agent_status','list_agents','wait_child'].includes(operation)&&['cancelling','cancelled','closed','interrupted'].includes(parent.state))throw new Error('Parent stage is stopped');
    if(operation==='spawn_agent')return dispatch(operation,args,parent);
    if(operation==='list_agents')return [...state.agents.values()].filter(r=>r.parent_agent_id===parent.agent_id).map(publicRecord);
    if(operation==='request_parent_task') {
      const request={id:randomUUID(),role:args.role,task:args.task,evidence:args.evidence??'',state:'pending',created_at:new Date().toISOString()};
      parent.parent_tasks??=[];parent.parent_tasks.push(request);await report(parent,'parent_task',request);return request;
    }
    const child=get(args.agent_id);if(child.parent_agent_id!==parent.agent_id)throw new Error('This agent is not an owned child');
    if(operation==='wait_child') {
      const deadline=Date.now()+(args.wait_ms??10000);childWaiters.add(child.agent_id);
      try{while(true){args.signal?.throwIfAborted();if(!['running','starting','cancelling'].includes(child.state)||child.messages.length>(args.after_message??0)||Date.now()>=deadline)return publicRecord(child);await new Promise(r=>setTimeout(r,100));}}
      finally{childWaiters.delete(child.agent_id);}
    }
    return dispatch(operation,args,{requesting_parent:parent});
  }
  async function notifyParent(record,snapshot) {
    if(!record.parent_agent_id||record.notified_generations?.includes(snapshot.generation))return;
    const parent=get(record.parent_agent_id);
    await report(parent,'child_result',{agent_id:record.agent_id,role:record.role,state:snapshot.state,result:snapshot.result,error:snapshot.error,generation:snapshot.generation});
    if(!childWaiters.has(record.agent_id)&&!['closed','cancelled','cancelling','interrupted'].includes(parent.state)) {
      await dispatch('send_message',{request_id:randomUUID(),agent_id:parent.agent_id,mode:'followup',message:`Child result available. Verify its evidence and continue the assigned stage.\n${JSON.stringify(snapshot)}`},{notification:true});
    }
    record.notified_generations??=[];if(!record.notified_generations.includes(snapshot.generation))record.notified_generations.push(snapshot.generation);await save(record);
  }
  async function own(record) {
    if (handles.has(record.agent_id)) return handles.get(record.agent_id).agent;
    const handle = await ctx.agents.resume({ resumeSessionId: record.session_id, agentOptions: selectionFor(record), setup: setup(record) });
    handle.agent.model.select(selectionFor(record));
    handles.set(record.agent_id, handle);
    return handle.agent;
  }
  async function changeEffort(record, agent, requested) {
    const effort=normalizeEffort(requested);
    const previous=record.reasoning_effort;
    agent.model.select(selectionFor(record,effort));
    record.reasoning_effort=effort;
    await ctx.sessions.flush(agent.session);
    await report(record,'reasoning_selection',{previous,effort,effective:'next model request; does not alter an in-flight request'});
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
        if (generation === record.generation) {const snapshot=publicRecord(record);queueNotification(notifications,`${record.agent_id}:${generation}`,()=>notifyParent(record,snapshot),async error=>{record.notification_error=error.message;await save(record);});break;}
      }
    })().catch(async error => { if(record.state!=='closed'){record.state='failed';record.error=error.message;await save(record);} }).finally(() => monitors.delete(record.agent_id));
    monitors.set(record.agent_id,promise);
  }
  async function capture(record,event,replay=false) {
    if(event.seq <= (record.last_session_sequence ?? -1)) return;
    if(event.type==='model/selection' && event.data?.model==='gpt-6-luna') {
      record.provider=event.data.provider;
      record.reasoning_effort=normalizeEffort(event.data.reasoningEffort);
    }
    if(event.type==='request/header') {
      record.last_request_selection=event.data.config;
    }
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
  function stopAgent(id,close) {
    const existing=stops.get(id);
    if(existing){if(close)existing.close=true;return existing.promise.then(result=>close&&result.state!=='closed'?stopAgent(id,true):result);}
    const entry={close};
    entry.promise=(async()=>{
      const prepared=await state.exclusive(id,async()=>{
        const record=get(id),handle=handles.get(id);
        if(record.state==='closed')return {record,alreadyClosed:true};
        record.state='cancelling';for(const task of record.parent_tasks??[])if(['pending','resolving'].includes(task.state))task.state='cancelled';await save(record);if(handle)handle.agent.cancel({kind:'user'});
        return {record,handle,children:[...state.agents.values()].filter(r=>r.parent_agent_id===id&&r.state!=='closed')};
      });
      const {record,handle}=prepared;if(prepared.alreadyClosed)return publicRecord(record);
      // Never retain the parent admission lock while awaiting its active tool.
      // A pending spawn tool must acquire that lock, observe cancelling, and exit.
      await Promise.all(prepared.children.map(r=>stopAgent(r.agent_id,entry.close)));
      if(handle){await handle.agent.whenIdle();await monitors.get(id);await ctx.sessions.flush(handle.agent.session);}
      return state.exclusive(id,async()=>{
        record.state=entry.close?'closed':'cancelled';await save(record);
        if(entry.close&&handle){await handle.dispose();handles.delete(id);}
        return publicRecord(record);
      });
    })().finally(()=>{if(stops.get(id)===entry)stops.delete(id);});
    stops.set(id,entry);return entry.promise;
  }
  const dispatch = async (operation,args,actor=null) => {
    if (closing) throw new Error('Plugin is shutting down');
    if (!ready) throw new Error('Plugin is initializing');
    if(operation==='shutdown') {
      setTimeout(async()=>{await transport.close();ctx.get('appExit')?.(0);},50);
      return {stopping:true};
    }
    if(operation==='capabilities')return {role_protocol_version:1,effort_protocol_version:1,provider:'openai',model:'gpt-6-luna',operations:['spawn_agent','send_message','set_reasoning_effort','interrupt_agent','close_agent','agent_status','list_agents','read_messages','list_roles'],roles:['worker','explorer','code-executor','web-researcher'],transport:'DSH plugin',nested_delegation:'code-executor to worker/explorer/web-researcher',shared_instructions_root:process.env.DSH_AGENTS_HOME??null,context_inheritance:'Explicit MCP context plus native global/project AGENTS and discovered Skills'};
    if(operation==='list_roles'){const c=await catalog();return {roles:c.roles.map(({developer_instructions,...r})=>r),codex_only:c.codex_only};}
    if(operation==='list_agents')return [...state.agents.values()].map(({messages,result,usage,...r})=>publicRecord(r));
    if(operation==='agent_status')return publicRecord(get(args.agent_id));
    if(operation==='read_messages'){const r=get(args.agent_id);const offset=args.offset??0;return {messages:r.messages.slice(offset),next_offset:r.messages.length};}
    if(operation==='pending_parent_tasks')return [...state.agents.values()].flatMap(r=>(r.parent_tasks??[]).filter(t=>['pending','resolving'].includes(t.state)).map(t=>({agent_id:r.agent_id,...t})));
    if(operation==='resolve_parent_task') {
      const record=get(args.agent_id);
      const task=await state.exclusive(record.agent_id,async()=>{
        const task=(record.parent_tasks??[]).find(t=>t.id===args.task_id);if(!task)throw new Error('Unknown parent task');
        if(stops.has(record.agent_id)||task.state==='cancelled')throw new Error('Parent task was cancelled with its stage');
        if(task.result!==undefined&&task.result!==args.result)throw new Error('Parent task already has a different result');
        if(task.state==='resolved')return task;
        task.result=args.result;task.state='resolving';task.delivery_request_id??=args.request_id;await save(record);return task;
      });
      if(task.state==='resolved')return {resolved:true,duplicate:true};
      await dispatch('send_message',{request_id:task.delivery_request_id,agent_id:record.agent_id,message:`Parent-supplied ${task.role} result for request ${task.id}:\n${args.result}`},{parent_task:task.id});
      return state.exclusive(record.agent_id,async()=>{
        if(stops.has(record.agent_id)||task.state==='cancelled')throw new Error('Parent task was cancelled with its stage');
        task.state='resolved';await save(record);return {resolved:true};
      });
    }
    if(operation==='spawn_agent')return state.once(args.request_id,{operation,...args},async()=>{
      const currentCatalog=await catalog();const role=requireRole(currentCatalog,args.role);
      const cwd=await fs.realpath(args.cwd);if(!(await fs.stat(cwd)).isDirectory())throw new Error('cwd must be a directory');
      const permission=args.permission_mode??'read-only';if(!['read-only','workspace-write'].includes(permission))throw new Error('Unsupported permission mode');
      if(role.name==='explorer'&&permission!=='read-only')throw new Error('Explorer is a read-only role');
      const effort=normalizeEffort(args.reasoning_effort??role.effort);
      if(typeof args.prompt!=='string'||!args.prompt.trim())throw new Error('prompt is required');
      const depth=(actor?.depth??0)+1;
      if(currentCatalog.limits?.max_depth!==undefined&&depth>currentCatalog.limits.max_depth)throw new Error('Delegation exceeds the current Codex depth limit');
      if(actor) {
        if(actor.permission_mode==='read-only'&&permission!=='read-only')throw new Error('Child cannot exceed parent write permission');
        if(permission==='workspace-write'){const relative=path.relative(actor.cwd,cwd);if(relative.startsWith('..')||path.isAbsolute(relative))throw new Error('Child write root must remain within the parent write root');}
      }
      const id=`session-${randomUUID()}`;
      const record={agent_id:id,session_id:id,provider:'openai',role:role.name,depth,root_group_id:actor?.root_group_id??id,parent_agent_id:actor?.agent_id??null,role_source:role.source,role_instructions:role.developer_instructions,delegation_context:args.context??'',cwd,permission_mode:permission,reasoning_effort:effort,state:'starting',generation:0,messages:[],usage:[],created_at:new Date().toISOString()};
      return withActiveParent(state,actor,()=>state.exclusive(id,async()=>{
      if(actor&&stops.has(actor.agent_id))throw new Error('Parent stage is stopping');
      await state.exclusive('admission',async()=>{
        const limit=currentCatalog.limits?.max_concurrent_threads_per_session;
        const active=[...state.agents.values()].filter(r=>r.root_group_id===record.root_group_id&&['starting','running','cancelling'].includes(r.state)).length;
        if(Number.isInteger(limit)&&active>=limit)throw new Error('Current Codex concurrent-thread limit reached for this task tree');
        await save(record);
      });
      try {
        const handle=await ctx.agents.create({sessionId:id,meta:{cwd},agentOptions:selectionFor(record),setup:setup(record)});
        handles.set(id,handle);
        const prompt=`${hostContext}\n\nDelegation background:\n${args.context??'(No additional context supplied.)'}\n\nCurrent task:\n${args.prompt}`;
        record.generation++;
        handle.agent.followup(createUserMessage({content:[{type:'text',text:prompt}],source:{kind:'user'}}));
        record.state='running';await save(record);monitor(record,handle.agent);
        return {agent_id:id,state:record.state};
      }catch(error){record.state='failed';record.error=error.message;await save(record);throw error;}
      }));
    });
    if(operation==='set_reasoning_effort')return state.once(args.request_id,{operation,...args},()=>state.exclusive(args.agent_id,async()=>{
      const record=get(args.agent_id);
      if(actor?.requesting_parent&&(stops.has(actor.requesting_parent.agent_id)||['cancelling','cancelled','closed','interrupted'].includes(actor.requesting_parent.state)))throw new Error('Requesting parent stage is stopped');
      if(stops.has(record.agent_id)||['closed','cancelling'].includes(record.state))throw new Error('Agent is closed or cancellation is settling');
      const effort=normalizeEffort(args.reasoning_effort);
      const agent=await own(record);
      await changeEffort(record,agent,effort);
      return {agent_id:record.agent_id,session_id:record.session_id,reasoning_effort:effort,effective:'next model request',wakes_agent:false,provider:record.provider??'luna-api'};
    }));
    if(operation==='send_message')return state.once(args.request_id,{operation,...args},()=>state.exclusive(args.agent_id,async()=>{
      const record=get(args.agent_id);if(stops.has(record.agent_id))throw new Error('Agent cancellation is still settling');if(actor?.parent_task&&(record.parent_tasks??[]).find(t=>t.id===actor.parent_task)?.state!=='resolving')throw new Error('Parent task was cancelled with its stage');if(actor?.requesting_parent&&(stops.has(actor.requesting_parent.agent_id)||['cancelling','cancelled','closed','interrupted'].includes(actor.requesting_parent.state)))throw new Error('Requesting parent stage is stopped');if(actor?.notification&&['cancelling','cancelled','closed','interrupted'].includes(record.state))return {skipped:true,state:record.state};if(record.state==='closed')throw new Error('Agent is closed');if(record.state==='cancelling')throw new Error('Agent cancellation is still settling');
      if(typeof args.message!=='string'||!args.message.trim())throw new Error('message is required');
      const mode=args.mode??'followup';if(!['followup','steer','inject'].includes(mode))throw new Error('Unsupported message mode');
      if(args.reasoning_effort!==undefined)normalizeEffort(args.reasoning_effort);
      const agent=await own(record);
      if(args.reasoning_effort!==undefined)await changeEffort(record,agent,args.reasoning_effort);
      if(mode!=='inject')record.generation=(record.generation??0)+1;
      agent[mode](createUserMessage({content:[{type:'text',text:args.message}],source:{kind:'user'}}));
      await report(record,'parent_message',{text:args.message,mode,request_id:args.request_id});
      if(mode!=='inject'){record.state='running';await save(record);monitor(record,agent);}
      return {agent_id:record.agent_id,accepted:true,mode};
    }));
    if(operation==='interrupt_agent'||operation==='close_agent')return stopAgent(args.agent_id,operation==='close_agent');
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
