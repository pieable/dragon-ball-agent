import { resolveRuntime } from '../host-launcher.mjs';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { connectPluginTransport } from '../plugin-transport.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
await fs.mkdir(path.join(root,'.tests-tmp'),{recursive:true});
const tmp=await fs.mkdtemp(path.join(root,'.tests-tmp','native-'));
const state=path.join(tmp,'bridge'),home=path.join(tmp,'home'),profile=path.join(home,'profiles','luna-subagent');
await fs.mkdir(path.join(profile,'node_modules'),{recursive:true});
await fs.symlink(root,path.join(profile,'node_modules','luna-dsh-subagent-mcp'),'junction');
await fs.writeFile(path.join(profile,'package.json'),JSON.stringify({name:'luna-test-profile',private:true,dependencies:{'luna-dsh-subagent-mcp':`link:${root.replaceAll('\\','/')}`},dsh:{profile:{bundles:['@deepseek-ai/dsh-base','luna-dsh-subagent-mcp']}}}));
for(const file of ['cordis.yml','cordis.patch.yml'])await fs.writeFile(path.join(profile,file),'[]');
await fs.writeFile(path.join(tmp,'fixture.txt'),'NATIVE_FILE_CONTENT');
const agentsHome=path.join(tmp,'shared-agents');await fs.mkdir(path.join(agentsHome,'skills','fixture-skill'),{recursive:true});
await fs.writeFile(path.join(agentsHome,'AGENTS.md'),'GLOBAL_GUIDANCE_FIXTURE: perform only the assigned test.');
await fs.writeFile(path.join(tmp,'AGENTS.md'),'PROJECT_GUIDANCE_FIXTURE: this is an isolated fixture.');
await fs.writeFile(path.join(agentsHome,'skills','fixture-skill','SKILL.md'),'---\nname: fixture-skill\ndescription: SKILL_CATALOG_FIXTURE for isolated reads\n---\nSKILL_BODY_FIXTURE\n');

