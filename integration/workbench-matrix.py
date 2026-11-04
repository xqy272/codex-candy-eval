"""Continue a final-archive native matrix without fetching internet release metadata."""
from native_client import ROOT,WORK,Client
import subprocess,sys,time,json,hashlib,datetime
hosts=[('3.36.0',ROOT.parents[0]/'eval-native/v3.36.0/codex-proxy-rs'),('3.38.2',ROOT.parents[0]/'candy12/.runtime/hosts/3.38.2/codex-proxy-rs'),('3.39.0',ROOT.parents[0]/'candy121/.runtime/hosts/3.39.0/codex-proxy-rs')]
for index,(version,directory) in enumerate(hosts[1:]):
 (WORK/'switch-complete').unlink(missing_ok=True);(WORK/'switch-host').write_text(str(index))
 for _ in range(300):
  if (WORK/'switch-complete').exists():break
  time.sleep(.5)
 else:raise RuntimeError('Isolated matrix host switch did not complete')
 c=Client();assert c.route('api/snapshot')[0]==200
 print('Native host: '+version,flush=True)
 subprocess.run([sys.executable,str(ROOT/'integration/workbench.py'),'compat',version],check=True)
 if index==1:
  for stage in ['restart','drawing','capacity']:subprocess.run([sys.executable,str(ROOT/'integration/workbench.py'),stage,version],check=True)
report={'observedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'identitySource':'Explicit run_host.py registered release directories; actual running binary SHA-256; no external release lookup','hosts':[{'version':v,'binarySha256':hashlib.sha256((p/'codex-proxy-rs').read_bytes()).hexdigest()} for v,p in hosts]}
(ROOT/'docs/native-hosts-1.3.0.json').write_text(json.dumps(report,indent=2))
