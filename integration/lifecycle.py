"""验证 Key 作用域、实际账号、中断恢复、回退和历史保留。"""
from native_client import *
import concurrent.futures,json,time,uuid
c=Client();state=json.loads((WORK/'state.json').read_text())
def request(kind,model,account=None,key=None,id=None,step=0):
 return {'id':id or str(uuid.uuid4()),'accountId':account or state['accounts'][0]['account_id'],'clientKeyId':key or state['clientKeyId'],'kind':kind,'model':model,'effort':'high','step':step}
def execute(data):
 status,result=c.route('api/run',data);assert status==200,(status,result);return result
def count():
 time.sleep(1.1);return len(json.loads((WORK/'upstream-observations.json').read_text())['models'])
def instance():return next(i for i in c.api('/api/admin/plugins/instances')if i['id']==state['instanceId'])
checks=[]
def ok(name):checks.append(name);print('PASS:',name,flush=True)
suffix=uuid.uuid4().hex[:6]
group=c.api('/api/admin/account-groups/create',{'name':'Eval isolated B scope '+suffix,'description':'Controlled integration fixture','color':'#3355FFFF'})
b=state['accounts'][1]['account_id'];a=state['accounts'][0]['account_id']
c.api('/api/admin/accounts/update',{'accountId':b,'enabled':True,'concurrencyLimit':2,'weight':1,'groupIds':[group['id']]})
key=c.api('/api/admin/client-keys/create',{'name':'Eval restricted client '+suffix,'groupIds':[group['id']],'maxConcurrency':1,'requestsPerMinute':0})
before=count();result=execute(request('candy','eval-candy',account=a,key=key['id']))
assert result['record']['status']=='failed';assert count()==before
result=execute(request('candy','eval-candy',account=b,key=key['id']))
assert result['record']['status']=='correct'
detail=c.api('/api/admin/usage/records/detail?id='+result['record']['samples'][0]['requestId'])
assert detail['accountId']==b and detail['clientApiKeyId']==key['id']
assert detail['logicalOutcome']=='succeeded',detail['logicalOutcome']
for _ in range(30):
 if detail['attemptsComplete']:break
 time.sleep(.1);detail=c.api('/api/admin/usage/records/detail?id='+result['record']['samples'][0]['requestId'])
print('Core selected-account evidence:',{'accountMatches':detail['accountId']==b,'attemptCount':detail['attemptCount'],'attemptRows':len(detail['attempts']),'attemptsComplete':detail['attemptsComplete']},flush=True)
assert detail['attempts'] and all(attempt['accountId']==b for attempt in detail['attempts'])
ok('Key account scope enforced and selected account confirmed by Core attempt facts')
slow=request('candy','eval-slow')
with concurrent.futures.ThreadPoolExecutor() as pool:
 future=pool.submit(c.route,'api/run',slow)
 for _ in range(60):
  if c.route('api/snapshot')[1].get('activeId')==slow['id']:break
  time.sleep(.1)
 i=instance();c.api('/api/admin/plugins/instances/update',{'id':i['id'],'instance':{k:i[k]for k in ['name','artifactSha256','configuration','bindings']}|{'name':'Codex eval lifecycle verified','enabled':True,'expectedRevision':i['revision']}})
 try:future.result(timeout=15)
 except Exception:pass
 for _ in range(50):
  entries=c.route('api/history')[1]['records'];saved=next((r for r in entries if r['id']==slow['id']),None)
  if saved and saved['status']=='interrupted':break
  time.sleep(.1)
 assert saved and saved['status']=='interrupted',saved
before=count();result=execute(slow);assert result['record']['status']=='interrupted';assert count()==before
ok('Runtime replacement preserves an interrupted intent and does not replay uncertain work')
before_ids={r['id']for r in c.route('api/history')[1]['records']}
if state['baselineSha256']!=state['artifactSha256']:
 i=instance();c.api('/api/admin/plugins/instances/rollback',{'id':i['id'],'target':{'artifactSha256':state['baselineSha256'],'expectedRevision':i['revision']}})
 assert instance()['artifactSha256']==state['baselineSha256'] and instance()['running']
 assert before_ids=={r['id']for r in c.route('api/history')[1]['records']}
 i=instance();c.api('/api/admin/plugins/instances/switch-version',{'id':i['id'],'target':{'artifactSha256':state['artifactSha256'],'expectedRevision':i['revision']}})
 assert instance()['running']
 assert before_ids=={r['id']for r in c.route('api/history')[1]['records']}
 ok('Version rollback and return retain compatible private state')
for n in range(21):assert execute(request('candy','eval-candy'))['persisted']
history=c.route('api/history')[1]['records'];assert len(history)==20 and len({r['id']for r in history})==20
ok('History retention bound and unique record replacement under repeated use')
(WORK/'lifecycle-report.json').write_text(json.dumps({'checks':checks},ensure_ascii=False,indent=2))
print('All lifecycle and access checks passed',flush=True)