let requests=0,hold=false,writePhase=false,writeIssued=false,writeTarget='',providerFailure=false;
const api=http.createServer(async(req,res)=>{
  let body='';for await(const b of req)body+=b;
  assert.equal(req.url,'/v1/responses');const input=JSON.parse(body);assert.equal(input.model,'gpt-6-luna');requests++;
  if(hold)return;
  if(providerFailure){res.writeHead(401,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{message:'NATIVE_PROVIDER_401',type:'authentication_error',code:'invalid_api_key'}}));return;}
  const toolRound=requests===1;
  if(toolRound){const payload=JSON.stringify(input);assert.ok(payload.includes('GLOBAL_GUIDANCE_FIXTURE'),'global instructions loaded');assert.ok(payload.includes('PROJECT_GUIDANCE_FIXTURE'),'project instructions loaded');assert.ok(payload.includes('fixture-skill'),'personal skill catalog loaded');}
  const writeRound=writePhase&&!writeIssued;if(writeRound)writeIssued=true;
  const items=writeRound?[{id:'fc_write',type:'function_call',call_id:'call_write',name:'write',arguments:JSON.stringify({file_path:writeTarget,content:'NATIVE_WRITE_CONTENT'}),status:'completed'}]:toolRound?[
    {id:'fc_read',type:'function_call',call_id:'call_read',name:'read',arguments:JSON.stringify({file_path:'fixture.txt'}),status:'completed'},
    {id:'fc_report',type:'function_call',call_id:'call_report',name:'report_to_parent',arguments:JSON.stringify({kind:'progress',message:'NATIVE_PARENT_REPORT'}),status:'completed'},
  ]:[{id:`msg_${requests}`,type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'PLUGIN_COMPLETE',annotations:[]}]}];
  if(requests===2)assert.ok(JSON.stringify(input.input).includes('NATIVE_FILE_CONTENT'),'actual scoped file read');
  const response={id:`resp_${requests}`,object:'response',created_at:1,model:'gpt-6-luna',status:'completed',output:items,usage:{input_tokens:10,output_tokens:4,total_tokens:14,input_tokens_details:{cached_tokens:0},output_tokens_details:{reasoning_tokens:0}}};
  res.writeHead(200,{'Content-Type':'text/event-stream'});const send=e=>res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  send({type:'response.created',response:{...response,status:'in_progress',output:[]}});
  for(let i=0;i<items.length;i++){
    const item=items[i];send({type:'response.output_item.added',output_index:i,item:{...item,status:'in_progress',...(item.type==='function_call'?{arguments:''}:{content:[]})}});
    if(item.type==='function_call'){
      send({type:'response.function_call_arguments.delta',item_id:item.id,output_index:i,delta:item.arguments});send({type:'response.function_call_arguments.done',item_id:item.id,output_index:i,arguments:item.arguments});
    }else{
      send({type:'response.content_part.added',item_id:item.id,output_index:i,content_index:0,part:{type:'output_text',text:'',annotations:[]}});send({type:'response.output_text.delta',item_id:item.id,output_index:i,content_index:0,delta:'PLUGIN_COMPLETE'});send({type:'response.output_text.done',item_id:item.id,output_index:i,content_index:0,text:'PLUGIN_COMPLETE'});send({type:'response.content_part.done',item_id:item.id,output_index:i,content_index:0,part:item.content[0]});
    }
    send({type:'response.output_item.done',output_index:i,item});
  }
  send({type:'response.completed',response});res.end();
});
await new Promise(r=>api.listen(0,'127.0.0.1',r));
const patch=path.join(tmp,'route.yml');await fs.writeFile(patch,(await fs.readFile(path.join(root,'luna.patch.yml'),'utf8')).replace('https://api.openai.com/v1',`http://127.0.0.1:${api.address().port}/v1`));
const env={...process.env,DSH_HOME:home,DSH_AGENTS_HOME:agentsHome,LUNA_BRIDGE_STATE_DIR:state,LUNA_OPENAI_API_KEY:'offline-fixture-only',ELECTRON_RUN_AS_NODE:'1'};
const runtime=await resolveRuntime();
const startHost=()=>spawn(runtime.executable,['--expose-internals',runtime.cli,'--profile','luna-subagent','--patch',patch],{cwd:tmp,windowsHide:true,env,stdio:['ignore','pipe','pipe']});
let errors='';const attachLog=c=>{c.stderr.on('data',b=>errors+=b);c.stdout.on('data',b=>errors+=b);return c};let child=attachLog(startHost());
const bridge=connectPluginTransport({stateDir:path.join(state,'transport')});
const client=new Client({name:'native-plugin-test',version:'1'});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let connected=false;
try{
  for(let i=0;i<200;i++){try{await bridge.call('capabilities',{});connected=true;break;}catch{await sleep(100)}}
  assert.ok(connected,errors);
  await client.connect(new StdioClientTransport({command:process.execPath,args:[path.join(root,'mcp.mjs')],env}));
  const call=async(name,args)=>{const r=await client.callTool({name,arguments:args});if(r.isError)throw new Error(r.content[0].text);return JSON.parse(r.content[0].text)};
  const wait=async id=>{for(let i=0;i<200;i++){const r=await call('agent_status',{agent_id:id});if(['completed','failed','cancelled'].includes(r.state))return r;await sleep(100)}throw new Error('Agent did not settle')};
  const input={request_id:randomUUID(),cwd:tmp,prompt:'Read fixture.txt and report progress before replying.'};
  const first=await call('spawn_agent',input);const duplicate=await call('spawn_agent',input);assert.equal(duplicate.agent_id,first.agent_id);
  const done=await wait(first.agent_id);assert.equal(done.state,'completed',JSON.stringify(done));assert.equal(done.result,'PLUGIN_COMPLETE');assert.ok(done.messages.some(m=>m.text==='NATIVE_PARENT_REPORT'));assert.equal(requests,2);
  await call('send_message',{request_id:randomUUID(),agent_id:first.agent_id,message:'Continue with a new task.'});const continued=await wait(first.agent_id);assert.equal(continued.state,'completed');assert.equal(requests,3);
  await call('send_message',{request_id:randomUUID(),agent_id:first.agent_id,message:'Context only, do not start.',mode:'inject'});await sleep(300);assert.equal(requests,3);
  hold=true;await call('send_message',{request_id:randomUUID(),agent_id:first.agent_id,message:'Start held task.'});while(requests<4)await sleep(100);const stopped=await call('interrupt_agent',{agent_id:first.agent_id});assert.equal(stopped.state,'cancelled');
  await call('close_agent',{agent_id:first.agent_id});assert.equal((await call('agent_status',{agent_id:first.agent_id})).state,'closed');
  assert.equal((await call('interrupt_agent',{agent_id:first.agent_id})).state,'closed');
  await assert.rejects(call('send_message',{request_id:randomUUID(),agent_id:first.agent_id,message:'Must stay closed.'}),/closed/);
  hold=false;
  const racedInput={request_id:randomUUID(),cwd:tmp,prompt:'Lifecycle race test.'};
  const spawning=call('spawn_agent',racedInput);
  let candidate;
  for(let i=0;i<100&&!candidate;i++){candidate=(await call('list_agents',{})).find(r=>r.agent_id!==first.agent_id);if(!candidate)await sleep(5);}
  assert.ok(candidate);
  const closing=call('close_agent',{agent_id:candidate.agent_id});
  await spawning;await closing;
  assert.equal((await call('agent_status',{agent_id:candidate.agent_id})).state,'closed');
  const burst=await call('spawn_agent',{request_id:randomUUID(),cwd:tmp,prompt:'First burst turn.'});
  await Promise.all(Array.from({length:8},(_,i)=>call('send_message',{request_id:randomUUID(),agent_id:burst.agent_id,message:`Burst followup ${i}.`})));
  const burstDone=await wait(burst.agent_id);assert.equal(burstDone.state,'completed');
  assert.equal(burstDone.messages.filter(m=>m.kind==='parent_message').length,8);
  await call('close_agent',{agent_id:burst.agent_id});
  const recovery=await call('spawn_agent',{request_id:randomUUID(),cwd:tmp,prompt:'Durable reply for restart.'});
  await wait(recovery.agent_id);
  await bridge.call('shutdown',{});
  for(let i=0;i<100&&child.exitCode===null;i++)await sleep(50);
  assert.notEqual(child.exitCode,null,'host must exit before restart');
  const recordPath=path.join(state,'agents',recovery.agent_id+'.json');
  const stale=JSON.parse(await fs.readFile(recordPath,'utf8'));
  stale.state='running';stale.messages=[];stale.usage=[];delete stale.result;delete stale.reason;delete stale.last_session_sequence;
  await fs.writeFile(recordPath,JSON.stringify(stale));
  const reportRecordPath=path.join(state,'agents',first.agent_id+'.json');
  const reportStale=JSON.parse(await fs.readFile(reportRecordPath,'utf8'));
  reportStale.messages=[];reportStale.usage=[];delete reportStale.last_session_sequence;delete reportStale.pending_report_calls;
  await fs.writeFile(reportRecordPath,JSON.stringify(reportStale));
  const beforeRestart=requests;child=attachLog(startHost());
  let recovered;
  for(let i=0;i<200;i++){try{recovered=await bridge.call('agent_status',{agent_id:recovery.agent_id});break}catch{await sleep(100)}}
  assert.equal(recovered.state,'completed',JSON.stringify(recovered));assert.equal(recovered.result,'PLUGIN_COMPLETE');assert.equal(requests,beforeRestart,'restart must not submit model work');
  const reportRecovered=await bridge.call('agent_status',{agent_id:first.agent_id});assert.equal(reportRecovered.state,'closed');assert.equal(reportRecovered.messages.filter(m=>m.text==='NATIVE_PARENT_REPORT').length,1,'recover successful report exactly once');
  writePhase=true;writeIssued=false;writeTarget='allowed-write.txt';
  const writer=await call('spawn_agent',{request_id:randomUUID(),cwd:tmp,prompt:'Write the assigned test file.',permission_mode:'workspace-write'});await wait(writer.agent_id);
  assert.equal(await fs.readFile(path.join(tmp,writeTarget),'utf8'),'NATIVE_WRITE_CONTENT');
  writeIssued=false;writeTarget='denied-write.txt';
  const reader=await call('spawn_agent',{request_id:randomUUID(),cwd:tmp,prompt:'Remain read-only.',permission_mode:'read-only'});await wait(reader.agent_id);
  await assert.rejects(fs.access(path.join(tmp,writeTarget)),e=>e.code==='ENOENT');
  await call('close_agent',{agent_id:writer.agent_id});await call('close_agent',{agent_id:reader.agent_id});
  providerFailure=true;
  const failing=await call('spawn_agent',{request_id:randomUUID(),cwd:tmp,prompt:'Provider failure fixture.'});
  const failure=await wait(failing.agent_id);assert.equal(failure.state,'failed');assert.ok(JSON.stringify(failure).includes('NATIVE_PROVIDER_401'));
  await call('close_agent',{agent_id:failing.agent_id});
  console.log(JSON.stringify({passed:['native DSH plugin','global and project instructions plus personal skill discovery','MCP spawn and exact duplicate','actual scoped file read','agent to parent report','continuation','inject without wake','native cancellation','native close','closed cannot resurrect','spawn-close serialization','burst continuation settlement','durable DSH log reconciliation without model resubmit','actual workspace write and read-only denial','original provider error retained','successful tool reports recovered with stable event identity'],requests,fixture:tmp,done,continued,stopped}));
}finally{
  await client.close().catch(()=>{});if(connected)await bridge.call('shutdown',{}).catch(()=>{});await sleep(500);if(child.exitCode===null)child.kill();api.closeAllConnections();api.close();
  await fs.writeFile(path.join(tmp,'host.log'),errors);
}
