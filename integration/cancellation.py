"""Observe an actual Core lease appear and disappear on a controlled request."""
from native_client import Client,WORK,ROOT
import json,time,uuid,hashlib
c=Client();s=json.loads((WORK/'state.json').read_text());account=s['accounts'][0]['account_id']
req={'id':str(uuid.uuid4()),'accountId':account,'clientKeyId':s['clientKeyId'],'model':'eval-slow','effort':'','kind':'candy','profile':'simple-v1','step':0}
assert c.route('api/submit',req)[0]==200
deadline=time.monotonic()+90
while time.monotonic()<deadline:
 leases=c.api('/api/admin/accounts/concurrency?accountId='+account)
 if leases['total']>0:break
 time.sleep(.1)
else:raise RuntimeError('Controlled Core lease was not observed')
before=leases['total'];started=time.monotonic()
assert c.route('api/stop',{'id':req['id']})[0]==200
deadline=time.monotonic()+5
while time.monotonic()<deadline:
 leases=c.api('/api/admin/accounts/concurrency?accountId='+account)
 if leases['total']==0:break
 time.sleep(.1)
assert leases['total']==0,'Stopped task retained a Core account lease'
result={'host':json.loads((WORK/'host-observation.json').read_text())['version'],'archive_sha256':hashlib.sha256((ROOT/'dist/cloudops.codex-candy-eval-1.2.1-x86_64-unknown-linux-gnu.tar.gz').read_bytes()).hexdigest(),'leases_before_stop':before,'leases_after_stop':leases['total'],'release_seconds':round(time.monotonic()-started,3),'controlled_upstream_only':True}
(ROOT/'docs/cancellation-1.2.1.json').write_text(json.dumps(result,indent=2))
print('PASS: Core lease observed, then released to zero after stop',flush=True)
