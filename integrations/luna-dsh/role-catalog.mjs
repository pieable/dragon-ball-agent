import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
export const LUNA_ROLES = Object.freeze(['worker', 'explorer', 'code-executor', 'web-researcher']);
export const CODEX_ONLY_ROLES = Object.freeze(['default', 'content-designer', 'visual-usability-tester']);
export class RoleCatalogError extends Error {
  constructor(code, message) { super(message); this.name = 'RoleCatalogError'; this.code = code; }
}

// Parse locally with the installed Python standard library. Only whitelisted
// role fields leave this process; config credentials and providers never do.
const SCRIPT = String.raw`
import sys,json,pathlib,hashlib
try:
 import tomllib
except ImportError:
 print(json.dumps({'error':{'code':'TOMLLIB_UNAVAILABLE','message':'Python 3.11+ with tomllib is required'}})); sys.exit(0)
def fail(code,message):
 return {'error':{'code':code,'message':message}}
def read(p):
 try: b=p.read_bytes()
 except FileNotFoundError: return None,fail('SOURCE_MISSING','Required source missing: '+str(p))
 except OSError: return None,fail('SOURCE_UNREADABLE','Cannot read source: '+str(p))
 try: v=tomllib.loads(b.decode('utf-8-sig'))
 except (ValueError,UnicodeError): return None,fail('INVALID_TOML','Invalid UTF-8 TOML: '+str(p))
 return (v,{'path':str(p),'sha256':hashlib.sha256(b).hexdigest()}),None
h=pathlib.Path(sys.argv[1]).resolve()
pair,error=read(h/'config.toml')
if error: print(json.dumps(error)); sys.exit(0)
c,cs=pair
agents=c.get('agents',{})
if not isinstance(agents,dict): print(json.dumps(fail('INVALID_CONFIG','agents must be a table'))); sys.exit(0)
result={'codex_home':str(h),'config_source':cs,'global_features':c.get('features',{}),'global_skills':c.get('skills',{}),'limits':{k:agents[k] for k in ['max_depth','max_concurrent_threads_per_session'] if k in agents},'roles':[]}
for name in json.loads(sys.argv[2]):
 entry=agents.get(name,{})
 if not isinstance(entry,dict): result['roles'].append({'name':name,**fail('INVALID_ROLE','Role registration must be a table')}); continue
 filename=entry.get('config_file','agents/'+name+'.toml')
 if not isinstance(filename,str) or not filename: result['roles'].append({'name':name,**fail('INVALID_ROLE','config_file must be a path')}); continue
 p=pathlib.Path(filename)
 if not p.is_absolute(): p=h/p
 p=p.resolve()
 pair,error=read(p)
 if error: result['roles'].append({'name':name,**error}); continue
 v,source=pair
 result['roles'].append({'name':name,'description':v.get('description',entry.get('description')),'developer_instructions':v.get('developer_instructions'),'model':v.get('model'),'effort':v.get('model_reasoning_effort'),'features':v.get('features',{}),'skills':v.get('skills',{}),'source':source})
print(json.dumps(result,ensure_ascii=True))
`;

export async function loadRoleCatalog({ codexHome = process.env.DSH_AGENTS_HOME, pythonExecutable = 'python' } = {}) {
  if (typeof codexHome !== 'string' || !codexHome.trim()) throw new RoleCatalogError('CODEX_HOME_REQUIRED', 'Pass codexHome or set DSH_AGENTS_HOME');
  let stdout;
  try { ({ stdout } = await run(pythonExecutable, ['-c', SCRIPT, codexHome, JSON.stringify(LUNA_ROLES)], { windowsHide: true, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })); }
  catch (e) { throw new RoleCatalogError('PYTHON_FAILED', `Local TOML reader failed (${e.code || 'process failure'})`); }
  let catalog;
  try { catalog = JSON.parse(stdout); } catch { throw new RoleCatalogError('INVALID_READER_RESPONSE', 'Local TOML reader returned invalid JSON'); }
  if (catalog.error) throw new RoleCatalogError(catalog.error.code, catalog.error.message);
  for (const role of catalog.roles) {
    if (role.error) continue;
    if (role.model !== 'gpt-6-luna') role.error = { code: 'ROLE_MODEL_CHANGED', message: `Role ${role.name} must explicitly use gpt-6-luna; source model is ${String(role.model)}` };
    else if (!['none', 'low', 'medium', 'high', 'xhigh', 'max'].includes(role.effort)) role.error = { code: 'ROLE_EFFORT_INVALID', message: `Role ${role.name} has missing or unsupported reasoning effort` };
    else if (typeof role.description !== 'string' || !role.description.trim() || typeof role.developer_instructions !== 'string' || !role.developer_instructions.trim()) role.error = { code: 'ROLE_INSTRUCTIONS_MISSING', message: `Role ${role.name} needs description and developer_instructions` };
  }
  catalog.codex_only = CODEX_ONLY_ROLES.map(name => ({ name, destination: 'codex', reason: 'User reserved this role for Codex' }));
  return catalog;
}

export function requireRole(catalog, name) {
  if (CODEX_ONLY_ROLES.includes(name)) throw new RoleCatalogError('ROLE_CODEX_ONLY', `Role ${name} remains in Codex`);
  if (!LUNA_ROLES.includes(name)) throw new RoleCatalogError('ROLE_NOT_SUPPORTED', `Role ${String(name)} is not an approved Luna role`);
  const role = catalog.roles.find(role => role.name === name);
  if (!role) throw new RoleCatalogError('ROLE_MISSING', `Role ${name} missing from catalog`);
  if (role.error) throw new RoleCatalogError(role.error.code, role.error.message);
  return role;
}
