"""Native old/new regression using only the local 165-second SVG fixture."""
from native_client import Client,WORK,ROOT
import json,time,uuid,sys,hashlib,datetime
c=Client();s=json.loads((WORK/'state.json').read_text())
old='--old' in sys.argv
version='1.2.0' if old else '1.2.1'
archive=ROOT/f'dist/cloudops.codex-candy-eval-{version}-x86_64-unknown-linux-gnu.tar.gz'
digest=hashlib.sha256(archive.read_bytes()).hexdigest()
instance=next(i for i in c.api('/api/admin/plugins/instances') if i['id']==s['instanceId'])
assert instance['artifactSha256']==digest,instance
req={'id':str(uuid.uuid4()),'accountId':s['accounts'][0]['account_id'],'clientKeyId':s['clientKeyId'],'model':'eval-pelican-slow','effort':'high','kind':'pelican','profile':'simple-v1','step':0}
resume='--resume-old' in sys.argv
if resume:
 record=next(r for r in c.route('api/tasks')[1]['records'] if r['kind']=='pelican' and r['status']=='paused' and r['reason'] in ['timeout','incomplete'] and r['pluginVersion']=='1.2.0')
 original_failure=record['reason']
 req['id']=record['id']
 req['model']=record['model']
ledger=lambda:json.loads((WORK/'upstream-observations.json').read_text())['models']
time.sleep(1.2)
count=ledger().count(req['model'])
assert c.route('api/resume',{'id':req['id']})[0]==200 if resume else c.route('api/submit',req)[0]==200
deadline=time.monotonic()+245
while time.monotonic()<deadline:
 status,data=c.route('api/task',{'id':req['id']});assert status==200
 record=data['record']
 if record['status'] in ['paused','completed','stopped']:break
 time.sleep(.5)
else:raise RuntimeError('Task did not settle')
attempt=record['attempts'][-1]
sample=c.route('api/sample',{'id':req['id'],'key':attempt['key']})[1]['sample']
if old:
 assert record['status']=='paused' and record['reason']=='timeout',record
 assert 148000<=sample['durationMs']<=155000,sample
else:
 assert record['status']=='completed' and record['verdict']=='output',record
 assert 164000<=sample['durationMs']<=190000,sample['durationMs']
 assert sample['answer']['completed'] and '<svg' in sample['answer']['text'] and sample['requestId']
 assert sample['answer']['usage']['output_tokens']==5
 if resume:assert len(record['attempts'])==2 and record['attempts'][0]['status']==original_failure
time.sleep(1.2)
assert ledger().count(req['model'])==count+1,'Unexpected duplicate request'
proof={'observedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'host':c.api('/api/admin/system/version')['version'],'plugin':version,'archiveSha256':digest,'controlledFixtureDelaySeconds':165,'logicalStatus':record['status'],'reason':record['reason'],'durationMs':sample['durationMs'],'complete':sample.get('answer',{}).get('completed') if sample.get('answer') else False,'requestIdPreserved':bool(sample.get('requestId')),'usage':sample.get('answer',{}).get('usage') if sample.get('answer') else None,'pluginRequests':1,'productionRequests':0}
proof.update(resumedOriginalFailedTask=resume,attemptsPreserved=len(record['attempts']))
if resume:proof['originalFailure']=original_failure
(WORK/f'pelican-{version}.json').write_text(json.dumps(proof,ensure_ascii=False,indent=2))
print(json.dumps(proof,ensure_ascii=False,indent=2),flush=True)
