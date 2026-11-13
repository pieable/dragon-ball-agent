import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {BridgeState} from '../plugin-state.mjs';
const base=path.resolve('.tests-tmp');await fs.mkdir(base,{recursive:true});
test('concurrent duplicate submissions execute once and replay receipt',async()=>{
 const dir=await fs.mkdtemp(path.join(base,'state-'));const s=new BridgeState(dir);await s.load();let calls=0;const id=randomUUID();
 const work=async()=>{calls++;await new Promise(r=>setTimeout(r,25));return {agent_id:'a'}};
 const results=await Promise.all(Array.from({length:12},()=>s.once(id,{prompt:'same'},work)));
 assert.equal(calls,1);assert.ok(results.every(r=>r.agent_id==='a'));
 await assert.rejects(s.once(id,{prompt:'different'},work),/different content/);
 const restored=new BridgeState(dir);await restored.load();assert.equal((await restored.once(id,{prompt:'same'},work)).agent_id,'a');assert.equal(calls,1);
});
test('restart marks running interrupted without resubmission',async()=>{
 const dir=await fs.mkdtemp(path.join(base,'state-'));const s=new BridgeState(dir);await s.load();await s.save({agent_id:'a',state:'running',messages:[]});
 const restored=new BridgeState(dir);await restored.load();assert.equal(restored.agents.get('a').state,'interrupted');
});
test('serialized saves retain latest snapshot under contention',async()=>{
 const dir=await fs.mkdtemp(path.join(base,'state-'));const s=new BridgeState(dir);await s.load();const record={agent_id:'a',state:'running',n:0};
 const pending=[];for(let i=0;i<30;i++){record.n=i;pending.push(s.save(record));}await Promise.all(pending);
 const disk=JSON.parse(await fs.readFile(path.join(dir,'agents','a.json'),'utf8'));assert.equal(disk.n,29);
});
