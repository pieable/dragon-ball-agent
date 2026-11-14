import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import {execFileSync} from 'node:child_process';
import {scanSource,snapshotFiles,validateRelativePath} from '../worktree-snapshot.mjs';
const git=(cwd,...args)=>execFileSync('git',['-c','user.name=Fixture','-c','user.email=fixture@localhost','-c','core.autocrlf=false',...args],{cwd,encoding:'utf8',windowsHide:true,stdio:['pipe','pipe','pipe']}).trim();
async function fixture(t){const base=path.resolve('.tests-tmp');await fs.mkdir(base,{recursive:true});const root=await fs.mkdtemp(path.join(base,'snapshot-')),source=path.join(root,'source');await fs.mkdir(source);git(source,'init');t.after(async()=>{if(path.dirname(root)!==base)throw Error('Wrong cleanup root');await fs.rm(root,{recursive:true,force:true});});return{root,source,put:async(name,bytes)=>{await fs.mkdir(path.dirname(path.join(source,name)),{recursive:true});await fs.writeFile(path.join(source,name),bytes);}};}

test('current tracked bytes, staged deletion/rename, untracked selection and ignored choices',async t=>{
 const f=await fixture(t);await f.put('keep.txt','committed\n');await f.put('remove.txt','remove');await f.put('old.txt','rename');await f.put('.gitignore','ignored.bin\n.env\n');git(f.source,'add','.');git(f.source,'commit','-m','base');
 await f.put('keep.txt','dirty\n');git(f.source,'rm','remove.txt');git(f.source,'mv','old.txt','new.txt');await f.put('context.txt','untracked');await f.put('ignored.bin',Buffer.from([0,255,1]));await f.put('.env','SYNTHETIC_SECRET_DO_NOT_COPY');
 const plan=await scanSource(f.source,{includeIgnored:['ignored.bin','.env']});assert.deepEqual(plan.issues,[]);const by=Object.fromEntries(plan.files.map(x=>[x.path,x]));assert.equal(by['remove.txt'].exists,false);assert.equal(by['old.txt'].exists,false);assert.equal(by['new.txt'].exists,true);assert.ok(by['context.txt']);assert.ok(by['ignored.bin']);assert.equal(plan.excluded.find(x=>x.path==='.env').reason,'environment credentials candidate');assert.ok(!JSON.stringify(plan).includes('SYNTHETIC_SECRET'));
 const dest=path.join(f.root,'snapshot');await snapshotFiles(f.source,plan,dest);assert.equal(await fs.readFile(path.join(dest,'keep.txt'),'utf8'),'dirty\n');assert.deepEqual(await fs.readFile(path.join(dest,'ignored.bin')),Buffer.from([0,255,1]));await assert.rejects(fs.access(path.join(dest,'.env')));await assert.rejects(fs.access(path.join(dest,'.git')));await assert.rejects(fs.access(path.join(dest,'remove.txt')));
 const a=await fs.stat(path.join(f.source,'keep.txt')),b=await fs.stat(path.join(dest,'keep.txt'));assert.notEqual(a.ino,b.ino);await fs.writeFile(path.join(dest,'keep.txt'),'changed snapshot');assert.equal(await fs.readFile(path.join(f.source,'keep.txt'),'utf8'),'dirty\n');
});

test('source byte change or new untracked file rejects before destination creation',async t=>{
 const f=await fixture(t);await f.put('a','one');git(f.source,'add','.');git(f.source,'commit','-m','base');let p=await scanSource(f.source);await f.put('a','two');const dest=path.join(f.root,'snapshot');await assert.rejects(snapshotFiles(f.source,p,dest),{code:'SOURCE_CHANGED'});await assert.rejects(fs.access(dest));p=await scanSource(f.source);await f.put('new','new');await assert.rejects(snapshotFiles(f.source,p,dest),{code:'SOURCE_CHANGED'});await assert.rejects(fs.access(dest));
});

