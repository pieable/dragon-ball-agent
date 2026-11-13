import os
import sys
import shutil
import subprocess
import winreg
from pathlib import Path

root = Path(__file__).resolve().parent.parent
try:
    with winreg.OpenKey(winreg.HKEY_CURRENT_USER, 'Environment', 0, winreg.KEY_QUERY_VALUE) as env_key:
        key, _ = winreg.QueryValueEx(env_key, 'LUNA_OPENAI_API_KEY')
except OSError:
    print('LUNA_OPENAI_API_KEY has not been saved for this Windows user.', file=sys.stderr)
    sys.exit(1)
if not isinstance(key, str) or not key.strip():
    print('LUNA_OPENAI_API_KEY is empty.', file=sys.stderr)
    sys.exit(1)
node = shutil.which('node.exe')
if not node:
    print('Node.js executable was not found.', file=sys.stderr)
    sys.exit(1)
env = os.environ.copy()
env['LUNA_OPENAI_API_KEY'] = key
key = None
verify = '--verify-live' in sys.argv[1:]
if verify:
    env['LUNA_ALLOW_LIVE_TEST'] = '1'
entry = root / ('test/live-api-smoke.mjs' if verify else 'mcp.mjs')
try:
    code = subprocess.call([node, str(entry)], env=env, cwd=str(root))
finally:
    env.pop('LUNA_OPENAI_API_KEY', None)
sys.exit(code)
