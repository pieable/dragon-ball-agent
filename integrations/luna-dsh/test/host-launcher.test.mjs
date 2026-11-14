import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ensureHost, resolveRuntime, resolveAgentsHome } from '../host-launcher.mjs';
import { processIsAlive } from '../plugin-transport.mjs';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function setup(t, fail = false) {
  const base = path.join(root, '.tests-tmp'); await fs.mkdir(base, { recursive: true });
  const dir = await fs.mkdtemp(path.join(base, 'launcher-'));
  const stateDir = path.join(dir, 'state'), homeDir = path.join(dir, 'home'), cli = path.join(dir, 'fake-cli.mjs');
  const agentsHome = path.join(dir, 'agents-source');
  await fs.mkdir(path.join(agentsHome, 'skills'), {recursive:true});
  await fs.writeFile(path.join(agentsHome, 'AGENTS.md'), 'Isolated launcher fixture instructions.');
  const transport = pathToFileURL(path.join(root, 'plugin-transport.mjs')).href;
  await fs.writeFile(cli, fail ? `const k=process.env.LUNA_OPENAI_API_KEY;process.stderr.write('fixture failure: '+k.slice(0,5));setTimeout(()=>{process.stderr.write(k.slice(5));process.exit(7)},20);` : `
import fs from 'node:fs/promises';import path from 'node:path';import {startPluginTransport} from ${JSON.stringify(transport)};
const state=process.env.LUNA_BRIDGE_STATE_DIR;
await fs.appendFile(path.join(state,'starts.txt'),process.pid+'\\n');
let host;
host=await startPluginTransport({stateDir:path.join(state,'transport'),dispatch:async operation=>{
 if(operation==='capabilities')return {fixture:true,pid:process.pid,home:process.env.DSH_HOME,agentsHome:process.env.DSH_AGENTS_HOME};
 if(operation==='shutdown'){setTimeout(()=>host.close().then(()=>process.exit(0)),20);return 'stopping';}
 throw new Error('unexpected operation');
}});`);
  t.after(async () => {
    let status;try{status=JSON.parse(await fs.readFile(path.join(stateDir,'launcher-status.json'),'utf8'));}catch{}
    if(status?.supervisor_pid){for(let i=0;i<100 && processIsAlive(status.supervisor_pid)===true;i++)await sleep(20);}
    await fs.rm(dir,{recursive:true,force:true});
  });
  return {dir,options:{stateDir,homeDir,agentsHome,runtime:{executable:process.execPath,cli},env:{LUNA_OPENAI_API_KEY:'TEST_ONLY_SPLIT_SECRET_VALUE'}},stateDir};
}

test('concurrent MCP launches share one persistent host and private profile',async t=>{
  const {options,stateDir}=await setup(t);
  const [a,b]=await Promise.all([ensureHost(options),ensureHost(options)]);
  try{
    assert.equal(a.capabilities.pid,b.capabilities.pid);
    assert.equal(a.capabilities.home,options.homeDir);
    assert.equal(a.capabilities.agentsHome, await fs.realpath(options.agentsHome));
    assert.equal((await fs.readFile(path.join(stateDir,'starts.txt'),'utf8')).trim().split('\n').length,1);
    const c=await ensureHost(options);assert.equal(c.reused,true);assert.equal(c.capabilities.pid,a.capabilities.pid);
    const profile=JSON.parse(await fs.readFile(path.join(options.homeDir,'profiles','luna-subagent','package.json'),'utf8'));
    assert.deepEqual(profile.dsh.profile.bundles,['@deepseek-ai/dsh-base','luna-dsh-subagent-mcp']);
    assert.equal((await fs.readFile(path.join(stateDir,'launcher-status.json'),'utf8')).includes(options.env.LUNA_OPENAI_API_KEY),false);
  }finally{await a.client.call('shutdown');}
});