for(const changed of ['a','b'])test(`change to ${changed==='a'?'already copied':'not yet copied'} file leaves a failed partial snapshot`,async t=>{
 const f=await fixture(t);await f.put('a','first');await f.put('b','second');git(f.source,'add','.');git(f.source,'commit','-m','base');const plan=await scanSource(f.source),dest=path.join(f.root,'snapshot'),originalWrite=fs.writeFile;let injected=false;
 const mocked=t.mock.method(fs,'writeFile',async(...args)=>{const value=await originalWrite(...args);if(path.resolve(args[0])===path.join(dest,'a')&&!injected){injected=true;await originalWrite(path.join(f.source,changed),'concurrent change');}return value;});
 try{await assert.rejects(snapshotFiles(f.source,plan,dest),error=>error.code==='SOURCE_CHANGED'&&error.destinationPartial===true&&error.snapshotDir===dest);}finally{mocked.mock.restore();}
 assert.equal(injected,true);assert.equal(await fs.readFile(path.join(dest,'a'),'utf8'),'first');assert.equal(await fs.readFile(path.join(f.source,changed),'utf8'),'concurrent change');
 if(changed==='b')await assert.rejects(fs.access(path.join(dest,'b')));
});

test('sensitive tracked files excluded while example remains; untracked can be omitted',async t=>{
 const f=await fixture(t);for(const name of ['.env','.env.local','auth.pem','.npmrc','.env.example'])await f.put(name,'synthetic');git(f.source,'add','.');git(f.source,'commit','-m','base');await f.put('context','untracked');const p=await scanSource(f.source,{includeUntracked:false});assert.deepEqual(p.files.map(f=>f.path),['.env.example']);assert.equal(p.excluded.length,4);assert.deepEqual(p.issues,[]);
});

test('portable Windows paths reject traversal, ADS, aliases and metadata',()=>{
 for(const name of ['../a','a/../b','C:/a','/tmp/a','a\\b','a:b','a.','a ','NUL.txt','a/.git/config','a//b','CON','a\n'])assert.throws(()=>validateRelativePath(name),{code:'UNSAFE_PATH'});
 assert.equal(validateRelativePath('资料/a file.txt'),'资料/a file.txt');
});

test('submodule, symlink index and sparse omissions are explicit issues',async t=>{
 const f=await fixture(t);await f.put('a','base');git(f.source,'add','.');git(f.source,'commit','-m','base');const head=git(f.source,'rev-parse','HEAD'),blob=git(f.source,'rev-parse','HEAD:a');git(f.source,'update-index','--add','--cacheinfo',`160000,${head},sub`);git(f.source,'update-index','--add','--cacheinfo',`120000,${blob},link`);git(f.source,'update-index','--skip-worktree','a');await fs.unlink(path.join(f.source,'a'));const p=await scanSource(f.source);assert.ok(p.issues.some(i=>i.code==='SUBMODULE'));assert.ok(p.issues.some(i=>i.code==='UNSAFE_OBJECT'));assert.ok(p.issues.some(i=>i.code==='SPARSE_MISSING'));await assert.rejects(snapshotFiles(f.source,p,path.join(f.root,'snapshot')),{code:'INVALID_PLAN'});
});

test('junction/symlink ancestors rejected before reading explicit files',async t=>{
 const f=await fixture(t);await f.put('a','base');git(f.source,'add','.');git(f.source,'commit','-m','base');const outside=path.join(f.root,'outside');await fs.mkdir(outside);await fs.writeFile(path.join(outside,'secret.txt'),'SYNTHETIC_OUTSIDE');const link=path.join(f.source,'linked');await fs.symlink(outside,link,process.platform==='win32'?'junction':'dir');
 const p=await scanSource(f.source,{includeUntracked:false,includeIgnored:['linked/secret.txt']});assert.ok(p.issues.some(i=>i.path==='linked/secret.txt'&&i.code==='UNSAFE_OBJECT'));assert.ok(!p.files.some(i=>i.path==='linked/secret.txt'));await fs.unlink(link);
});

test('snapshot requires new external destination and rejects plan tampering',async t=>{
 const f=await fixture(t);await f.put('a','base');git(f.source,'add','.');git(f.source,'commit','-m','base');const p=await scanSource(f.source),dest=path.join(f.root,'existing');await fs.mkdir(dest);await assert.rejects(snapshotFiles(f.source,p,dest),{code:'DESTINATION_EXISTS'});await assert.rejects(snapshotFiles(f.source,p,path.join(f.source,'snapshot')),{code:'UNSAFE_DESTINATION'});const bad=structuredClone(p);bad.files.push({path:'../escape',exists:true,sha256:'x',size:1});await assert.rejects(snapshotFiles(f.source,bad,path.join(f.root,'new')),{code:'SOURCE_CHANGED'});
});
