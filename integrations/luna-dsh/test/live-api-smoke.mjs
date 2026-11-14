import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {ensureHost} from '../host-launcher.mjs';
if(process.env.LUNA_ALLOW_LIVE_TEST!=='1')throw new Error('Live API smoke test requires explicit LUNA_ALLOW_LIVE_TEST=1');
if(!process.env.LUNA_OPENAI_API_KEY)throw new Error('LUNA_OPENAI_API_KEY missing');
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dir=path.join(root,'.tests-tmp','live-api-'+Date.now());await fs.mkdir(dir,{recursive:true});
const marker='LUNA_TOOL_PROOF_'+randomUUID();await fs.writeFile(path.join(dir,'proof.txt'),marker);
const {client}=await ensureHost();
const created=await client.call('spawn_agent',{request_id:randomUUID(),role:'worker',cwd:dir,permission_mode:'read-only',reasoning_effort:'medium',context:'This is a small, authorized API integration verification. Do not modify files or launch other models.',prompt:'Read proof.txt with the supplied filesystem tool. Send its exact contents to the parent using report_to_parent. Then reply with the same exact contents and finish.'});
let result;
try {
 const deadline=Date.now()+180000;
 while(Date.now()<deadline){result=await client.call('agent_status',{agent_id:created.agent_id});if(!['running','starting','cancelling'].includes(result.state))break;await new Promise(r=>setTimeout(r,500));}
 if(['running','starting','cancelling'].includes(result?.state))result=await client.call('interrupt_agent',{agent_id:created.agent_id});
 const passed=result?.state==='completed'&&result.result?.includes(marker)&&result.messages.some(m=>m.kind==='progress'&&m.text?.includes(marker));
 const evidence={passed,agent_id:created.agent_id,state:result?.state,result:result?.result,usage:result?.usage,error:result?.error,messages:result?.messages,checked_at:new Date().toISOString()};
 await fs.writeFile(path.join(root,'evidence','live-api-smoke.json'),JSON.stringify(evidence,null,2));
 console.log(JSON.stringify(evidence));if(!passed)process.exitCode=1;
}finally{await client.call('close_agent',{agent_id:created.agent_id});}
