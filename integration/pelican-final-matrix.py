"""Final archive only: fresh oldest host, then upward matrix and resumed slow drawing."""
from pathlib import Path
import subprocess,sys,json,datetime
root=Path(__file__).resolve().parents[1];work=root/'.runtime/integration'
stages=[('native_client.py',['--baseline',str(root/'dist/cloudops.codex-candy-eval-1.2.0-x86_64-unknown-linux-gnu.tar.gz')]),('pelican-seed.py',[]),('pelican-upgrade.py',[]),('switch-host.py',['0','3.38.2']),('compatibility.py',[]),('switch-host.py',['1','3.39.0']),('compatibility.py',[]),('pelican-timeout.py',['--resume-old']),('cancellation.py',[])]
progress=work/'pelican-matrix-progress.json'
completed=json.loads(progress.read_text())['completed'] if '--resume' in sys.argv else []
assert [(s['script'],s['arguments']) for s in completed]==stages[:len(completed)]
for name,args in stages[len(completed):]:
 print('Checking: '+name+' '+' '.join(args),flush=True)
 subprocess.run([sys.executable,str(root/'integration'/name),*args],check=True)
 completed.append({'script':name,'arguments':args,'completedAt':datetime.datetime.now(datetime.timezone.utc).isoformat()})
 (work/'pelican-matrix-progress.json').write_text(json.dumps({'completed':completed,'controlledUpstreamOnly':True},indent=2))
print('PASS: final archive native matrix and slow resumed drawing complete',flush=True)
