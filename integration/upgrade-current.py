"""Upgrade real 1.0.0 state across a host update, then separate 1.1.2 state."""
from native_client import *
import time
c=Client();s=json.loads((WORK/'state.json').read_text())
before=c.route('api/history')[1]['records'];assert before
if c.api('/api/admin/system/version')['version']=='3.35.1':
 (WORK/'host-upgraded').unlink(missing_ok=True)
 (WORK/'upgrade-host').touch()
 for _ in range(180):
  if (WORK/'host-upgraded').exists():break
  time.sleep(.5)
 else:raise RuntimeError('Host upgrade failed')
c=Client();_,digest=c.install(ROOT/'dist/cloudops.codex-candy-eval-1.2.0-x86_64-unknown-linux-gnu.tar.gz')
def switch(id):
 i=next(i for i in c.api('/api/admin/plugins/instances') if i['id']==id)
 if i['artifactSha256']!=digest:c.api('/api/admin/plugins/instances/switch-version',{'id':id,'target':{'artifactSha256':digest,'expectedRevision':i['revision']}})
switch(s['instanceId'])
assert c.route('api/history')[1]['records']==before
for row in before:assert c.route('api/detail',{'id':row['id']})[1]['record']==row
print('PASS: released 1.0.0 -> final 1.2.0 native migration retains original full history',flush=True)
_,old=c.install(ROOT/'dist/cloudops.codex-candy-eval-1.1.2-x86_64-unknown-linux-gnu.tar.gz')
c.api('/api/admin/plugins/instances/disable',{'id':s['instanceId']})
i=c.api('/api/admin/plugins/instances',{'name':'Released 1.1.2 upgrade','artifactSha256':old,'enabled':True,'configuration':{},'bindings':[]})
s['instanceId']=i['id'];(WORK/'state.json').write_text(json.dumps(s))
req={'id':str(uuid.uuid4()),'accountId':s['accounts'][0]['account_id'],'clientKeyId':s['clientKeyId'],'model':'eval-candy','effort':'','kind':'candy','profile':'codex-context-v1','step':0}
status,v=c.route('api/run',req);assert status==200 and v['persisted']
old_summary=c.route('api/history')[1]
old_detail=c.route('api/detail',{'id':req['id']})[1]
switch(i['id'])
assert c.route('api/history')[1]==old_summary
assert c.route('api/detail',{'id':req['id']})[1]==old_detail
s['artifactSha256']=digest;(WORK/'state.json').write_text(json.dumps(s))
(ROOT/'docs/upgrade-1.2.0.json').write_text(json.dumps({'archive_sha256':digest,'checks':['Released 1.0.0 on CPR 3.35.1 -> 3.36.0 -> 1.2.0 retains every original record','Released 1.1.2 -> 1.2.0 retains both summary and separate detail namespace'],'production_changes':False},indent=2))
print('PASS: released 1.1.2 -> final 1.2.0 retains summary and details',flush=True)
