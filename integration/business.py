"""验证真实 CPR 的调用、评分、取消、历史和版本边界。"""
from native_client import *
import concurrent.futures
c=Client();state=json.loads((WORK/'state.json').read_text());checks=[]
def ok(name):checks.append(name);print('PASS:',name,flush=True)
def request(kind,model,account=None,key=None,id=None,step=0):
 return {'id':id or str(uuid.uuid4()),'accountId':account or state['accounts'][0]['account_id'],'clientKeyId':key or state['clientKeyId'],'kind':kind,'model':model,'effort':'high','step':step}
def execute(data):
 status,result=c.route('api/run',data)
 assert status==200,(status,result)
 return result
def count():
 time.sleep(1.1)
 return len(json.loads((WORK/'upstream-observations.json').read_text())['models'])
def instances():return c.api('/api/admin/plugins/instances')
def instance():return next(i for i in instances() if i['id']==state['instanceId'])

new=ROOT/'dist/cloudops.codex-candy-eval-1.1.0-x86_64-unknown-linux-gnu.tar.gz'
_,digest=c.install(new)
if instance()['artifactSha256']!=digest:
 before=c.extension()['target']
 c.api('/api/admin/plugins/instances/switch-version',{'id':state['instanceId'],'target':{'artifactSha256':digest,'expectedRevision':instance()['revision']}})
 assert instance()['running'] and instance()['loadError'] is None
 oldpath='/api/admin/plugins/extensions/'+before['instanceId']+'/'+before['artifactSha256']+'/'+str(before['revision'])+'/api/api/history'
 assert c.raw(oldpath)[0]==409
 ok('Real host upgrade and old target invalidation')
else:ok('Current package accepted and native instance running')
assert any(r['id']==state['baselineRecordId']for r in c.route('api/history')[1]['records'])
ok('Previously persisted history retained')
r=request('candy','eval-candy');result=execute(r)
assert result['persisted'] and result['record']['status']=='correct'
assert result['record']['samples'][0]['answer']['text']=='21'
assert result['record']['samples'][0]['answer']['usage']['total_tokens']==25
state['smokeRecordId']=r['id'];state['smokeRequestId']=result['record']['samples'][0]['requestId']
ok('Candy 21 grading, complete terminal, usage and persisted record')
before_count=count();execute(r);assert count()==before_count
ok('Duplicate completed submission does not execute upstream again')
fp_id=str(uuid.uuid4())
for step in range(3):
 result=execute(request('fingerprint','eval-fp',id=fp_id,step=step))
 assert len(result['record']['samples'])==step+1
 assert result['nextStep']==(step+1 if step<2 else None)
assert result['record']['status']=='completed',result['record']['status']
assert len(result['record']['attribution']['results'])>0
assert len({s['prompt']for s in result['record']['samples']})==3
ok('Three distinct fingerprint prompts, per-step persistence and offline ranking')
result=execute(request('pelican','eval-pelican'))
assert result['record']['status']=='completed' and '<svg' in result['record']['samples'][0]['answer']['text']
ok('Pelican generation and original SVG answer preservation')
for model in ['eval-error','eval-incomplete']:
 result=execute(request('candy',model));assert result['record']['status']=='failed'
ok('HTTP error and missing response.completed are recorded as failures')
slow=request('fingerprint','eval-slow')
with concurrent.futures.ThreadPoolExecutor() as pool:
 future=pool.submit(execute,slow)
 for _ in range(40):
  if c.route('api/snapshot')[1].get('activeId')==slow['id']:break
  time.sleep(.1)
 assert c.route('api/run',request('candy','eval-candy'))[0]==409
 assert c.route('api/cancel',{'id':slow['id']})[1]['cancelled']
 result=future.result(timeout=15)
 assert result['record']['status']=='cancelled'
 assert c.route('api/snapshot')[1]['activeId'] is None
 for _ in range(20):
  leases=c.api('/api/admin/accounts/concurrency?accountId='+slow['accountId'])
  if leases['total']==0:break
  time.sleep(.1)
 assert leases['total']==0,'Cancelled execution retained an account lease'
ok('Global mutual exclusion, cancellation, request release and journal retention')
partial=request('fingerprint','eval-fp');first=execute(partial);assert first['nextStep']==1
assert c.route('api/cancel',{'id':partial['id']})[1]['record']['status']=='cancelled'
before_count=count();partial['step']=1;assert execute(partial)['record']['status']=='cancelled';assert count()==before_count
ok('Cancellation between samples preserves progress without another model call')
b=state['accounts'][1]['account_id']
c.api('/api/admin/accounts/update',{'accountId':b,'enabled':False,'concurrencyLimit':2,'weight':1,'groupIds':[]})
before_count=count();result=execute(request('candy','eval-candy',account=b));assert result['record']['status']=='failed';assert count()==before_count
ok('Unavailable selected account is rejected without falling back to another account')
c.api('/api/admin/accounts/update',{'accountId':b,'enabled':True,'concurrencyLimit':2,'weight':1,'groupIds':[]})
old=c.extension()['target']
c.api('/api/admin/plugins/instances/disable',{'id':state['instanceId']})
assert not instance()['running']
path='/api/admin/plugins/extensions/'+old['instanceId']+'/'+old['artifactSha256']+'/'+str(old['revision'])+'/api/api/history'
assert c.raw(path)[0]==409
i=instance();c.api('/api/admin/plugins/instances/update',{'id':i['id'],'instance':{k:i[k]for k in ['name','artifactSha256','configuration','bindings']}|{'enabled':True,'expectedRevision':i['revision']}})
assert instance()['running']
assert any(r['id']==state['smokeRecordId']for r in c.route('api/history')[1]['records'])
ok('Disable and re-enable invalidate old page and retain private history')
state['artifactSha256']=digest
(WORK/'state.json').write_text(json.dumps(state,ensure_ascii=False,indent=2))
(WORK/'business-report.json').write_text(json.dumps({'host':'CPR v3.36.0','checks':checks,'artifactSha256':digest,'model_requests':'local controlled upstream only'},ensure_ascii=False,indent=2))
print('All native host business checks passed',flush=True)
