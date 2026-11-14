import {randomUUID} from 'node:crypto';
const str={type:'string',required:true};
const effort={type:'string',enum:['off','low','medium','high','xhigh','max']};
export function installCoordinatorTools({register,record,dispatch,inheritContext}) {
  const add=(name,description,parameters,execute)=>register({name,description,parameters,output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},async execute(args,exec){return JSON.stringify(await execute(args,exec));}});
  add('spawn_agent','Delegate a scoped task to a worker, explorer or web-researcher. Supply a contract and explicitly choose fork_turns none or the smallest positive count of relevant recorded turns. Child gets its own role instructions and permissions.',{role:{type:'string',enum:['worker','explorer','web-researcher'],required:true},prompt:str,context:{type:'string'},cwd:{type:'string'},permission_mode:{type:'string',enum:['read-only','workspace-write']},fork_turns:str,reasoning_effort:effort},async args=>{
    if(args.fork_turns!=='none'&&(!/^[1-9][0-9]*$/.test(args.fork_turns)||!Number.isSafeInteger(Number(args.fork_turns))))throw new Error('fork_turns must be none or a positive integer');
    const inherited=args.fork_turns==='none'?'':await inheritContext(Number(args.fork_turns));
    return dispatch('spawn_agent',{request_id:randomUUID(),role:args.role,reasoning_effort:args.reasoning_effort,prompt:args.prompt,cwd:args.cwd??record.cwd,permission_mode:args.permission_mode??(args.role==='explorer'?'read-only':record.permission_mode),context:[args.context,inherited&&`Selected parent conversation evidence:\n${inherited}`].filter(Boolean).join('\n\n')});
  });
  add('send_message','Give an owned child followup, steering or non-waking context. Optional reasoning_effort affects its next model request, including a running turn’s later steps, not an in-flight request.',{agent_id:str,message:str,mode:{type:'string',enum:['followup','steer','inject']},reasoning_effort:effort},args=>dispatch('send_message',{request_id:randomUUID(),...args}));
  add('set_reasoning_effort','Change an owned child’s depth from its next model request; preserve session and permissions, do not wake it. Wait until idle for a clean stage boundary.',{agent_id:str,reasoning_effort:{...effort,required:true}},args=>dispatch('set_reasoning_effort',{request_id:randomUUID(),...args}));
  add('agent_status','Read an owned child result, role, tools and status.',{agent_id:str},args=>dispatch('agent_status',args));
  add('list_agents','List this stage owner’s children.',{},()=>dispatch('list_agents',{}));
  add('wait_agent','Wait for a child result or new report, while respecting cancellation. No work is resubmitted.',{agent_id:str,after_message:{type:'number'},wait_ms:{type:'number'}},(args,exec)=>dispatch('wait_child',{...args,signal:exec.signal}));
  add('interrupt_agent','Cancel an owned child’s active and queued work. Existing file changes remain.',{agent_id:str},args=>dispatch('interrupt_agent',args));
  add('close_agent','Close an owned child while preserving its evidence.',{agent_id:str},args=>dispatch('close_agent',args));
  add('request_parent_task','Ask the Codex parent to arrange a reviewer or visual-usability-tester task. Records a pending contract, does not pretend the Codex task has started. Continue independent work; the parent supplies the result later.',{role:{type:'string',enum:['reviewer','visual-usability-tester'],required:true},task:str,evidence:{type:'string'}},args=>dispatch('request_parent_task',args));
}
