"""Create blank-name metadata only inside run_host.py's disposable database."""
from pathlib import Path
import argparse, json, subprocess, os
from native_client import Client, ROOT, WORK

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--postgres-bin', type=Path, required=True)
parser.add_argument('--library-dir', type=Path)
args = parser.parse_args()
control = json.loads((WORK/'control.json').read_text())
runtime = Path(control['root'])
assert runtime.parent == Path('/tmp') and runtime.name.startswith('cpr-eval-')
assert control['base'] == 'http://127.0.0.1:18380'
env = dict(os.environ)
if args.library_dir:
    env['LD_LIBRARY_PATH'] = str(args.library_dir.resolve())
sql = "update provider_accounts set name='', email=case when name like 'fixture-account-7@%' then null else name end where name like 'fixture-account-%@example.invalid';"
subprocess.run([str(args.postgres_bin.resolve()/'psql'),'-X','-v','ON_ERROR_STOP=1','-h',str(runtime/'pg'),'-p','15432','-U','cpr_eval','-d','cpr_eval','-c',sql],env=env,check=True,capture_output=True)
c = Client()
snapshot = c.route('api/snapshot')[1]
assert len(snapshot['accounts']) == 7
assert all(a['name'] == '' for a in snapshot['accounts'])
state = json.loads((WORK/'state.json').read_text())
state['accounts'] = snapshot['accounts']
(WORK/'state.json').write_text(json.dumps(state))
print('Created seven controlled blank-name accounts; six with email, one ID only; no model calls')