test('startup failure preserves diagnostics and redacts split credential chunks',async t=>{
  const {options,stateDir}=await setup(t,true);
  await assert.rejects(ensureHost(options),e=>e.code==='HOST_START_FAILED'&&e.message.includes('fixture failure')&&!e.message.includes(options.env.LUNA_OPENAI_API_KEY));
  const status=JSON.parse(await fs.readFile(path.join(stateDir,'launcher-status.json'),'utf8'));
  assert.equal(status.exit_code,7);
  const log=await fs.readFile(status.log_file,'utf8');assert.match(log,/REDACTED_API_KEY/);assert.equal(log.includes(options.env.LUNA_OPENAI_API_KEY),false);
});

test('runtime may be explicitly configured away from the installed D drive location',async t=>{
  const {options}=await setup(t);
  assert.deepEqual(await resolveRuntime(options),options.runtime);
  await assert.rejects(resolveRuntime({runtime:{executable:path.join(root,'missing-runtime.exe')}}),e=>e.code==='RUNTIME_NOT_FOUND');
});

test('missing key refuses launch without putting credentials in profile files',async t=>{
  const {options,stateDir}=await setup(t);
  await assert.rejects(ensureHost({...options,env:{LUNA_OPENAI_API_KEY:''}}),e=>e.code==='MISSING_CREDENTIAL');
  await assert.rejects(fs.access(path.join(stateDir,'starts.txt')));
});

test('two separate MCP-like processes exit while the single shared host remains usable',async t=>{
  const {options,stateDir}=await setup(t);
  const module=pathToFileURL(path.join(root,'host-launcher.mjs')).href;
  const {env,...publicOptions}=options;
  const source=`import {ensureHost} from ${JSON.stringify(module)};const h=await ensureHost(${JSON.stringify(publicOptions)});process.stdout.write(JSON.stringify(h.capabilities),()=>process.exit(0));`;
  const run=()=>new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,['--input-type=module','-e',source],{cwd:root,env:{...process.env,...env},windowsHide:true,stdio:['ignore','pipe','pipe']});
    let out='',err='';child.stdout.on('data',x=>out+=x);child.stderr.on('data',x=>err+=x);child.on('error',reject);child.on('close',code=>code===0?resolve(JSON.parse(out)):reject(new Error(err)));
  });
  const [a,b]=await Promise.all([run(),run()]);
  assert.equal(a.pid,b.pid);assert.equal(processIsAlive(a.pid),true);
  const reused=await ensureHost(options);
  try{assert.equal(reused.capabilities.pid,a.pid);assert.equal((await fs.readFile(path.join(stateDir,'starts.txt'),'utf8')).trim().split('\n').length,1);}
  finally{await reused.client.call('shutdown');}
});

test('installed official DSH private profile publishes plugin capabilities without a model call',async t=>{
  const {options}=await setup(t);
  const runtime=await resolveRuntime();
  const host=await ensureHost({...options,runtime});
  try{
    assert.equal(host.capabilities.provider,'openai');
    assert.equal(host.capabilities.transport,'DSH plugin');
    assert.deepEqual(await host.client.call('list_agents'),[]);
  }finally{await host.client.call('shutdown');}
});

test('instruction source selection respects explicit path and rejects missing source', async t=>{
  const {options}=await setup(t);
  assert.equal(await resolveAgentsHome({env:{LUNA_CODEX_HOME:options.agentsHome,CODEX_HOME:'missing'}}),await fs.realpath(options.agentsHome));
  assert.equal(await resolveAgentsHome({env:{CODEX_HOME:options.agentsHome}}),await fs.realpath(options.agentsHome));
  await assert.rejects(resolveAgentsHome({agentsHome:path.join(root,'.tests-tmp','missing-agents-home')}),e=>e.code==='AGENTS_HOME_UNAVAILABLE');
});

test('official comments around empty profile roots remain compatible',async t=>{
  const {options}=await setup(t);
  const profile=path.join(options.homeDir,'profiles','luna-subagent');
  await fs.mkdir(profile,{recursive:true});
  await fs.writeFile(path.join(profile,'cordis.yml'),'# dsh profile root\n# bundle composition is in package.json\n[]\n');
  const host=await ensureHost(options);
  try{assert.equal(host.capabilities.fixture,true);}finally{await host.client.call('shutdown');}
});
