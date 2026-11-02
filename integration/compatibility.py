"""Small final-artifact compatibility check against a real isolated host."""
from native_client import Client,WORK,ROOT
import json,time,uuid,datetime
c=Client();s=json.loads((WORK/'state.json').read_text())
version=c.api('/api/admin/system/version')['version']
(WORK/'host-observation.json').write_text(json.dumps({'version':version,'runtime_root':c.control['root'],'source':'GET /api/admin/system/version','observed_at':datetime.datetime.now(datetime.timezone.utc).isoformat()}))
before=c.route('api/history')[1]
_,digest=c.install(ROOT/'dist/cloudops.codex-candy-eval-1.2.1-x86_64-unknown-linux-gnu.tar.gz')
i=next(i for i in c.api('/api/admin/plugins/instances') if i['id']==s['instanceId'])
if i['artifactSha256']!=digest:c.api('/api/admin/plugins/instances/switch-version',{'id':i['id'],'target':{'artifactSha256':digest,'expectedRevision':i['revision']}})
assert c.route('api/history')[1]==before
snapshot=c.route('api/snapshot')[1];assert snapshot['accounts'] and snapshot['keys']
assert c.route('api/models',{'clientKeyId':s['clientKeyId']})[0]==200
requests=[]
for kind,model in [('candy','eval-candy'),('fingerprint','eval-fp')]:
 req={'id':str(uuid.uuid4()),'accountId':s['accounts'][0]['account_id'],'clientKeyId':s['clientKeyId'],'model':model,'effort':'','kind':kind,'profile':'simple-v1','step':0}
 for _ in range(2):assert c.route('api/submit',req)[0]==200
 requests.append(req)
results=[]
for req in requests:
 deadline=time.monotonic()+180
 while time.monotonic()<deadline:
  r=c.route('api/task',{'id':req['id']})[1]['record']
  if r['status'] in ['completed','paused','stopped']:break
  time.sleep(.5)
 assert r['status']=='completed',r
 if req['kind']=='candy':assert r['verdict']=='correct'
 else:assert r['validSamples']==3 and r['attribution']['results']
 results.append({'kind':r['kind'],'verdict':r['verdict'],'validSamples':r['validSamples']})
s['artifactSha256']=digest;(WORK/'state.json').write_text(json.dumps(s))
report={'host':version,'archive_sha256':digest,'checks':['Current archive loads on native host','Existing private state retained','Account and Key catalog','Model catalog','Idempotent candy submission and answer 21','Three-sample background fingerprint and ranking'],'results':results}
(ROOT/'docs'/('compatibility-1.2.1-'+version+'.json')).write_text(json.dumps(report,ensure_ascii=False,indent=2))
print('PASS: final archive compatibility on CPR '+version,flush=True)
