"""Explicitly authorized, bounded live check; credentials must already be in the isolated host."""
from native_client import Client,WORK,ROOT
import argparse,json,time,uuid,hashlib,datetime
p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--account-id',required=True)
p.add_argument('--model',required=True)
p.add_argument('--authorized-requests',type=int,required=True,choices=[4])
args=p.parse_args();c=Client();state=json.loads((WORK/'state.json').read_text())
observation=json.loads((WORK/'host-observation.json').read_text());assert observation['runtime_root']==c.control['root']
ledger_path=WORK/'real-request-ledger.json'
if ledger_path.exists():raise RuntimeError('Live ledger exists; refuse to silently repeat authorized requests')
ledger={'model':args.model,'maximum_plugin_requests':4,'jobs':[]};ledger_path.write_text(json.dumps(ledger))
def wait(id):
 deadline=time.monotonic()+600
 while time.monotonic()<deadline:
  status,value=c.route('api/task',{'id':id});assert status==200
  r=value['record']
  if r['status'] in ['completed','paused','stopped']:return r
  time.sleep(1)
 raise RuntimeError('Live task did not finish within the observation window; do not resubmit')
reports=[]
for kind in ['candy','fingerprint']:
 req={'id':str(uuid.uuid4()),'accountId':args.account_id,'clientKeyId':state['clientKeyId'],'model':args.model,'effort':'','kind':kind,'profile':'simple-v1','step':0}
 ledger['jobs'].append(req['id']);ledger_path.write_text(json.dumps(ledger))
 status,value=c.route('api/submit',req);assert status==200,(status,value)
 r=wait(req['id']);attempts=[]
 for a in r['attempts']:
  status,value=c.route('api/sample',{'id':req['id'],'key':a['key']});assert status==200
  sample=value['sample'];answer=sample.get('answer') or {};text=answer.get('text','')
  attempts.append({'status':sample['status'],'valid':sample['valid'],'response_completed':answer.get('completed',False),'has_request_id':bool(sample.get('requestId')),'duration_ms':sample['durationMs'],'text_bytes':len(text.encode()),'text_sha256':hashlib.sha256(text.encode()).hexdigest(),'usage':answer.get('usage')})
 reports.append({'kind':kind,'status':r['status'],'reason':r.get('reason'),'verdict':r.get('verdict'),'valid_samples':r['validSamples'],'expected_samples':r['expectedSamples'],'attempts':attempts,'scoring_decision':(r.get('attribution') or {}).get('decision')})
 print('Live check:',kind,r['status'],r.get('verdict'),'valid',r['validSamples'],'/',r['expectedSamples'],flush=True)
 if r['status']!='completed':break
total=sum(len(r['attempts']) for r in reports);assert total<=4
result={'observed_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'archive_sha256':hashlib.sha256((ROOT/'dist/cloudops.codex-candy-eval-1.2.0-x86_64-unknown-linux-gnu.tar.gz').read_bytes()).hexdigest(),'host':observation['version'],'model':args.model,'plugin_requests_observed':total,'maximum_authorized':4,'automatic_plugin_retries':0,'results':reports,'scope':'One end-to-end run; does not establish model identity accuracy'}
(ROOT/'docs/real-model-1.2.0.json').write_text(json.dumps(result,ensure_ascii=False,indent=2))
print('Live verification saved; plugin requests:',total,flush=True)
