"""Native background lifecycle verification. Only the controlled fixture models are used."""
from native_client import Client, WORK, ROOT
import json,time,uuid,hashlib
c=Client();state=json.loads((WORK/'state.json').read_text());checks=[]
digest=hashlib.sha256((ROOT/'dist/cloudops.codex-candy-eval-1.2.1-x86_64-unknown-linux-gnu.tar.gz').read_bytes()).hexdigest()
observation=json.loads((WORK/'host-observation.json').read_text());assert observation['runtime_root']==c.control['root']
version=observation['version']
def ok(name):
 checks.append(name)
 (WORK/'tasks-progress.json').write_text(json.dumps({'host':version,'archive_sha256':digest,'checks':checks,'controlled_upstream_only':True},ensure_ascii=False,indent=2))
 print('PASS:',name,flush=True)
def instance():return next(i for i in c.api('/api/admin/plugins/instances') if i['id']==state['instanceId'])
def task(id):
 status,v=c.route('api/task',{'id':id});assert status==200,(status,v);return v['record']
def route(path,data):
 status,v=c.route(path,data);assert status==200,(status,v);return v
def submit(kind,model,key=None):
 req={'id':str(uuid.uuid4()),'accountId':state['accounts'][0]['account_id'],'clientKeyId':key or state['clientKeyId'],'model':model,'effort':'','kind':kind,'profile':'simple-v1','step':0}
 route('api/submit',req);return req
def wait(id,statuses=('completed','paused','stopped'),timeout=180):
 deadline=time.monotonic()+timeout
 while time.monotonic()<deadline:
  r=task(id)
  if r['status'] in statuses:return r
  time.sleep(.5)
 raise RuntimeError('Task did not reach expected state: '+json.dumps(task(id)))
def count():
 time.sleep(1.1);return len(json.loads((WORK/'upstream-observations.json').read_text())['models'])
before=c.route('api/history')[1]['records']
details={r['id']:route('api/detail',{'id':r['id']})['record'] for r in before}
_,digest=c.install(ROOT/'dist/cloudops.codex-candy-eval-1.2.1-x86_64-unknown-linux-gnu.tar.gz')
upgraded=instance()['artifactSha256']!=digest
if upgraded:c.api('/api/admin/plugins/instances/switch-version',{'id':state['instanceId'],'target':{'artifactSha256':digest,'expectedRevision':instance()['revision']}})
assert instance()['running'] and not instance()['loadError']
assert c.route('api/history')[1]['records']==before
for id,value in details.items():assert route('api/detail',{'id':id})['record']==value
ok('Original instance upgrade preserves legacy summaries and full answers' if upgraded else 'Current package loads and preserves legacy-format history')
state['artifactSha256']=digest;(WORK/'state.json').write_text(json.dumps(state))
start=count();candy=submit('candy','eval-candy');route('api/submit',candy)
fp=submit('fingerprint','eval-fp');drawing=submit('pelican','eval-pelican');large=submit('candy','eval-large');incomplete=submit('candy','eval-incomplete');error=submit('candy','eval-error')
r=wait(candy['id']);assert r['verdict']=='correct';assert r['validSamples']==1
route('api/submit',candy)
ok('Durable enqueue and repeated submission execute candy exactly once')
r=wait(fp['id']);assert r['status']=='completed' and r['validSamples']==3 and r['attribution']['results'],r
assert [a['step'] for a in r['attempts']]==[0,1,2]
ok('Three frozen fingerprint challenges run and score without a page driving steps')
r=wait(drawing['id']);assert r['verdict']=='output'
s=route('api/sample',{'id':r['id'],'key':r['attempts'][0]['key']})['sample'];assert '<svg' in s['answer']['text']
ok('Drawing output is preserved independently from fingerprint and candy grading')
r=wait(large['id']);assert r['verdict']=='correct'
s=route('api/sample',{'id':r['id'],'key':r['attempts'][0]['key']})['sample'];assert s['requestId'] and s['answer']['completed']
ok('Large wire stream completes with bounded text, usage and request ID')
for req in [incomplete,error]:
 r=wait(req['id']);assert r['status']=='paused' and r['validSamples']==0,r
 route('api/stop',{'id':req['id']})
ok('Missing success terminal and provider errors pause without being graded wrong')
assert count()-start==8
ok('Native upstream ledger confirms no plugin-level duplicate or automatic retry')
bad=submit('fingerprint','eval-candy');r=wait(bad['id']);assert r['reason']=='invalid_sample'
first=r['attempts'][0]['key'];route('api/resume',{'id':bad['id']});r=wait(bad['id']);assert len(r['attempts'])==2 and r['attempts'][0]['key']==first
s1=route('api/sample',{'id':r['id'],'key':first})['sample'];s2=route('api/sample',{'id':r['id'],'key':r['attempts'][1]['key']})['sample'];assert s1['prompt']==s2['prompt']
route('api/stop',{'id':r['id']});ok('Manual continuation reuses the original challenge and preserves failed attempts')
slow=submit('candy','eval-slow');wait(slow['id'],('running',));route('api/stop',{'id':slow['id']});r=wait(slow['id']);assert r['status']=='stopped'
follow=submit('candy','eval-candy');assert wait(follow['id'])['verdict']=='correct'
ok('Stop cancels active execution and the following task can acquire the account')
slow=submit('candy','eval-slow');wait(slow['id'],('running',));i=instance()
c.api('/api/admin/plugins/instances/update',{'id':i['id'],'instance':{k:i[k]for k in ['name','artifactSha256','configuration','bindings']}|{'name':'Background replacement verified','enabled':True,'expectedRevision':i['revision']}})
r=wait(slow['id']);assert r['status']=='paused' and r['reason'] in ['uncertain','cancelled'],r
consumed=count();time.sleep(3);assert count()==consumed
route('api/stop',{'id':slow['id']});ok('Runtime replacement marks uncertain consumption and never automatically replays it')
restricted=c.api('/api/admin/account-groups/create',{'name':'Private test scope '+uuid.uuid4().hex[:6],'description':'Fixture only','color':'#3355FFFF'})
key=c.api('/api/admin/client-keys/create',{'name':'Restricted fixture','groupIds':[restricted['id']],'maxConcurrency':1,'requestsPerMinute':0})
denied=submit('candy','eval-candy',key=key['id']);r=wait(denied['id']);assert r['status']=='paused' and r['validSamples']==0
route('api/stop',{'id':denied['id']});ok('Core Key scope remains enforced for background jobs')
route('api/delete',{'id':drawing['id']});assert task(drawing['id']) is None
ok('Deletion removes only the chosen finished task and its samples')
(WORK/'tasks-report.json').write_text(json.dumps({'host':version,'archive_sha256':digest,'checks':checks,'controlled_upstream_only':True},ensure_ascii=False,indent=2))
print('All native background checks passed',flush=True)
