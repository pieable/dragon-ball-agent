import fs from 'node:fs/promises';import net from 'node:net';import path from 'node:path';import{fileURLToPath}from'node:url';import{randomUUID,createHash}from'node:crypto';import{execFileSync}from'node:child_process';
import {scanSource,snapshotFiles} from './worktree-snapshot.mjs';
const here=path.dirname(fileURLToPath(import.meta.url));
const digest=b=>createHash('sha256').update(b).digest('hex');
const inside=(root,p)=>{const r=path.relative(root,p);return r===''||(!r.startsWith('..'+path.sep)&&r!=='..'&&!path.isAbsolute(r));};
const json=async p=>JSON.parse(await fs.readFile(p,'utf8'));
async function atomic(p,b){const tmp=p+'.tmp-'+randomUUID();try{await fs.writeFile(tmp,b,{flag:'wx'});await fs.rename(tmp,p);}finally{await fs.unlink(tmp).catch(e=>{if(e.code!=='ENOENT')throw e;});}}
async function persist(p,v){await atomic(p,JSON.stringify(v,null,2));}
function git(cwd,...args){return execFileSync('git',['-c','core.hooksPath='+path.join(here,'.disabled-hooks'),...args],{cwd,encoding:'utf8',windowsHide:true,env:{...process.env,GIT_OPTIONAL_LOCKS:'0'}}).trim();}
async function inspect(root,relative){
 if(typeof relative!=='string'||path.isAbsolute(relative)||relative.split(/[\\/]/).some(p=>!p||p==='.'||p==='..'||p.toLowerCase()==='.git'||/[<>:"|?*]/.test(p)||/[. ]$/.test(p)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)))throw Error('Unsafe relative file path: '+relative);
 let p=root;const parts=relative.split(/[\\/]/);
 for(let i=0;i<parts.length;i++){p=path.join(p,parts[i]);let st;try{st=await fs.lstat(p);}catch(e){if(e.code==='ENOENT')return {exists:false,sha256:null};throw e;}
  if(st.isSymbolicLink())throw Error('Link/reparse path is not supported: '+relative);
  if(i<parts.length-1&&!st.isDirectory())throw Error('Parent path is not a directory: '+relative);
  if(i===parts.length-1){if(!st.isFile())throw Error('Expected ordinary file: '+relative);if(st.nlink>1)throw Error('Source file has hard-link aliases; explicit handling required: '+relative);return {exists:true,sha256:digest(await fs.readFile(p))};}
 }
}
const same=(a,b)=>a.exists===b.exists&&a.sha256===b.sha256;
async function inventory(root,relative=''){const found=[];for(const e of await fs.readdir(path.join(root,relative),{withFileTypes:true})){if(!relative&&e.name==='.git')continue;const p=relative?relative+'/'+e.name:e.name;if(e.isSymbolicLink())throw Error('Worktree contains a reparse/link requiring separate cleanup: '+p);if(e.isDirectory())found.push(...await inventory(root,p));else found.push(p);}return found;}
function moveWithoutReplace(from,to){if(process.platform!=='win32')throw Error('Preserving deleted-object metadata is implemented for Windows only');execFileSync('python',['-c','import os,sys;os.rename(sys.argv[1],sys.argv[2])',from,to],{windowsHide:true});}
export class WorktreeWorkflow{
 constructor({allowedRoot=process.env.LUNA_WORKTREE_ALLOWED_ROOT??path.dirname(here),stateRoot=process.env.LUNA_WORKTREE_STATE_DIR??path.join(path.dirname(here),'.luna-worktree-jobs')}={}){this.allowedRoot=path.resolve(allowedRoot);this.stateRoot=path.resolve(stateRoot);this.locks=new Map();}
 async exclusive(id,fn){const previous=this.locks.get(id)??Promise.resolve();const current=previous.catch(()=>{}).then(async()=>{
  const key=digest((this.stateRoot+'|'+id).toLowerCase()),gate=net.createServer(socket=>socket.destroy());
  const address=process.platform==='win32'?{path:`\\\\.\\pipe\\luna-workflow-${key}`}:{path:`\0luna-workflow-${key}`};
  try{await new Promise((resolve,reject)=>{gate.once('error',reject);gate.listen(address,resolve);});}catch(e){if(e.code==='EADDRINUSE')throw Error('Workflow is busy in another client; retry after it settles');throw e;}
  try{return await fn();}finally{await new Promise((resolve,reject)=>gate.close(e=>e?reject(e):resolve()));}
 });this.locks.set(id,current);try{return await current;}finally{if(this.locks.get(id)===current)this.locks.delete(id);}}

 dir(id){if(!/^[0-9a-f-]{36}$/.test(id))throw Error('Invalid worktree id');return path.join(this.stateRoot,id);}
 async read(id){const j=await json(path.join(this.dir(id),'job.json'));if(j.id!==id||j.work!==path.join(this.dir(id),'work'))throw Error('Invalid job identity');await this.validateSource(j);return j;}
 async save(j){await persist(path.join(this.dir(j.id),'job.json'),j);}
 async validateSource(j){const allowed=await fs.realpath(this.allowedRoot),source=await fs.realpath(j.source);if(source!==j.source||!inside(allowed,source)||inside(this.stateRoot,source))throw Error('Source is outside the approved Codex workspace or changed identity');const common=await fs.realpath(git(source,'rev-parse','--path-format=absolute','--git-common-dir'));if(common!==j.commonGit||!inside(allowed,common))throw Error('Shared Git directory is outside the approved workspace or changed identity');}
 async prepare({request_id=randomUUID(),source,includeUntracked=true,includeIgnored=[]}){
  const canonical=await fs.realpath(source),commonGit=await fs.realpath(git(canonical,'rev-parse','--path-format=absolute','--git-common-dir'));
  const id=request_id,dir=this.dir(id),work=path.join(dir,'work');return this.exclusive(id,async()=>{
  const j={id,source:canonical,commonGit,work,status:'preparing',created_at:new Date().toISOString(),selection:{includeUntracked,includeIgnored}};await this.validateSource(j);
  try{const old=await this.read(id);if(old.source!==canonical||JSON.stringify(old.selection)!==JSON.stringify(j.selection))throw Error('request_id belongs to different preparation inputs');return this.summary(old);}catch(e){if(e.code!=='ENOENT')throw e;}
  await fs.mkdir(dir,{recursive:true});await this.save(j);
  try{
   const instructionPaths=[];let ancestor=canonical;
   while(inside(await fs.realpath(this.allowedRoot),ancestor)){for(const name of ['AGENTS.md','AGENTS.override.md']){const p=path.join(ancestor,name);if(await fs.access(p).then(()=>true,()=>false))instructionPaths.push(p);}if(ancestor===path.dirname(ancestor))break;ancestor=path.dirname(ancestor);}
   j.instruction_paths=instructionPaths;const rootInstructions=instructionPaths.filter(p=>path.dirname(p)===canonical).map(p=>path.basename(p));
   const plan=await scanSource(canonical,{includeUntracked,includeIgnored:[...new Set([...includeIgnored,...rootInstructions])]});if(plan.issues.length)throw Error('Source requires attention: '+JSON.stringify(plan.issues));
   j.baseline=plan;j.head=plan.head;await this.save(j);await snapshotFiles(canonical,plan,path.join(dir,'baseline'));
   // No checkout: avoid executing repository smudge filters or materializing excluded files.
   git(canonical,'worktree','add','--detach','--no-checkout',work,j.head);j.registered=true;await this.save(j);git(work,'read-tree',j.head);
   for(const f of plan.files.filter(f=>f.exists)){const p=path.join(work,f.path);await fs.mkdir(path.dirname(p),{recursive:true});await fs.writeFile(p,await fs.readFile(path.join(dir,'baseline',f.path)),{flag:'wx'});}
   j.status='prepared';await this.save(j);return this.summary(j);
  }catch(e){j.status='preparation_failed';j.error=e.message;await this.save(j);throw Error(`Worktree ${id} preparation failed: ${e.message}. Inspect or clean this recorded job; no source file was replaced.`);}
 });}
 summary(j){return {id:j.id,source:j.source,work:j.work,worktree_present:!!j.registered,status:j.status,head:j.head,baseline_path:j.baseline?path.join(this.dir(j.id),'baseline'):null,candidate_path:j.candidate?path.join(this.dir(j.id),j.candidate):null,excluded:j.baseline?.excluded??[],changes:j.changes??[],conflicts:j.conflicts??[],error:j.error??null,instruction_paths:j.instruction_paths??[],handoff:'Read applicable original project/ancestor instructions and pass their requirements plus source→work path mapping in spawn context. Root AGENTS files are copied; original ancestor paths do not follow the move. Review candidate_path after collection; use collect/apply for the task delta, not a whole-branch cherry-pick of excluded-file deletions.',sandbox:'No ACL or Low-integrity changes are made by this workflow. Confirm the exact worktree permission scope before a new native write-sandbox grant.',next:j.status==='prepared'?'Run the authorized task in work; parent retains Git ownership. Collect freezes a candidate outside the agent write root.':null};}
 async status(id){return this.summary(await this.read(id));}
 async collect(id,{includeIgnored=[]}={}){return this.exclusive(id,async()=>{
  const j=await this.read(id);if(!j.registered||!['prepared','collected'].includes(j.status))throw Error('Collect requires a present prepared worktree');
  const selectedIgnored=[...new Set([...j.baseline.files.map(f=>f.path),...(j.baseline.selection?.includeIgnored??[]),...includeIgnored])];const plan=await scanSource(j.work,{includeUntracked:true,includeIgnored:selectedIgnored});if(plan.issues.length)throw Error('Candidate requires attention: '+JSON.stringify(plan.issues));
  const dir=this.dir(id),version=randomUUID(),candidate=path.join(dir,'candidates',version);await fs.mkdir(path.dirname(candidate),{recursive:true});await snapshotFiles(j.work,plan,candidate);
  const before=new Map(j.baseline.files.map(f=>[f.path,f])),after=new Map(plan.files.map(f=>[f.path,f])),excluded=new Set(j.baseline.excluded.map(f=>f.path));const changes=[];
  for(const p of new Set([...before.keys(),...after.keys()])){if(excluded.has(p))continue;const a=before.get(p)??{exists:false,sha256:null},b=after.get(p)??{exists:false,sha256:null};if(!same(a,b))changes.push({path:p,before:{exists:a.exists,sha256:a.sha256},after:{exists:b.exists,sha256:b.sha256}});}
  const saved=new Set(plan.files.filter(f=>f.exists).map(f=>f.path));j.unselected=(await inventory(j.work)).filter(p=>!saved.has(p));
  j.candidate=path.relative(dir,candidate);j.collected_plan=plan;j.changes=changes;j.candidate_excluded=plan.excluded;j.status='collected';j.conflicts=[];await this.save(j);return {...this.summary(j),candidate_excluded:plan.excluded,unselected_count:j.unselected.length,unselected_roots:[...new Set(j.unselected.map(p=>p.split('/')[0]))]};
 });}
 async preflight(j,side){const conflicts=[];if(git(j.source,'rev-parse','HEAD')!==j.head)conflicts.push({path:'.git/HEAD',reason:'Source HEAD changed since preparation'});for(const c of j.changes){try{const now=await inspect(j.source,c.path);if(!same(now,c[side]))conflicts.push({path:c.path,reason:'Source bytes or existence differ',expected:c[side],actual:now});}catch(e){conflicts.push({path:c.path,reason:e.message});}}return conflicts;}
 async writeVersion(j,c,side){
  const desired=c[side],target=path.join(j.source,c.path),source=path.join(this.dir(j.id),side==='before'?'baseline':j.candidate,c.path);
  if(!desired.exists){
   if(side==='after'&&c.before.exists){const removed=path.join(this.dir(j.id),'removed',c.path);await fs.mkdir(path.dirname(removed),{recursive:true});moveWithoutReplace(target,removed);}
   else await fs.unlink(target);
   return;
  }
  if(side==='before'&&!c.after.exists){const removed=path.join(this.dir(j.id),'removed',c.path);if(!same(await inspect(path.join(this.dir(j.id),'removed'),c.path),c.before))throw Error('Original deleted object is unavailable or changed: '+c.path);moveWithoutReplace(removed,target);return;}
  const bytes=await fs.readFile(source);if(digest(bytes)!==desired.sha256)throw Error('Private snapshot integrity mismatch: '+c.path);
  const dirs=[];let parent=path.dirname(target);while(parent!==j.source){try{const st=await fs.lstat(parent);if(st.isSymbolicLink()||!st.isDirectory())throw Error('Invalid destination parent: '+parent);break;}catch(e){if(e.code!=='ENOENT')throw e;dirs.unshift(parent);parent=path.dirname(parent);}}
  for(const d of dirs){await fs.mkdir(d);j.created_dirs??=[];j.created_dirs.push(path.relative(j.source,d));await this.save(j);}
  // Editing the existing object preserves its ACL. Replacing it by rename would
  // silently replace per-file security descriptors with the parent's defaults.
  const previous=c[side==='before'?'after':'before'];const handle=await fs.open(target,previous.exists?'r+':'wx');
  try{const st=await handle.stat();if(!st.isFile()||st.nlink>1)throw Error('Destination identity changed: '+c.path);
   if(previous.exists&&digest(await handle.readFile())!==previous.sha256)throw Error('Destination changed before handle write: '+c.path);
   let offset=0;while(offset<bytes.length){const {bytesWritten}=await handle.write(bytes,offset,bytes.length-offset,offset);if(!bytesWritten)throw Error('Short file write');offset+=bytesWritten;}await handle.truncate(bytes.length);await handle.sync();
  }finally{await handle.close();}
 }
 async apply(id){return this.exclusive(id,async()=>{
  const j=await this.read(id);return this.exclusive('source:'+j.source,async()=>{if(j.status==='applied')return this.summary(j);if(j.status!=='collected')throw Error('Apply requires a collected candidate; interrupted operations require recover first');
  j.conflicts=await this.preflight(j,'before');if(j.conflicts.length){await this.save(j);throw Error('Source conflicts: '+JSON.stringify(j.conflicts));}
  j.status='applying';j.journal=[];await this.save(j);
  try{for(const c of j.changes){if(!same(await inspect(j.source,c.path),c.before))throw Error('Source changed immediately before write: '+c.path);const entry={path:c.path,state:'intent'};j.journal.push(entry);await this.save(j);await this.writeVersion(j,c,'after');entry.state='applied';await this.save(j);}j.status='applied';await this.save(j);return this.summary(j);}
  catch(e){j.status='recovery_required';j.error=e.message;await this.save(j);throw Error('Transfer stopped; inspect/recover worktree '+id+': '+e.message);}
 });});}
 async recover(id){return this.exclusive(id,async()=>{
  const j=await this.read(id);if(!['applying','rolling_back','recovery_required'].includes(j.status))return this.summary(j);const conflicts=[];
  for(const entry of j.journal??[]){const c=j.changes.find(c=>c.path===entry.path),now=await inspect(j.source,c.path);if(same(now,c.after))entry.state='applied';else if(same(now,c.before))entry.state='restored';else conflicts.push({path:c.path,reason:'Changed bytes do not match either saved version'});}
  j.conflicts=conflicts;j.status='recovery_required';await this.save(j);return {...this.summary(j),journal:j.journal,next:'Rollback can restore only entries matching this transfer output; conflicting user changes remain untouched.'};
 });}
 async rollback(id){return this.exclusive(id,async()=>{
  const j=await this.read(id);return this.exclusive('source:'+j.source,async()=>{if(j.status==='rolled_back')return this.summary(j);if(!['applied','recovery_required'].includes(j.status))throw Error('Rollback requires an applied or recovered transfer');
  const entries=[...(j.journal??[])].reverse(),conflicts=[];
  for(const e of entries){const c=j.changes.find(c=>c.path===e.path),now=await inspect(j.source,c.path);if(!same(now,c.after)&&!same(now,c.before))conflicts.push({path:c.path,reason:'Later source change; rollback will not overwrite it'});}
  if(conflicts.length){j.conflicts=conflicts;await this.save(j);throw Error('Rollback conflicts: '+JSON.stringify(conflicts));}
  j.status='rolling_back';await this.save(j);
  try{for(const e of entries){const c=j.changes.find(c=>c.path===e.path),now=await inspect(j.source,c.path);if(same(now,c.before)){e.state='restored';continue;}if(!same(now,c.after))throw Error('Source changed during rollback: '+c.path);await this.writeVersion(j,c,'before');e.state='restored';await this.save(j);}
   for(const relative of [...(j.created_dirs??[])].reverse()){const p=path.join(j.source,relative);try{await fs.rmdir(p);}catch(e){if(!['ENOENT','ENOTEMPTY'].includes(e.code))throw e;}}
   j.status='rolled_back';await this.save(j);return this.summary(j);
  }catch(e){j.status='recovery_required';j.error=e.message;await this.save(j);throw e;}
 });});}
 async cleanup(id,{discard=false}={}){return this.exclusive(id,async()=>{const j=await this.read(id);if(['applying','rolling_back','recovery_required'].includes(j.status))throw Error('Resolve the transfer journal before cleanup');
  if(j.registered&&!discard){if(!j.collected_plan)throw Error('Collect the worktree before cleanup, or explicitly discard its changes');const current=await scanSource(j.work,{includeUntracked:true,includeIgnored:j.collected_plan.selection?.includeIgnored??[]});const shape=p=>JSON.stringify(p.files.map(f=>({path:f.path,exists:f.exists,sha256:f.sha256})).sort((a,b)=>a.path.localeCompare(b.path)));if(current.issues.length||shape(current)!==shape(j.collected_plan))throw Error('Worktree changed after collection; collect again or explicitly discard');const saved=new Set(current.files.filter(f=>f.exists).map(f=>f.path)),unselected=(await inventory(j.work)).filter(p=>!saved.has(p));if(unselected.length)throw Error('Uncollected ignored/sensitive files require explicit discard: '+JSON.stringify({count:unselected.length,roots:[...new Set(unselected.map(p=>p.split('/')[0]))]}));}
  if(j.registered){git(j.source,'worktree','remove','--force',j.work);j.registered=false;}if(['prepared','preparation_failed'].includes(j.status))j.status='cleaned';j.worktree_removed_at=new Date().toISOString();await this.save(j);return {...this.summary(j),retained:'Private baseline, candidate and transfer journal retained for evidence/rollback; the executable worktree is removed.'};});}
}
