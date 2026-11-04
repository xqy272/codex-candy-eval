"""1.3.0 final archive: actual CPR and controlled fixtures, never real model services."""
from native_client import Client,ROOT,WORK
import json,time,uuid,sys,hashlib,datetime
c=Client();s=json.loads((WORK/'state.json').read_text());checks=[]
archive=ROOT/'dist/cloudops.codex-candy-eval-1.3.0-x86_64-unknown-linux-gnu.tar.gz'
digest=hashlib.sha256(archive.read_bytes()).hexdigest()
account=lambda name:next(a['account_id'] for a in s['accounts'] if a['name'].endswith(name))
a,b=account('A'),account('B')
def route(path,data=None):
 status,value=c.route(path,data);assert status==200,(path,status,value);return value
def ok(name):checks.append(name);print('PASS: '+name,flush=True)
def wait_task(id,statuses=('completed','paused','stopped'),timeout=180):
 deadline=time.monotonic()+timeout
 while time.monotonic()<deadline:
  r=route('api/task',{'id':id})['record']
  if r and r['status'] in statuses:return r
  time.sleep(.25)
 raise AssertionError(('Task deadline',id,r))
def request(kind,model,accounts=None,repeats=1,concurrency=2):
 return {'id':uuid.uuid4().hex,'accountIds':accounts or [a],'clientKeyId':s['clientKeyId'],'model':model,'effort':'high','kind':kind,'profile':'simple-v1','repeats':repeats,'concurrency':concurrency,'outputVersion':'svg-v1'}
def submit(req):return route('api/batch-submit',req)['batch']
def ledger():
 time.sleep(1.1);return json.loads((WORK/'upstream-observations.json').read_text())
def tasks(batch):return [wait_task(id) for id in batch['taskIds']]
version=sys.argv[2] if len(sys.argv)>2 else '3.36.0'
stage=sys.argv[1] if len(sys.argv)>1 else 'full'
if stage=='full':
 old={'id':'old-paused-'+uuid.uuid4().hex,'accountId':a,'clientKeyId':s['clientKeyId'],'model':'eval-incomplete','effort':'','kind':'fingerprint','profile':'simple-v1','step':0}
 route('api/submit',old);old_report=wait_task(old['id']);assert old_report['status']=='paused'
 old_sample=route('api/sample',{'id':old['id'],'key':old_report['attempts'][0]['key']})
 before=route('api/history');old_detail=route('api/detail',{'id':s['baselineRecordId']})
 _,installed_digest=c.install(archive);assert installed_digest==digest
 instance=next(i for i in c.api('/api/admin/plugins/instances') if i['id']==s['instanceId'])
 c.api('/api/admin/plugins/instances/switch-version',{'id':instance['id'],'target':{'artifactSha256':digest,'expectedRevision':instance['revision']}})
 assert route('api/history')==before and route('api/detail',{'id':s['baselineRecordId']})==old_detail
 new_report=route('api/task',{'id':old['id']})['record']
 assert all(new_report[k]==v for k,v in old_report.items()),(old_report,new_report)
 assert route('api/sample',{'id':old['id'],'key':old_report['attempts'][0]['key']})==old_sample
 s['artifactSha256']=digest;(WORK/'state.json').write_text(json.dumps(s))
 ok('1.2.1 same-instance upgrade retains old history, paused task, frozen plan and sample')
 first=request('candy','eval-batch',[a,b],3);batch1=submit(first);assert submit(first)==batch1
 second=request('candy','eval-batch',[b]);batch2=submit(second)
 batch3=submit(request('candy','eval-batch',[account(letter)for letter in 'ABCDE']));rows=tasks(batch1)+tasks(batch2)+tasks(batch3);assert all(r['status']=='completed' and r['verdict']=='correct' for r in rows)
 facts=ledger();events=[v for v in facts['timeline'] if v['model']=='eval-batch'];assert len(events)==12
 assert facts['peak']==2 and max(facts['account_peak'].values())==1,facts
 slow=next(v for v in events if v['account']=='A');fast=[v for v in events if v['account']!='A'];assert len([v for v in fast if v['start']<slow['end']])>=3,events
 changed=dict(first,model='eval-candy');assert c.route('api/batch-submit',changed)[0]==409
 ok('Across batches: global peak 2, same-account peak 1, fast account refills slots before slow account finishes, exact batch replay executes once')
 fp=submit(request('fingerprint','eval-partial'));partial=wait_task(fp['taskIds'][0]);assert partial['status']=='paused' and partial['validSamples']==2
 accepted=[attempt['key']for attempt in partial['attempts'] if attempt['valid']];route('api/resume',{'id':partial['id']});complete=wait_task(partial['id']);assert complete['status']=='completed' and complete['validSamples']==3
 assert [attempt['key']for attempt in complete['attempts'][:2]]==accepted and len(complete['attempts'])==4 and complete['attribution']['results']
 assert ledger()['models'].count('eval-partial')==4
 ok('Fingerprint resumes only missing/invalid samples; two valid samples retained and 4 total calls')
 stopped=submit(request('candy','eval-slow',[a,b],3));wait_task(stopped['taskIds'][0],('running',))
 deadline=time.monotonic()+10
 while time.monotonic()<deadline:
  leases=c.api('/api/admin/accounts/concurrency?accountId='+a)
  if leases['total']>0:break
  time.sleep(.1)
 assert leases['total']>0
 route('api/account-stop',{'id':stopped['request']['id'],'account_id':a})
 deadline=time.monotonic()+5
 while time.monotonic()<deadline:
  if c.api('/api/admin/accounts/concurrency?accountId='+a)['total']==0:break
  time.sleep(.1)
 assert c.api('/api/admin/accounts/concurrency?accountId='+a)['total']==0
 stopped_rows=tasks(stopped);assert all(r['status']==('stopped'if r['accountId']==a else 'completed')for r in stopped_rows)
 ok('Stopping one account durably stops all its repeats, releases its Core lease and lets sibling repeats finish')
 stopall=submit(request('candy','eval-slow',[a,b],3));wait_task(stopall['taskIds'][0],('running',));route('api/batch-stop',{'id':stopall['request']['id']})
 assert all(r['status']=='stopped' for r in tasks(stopall));assert c.route('api/resume',{'id':stopall['taskIds'][0]})[0]==409
 ok('Stopping a batch durably stops queued and in-flight children; stopped batch cannot resume')
 assert ledger()['models'].count('eval-incomplete')==1
 ok('Legacy paused request was not automatically replayed after upgrade')
 for kind,model in [('candy','eval-candy'),('fingerprint','eval-fp')]:
  row=tasks(submit(request(kind,model)))[0];assert row['status']=='completed'
 ok('Candy answer 21 and full three-sample fingerprint still complete on oldest supported host')
elif stage=='capacity':
 # One legacy paused task plus 15 new children fills the existing protected-task limit.
 paused=[r for r in route('api/tasks')['records']if r['status']=='paused']
 for r in paused[1:]:route('api/stop',{'id':r['id']})
 assert len([r for r in route('api/tasks')['records']if r['status']=='paused'])==1
 req=request('candy','eval-batch',[account(letter)for letter in 'ABCDE'],3);req['profile']='codex-context-v1'
 batch=submit(req)
 status,rejected=c.route('api/batch-submit',request('candy','eval-candy'));assert status==409 and '16' in rejected['error']['message'],(status,rejected)
 assert all(r['status']=='completed'and r['verdict']=='correct'for r in tasks(batch))
 facts=ledger()['request_facts'][-15:];assert len(facts)==15 and all(r['instructions_chars']>20000 and r['tools']>0 and r['tool_choice']=='none'for r in facts)
 ok('15-child batch creation succeeds at protected limit 16; additional submission rejects before consumption; explicit Codex context retains long instructions and tools with tool execution disabled')
elif stage=='restart':
 before=ledger()['models'].count('eval-slow')
 batch=submit(request('candy','eval-slow'));wait_task(batch['taskIds'][0],('running',))
 for enabled in [False,True]:
  i=next(i for i in c.api('/api/admin/plugins/instances')if i['id']==s['instanceId'])
  c.api('/api/admin/plugins/instances/update',{'id':i['id'],'instance':{k:i[k]for k in ['name','artifactSha256','configuration','bindings']}|{'enabled':enabled,'expectedRevision':i['revision']}})
  time.sleep(1)
 row=wait_task(batch['taskIds'][0]);assert row['status']=='paused' and row['reason'] in ['uncertain','cancelled','execution_failed','incomplete'],row
 assert ledger()['models'].count('eval-slow')==before+1
 ok('Actual plugin disable/re-enable preserves pending intent or cancellation; no uncertain request is automatically replayed')
elif stage=='drawing':
 draw=submit(request('pelican','eval-pelican-slow'));id=draw['taskIds'][0]
 live=wait_task(id,('running',));assert live['progress']['startedAt'] and live['progress']['phase']
 row=wait_task(id,timeout=230);assert row['status']=='completed' and row['durationMs']>=165000
 sample=route('api/sample',{'id':id,'key':row['attempts'][0]['key']})['sample'];assert sample['answer']['completed'] and '<svg' in sample['answer']['text'] and row['outputVersion']=='svg-v1'
 assert ledger()['models'].count('eval-pelican-slow')==1
 s['drawingBatchId']=draw['request']['id'];(WORK/'state.json').write_text(json.dumps(s))
 ok('165-second drawing finishes once, beyond former 150-second limit, with successful termination, SVG, usage and request ID')
else:
 assert next(i for i in c.api('/api/admin/plugins/instances') if i['id']==s['instanceId'])['artifactSha256']==digest
 assert route('api/detail',{'id':s['baselineRecordId']})['record']
 for kind,model in [('candy','eval-candy'),('fingerprint','eval-fp')]:
  row=tasks(submit(request(kind,model)))[0];assert row['status']=='completed';assert row['validSamples']==(3 if kind=='fingerprint' else 1)
 ok('Final archive loads, retained old state, catalog, candy 21 and three-sample fingerprint')
report={'version':version,'archiveSha256':digest,'stage':stage,'observedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'checks':checks,'productionRequests':0,'fixtureLedger':{k:v for k,v in ledger().items() if k in ['peak','account_peak','timeline']}}
(ROOT/'docs'/f'native-1.3.0-{version}-{stage}.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
