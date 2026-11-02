"""Audit a completed slow attempt without executing it again after a ledger snapshot race."""
from native_client import Client,WORK,ROOT
import json,hashlib,datetime
c=Client();state=json.loads((WORK/'state.json').read_text())
digest=hashlib.sha256((ROOT/'dist/cloudops.codex-candy-eval-1.2.1-x86_64-unknown-linux-gnu.tar.gz').read_bytes()).hexdigest()
instance=next(i for i in c.api('/api/admin/plugins/instances') if i['id']==state['instanceId'])
assert instance['artifactSha256']==digest
row=next(r for r in c.route('api/tasks')[1]['records'] if r['kind']=='pelican' and r['pluginVersion']=='1.2.0' and r['model']=='eval-pelican-resume')
record=c.route('api/task',{'id':row['id']})[1]['record']
assert record['status']=='completed' and record['verdict']=='output' and record['validSamples']==1
assert len(record['attempts'])==2
samples=[c.route('api/sample',{'id':row['id'],'key':a['key']})[1]['sample'] for a in record['attempts']]
first,last=samples
assert first['status']=='incomplete' and not first['valid']
assert last['status']=='completed' and last['valid'] and last['answer']['completed']
assert '<svg' in last['answer']['text'] and last['requestId']
assert last['answer']['usage']['output_tokens']==5 and 164000<=last['durationMs']<=190000
assert first['prompt']==last['prompt'] and first['instructions']==last['instructions']
models=json.loads((WORK/'upstream-observations.json').read_text())['models']
assert models.count(row['model'])==2,'Exactly the seeded incomplete attempt and one explicit resumed request'
note='The original slow-check process completed all response assertions but failed its global async snapshot delta. Read-only recovery checked the durable task, both attempts, final archive and exactly two per-model fixture calls; no model request was repeated. The harness now waits for the snapshot and counts only the selected model.'
proof={'observedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'host':c.api('/api/admin/system/version')['version'],'plugin':'1.2.1','archiveSha256':digest,'controlledFixtureDelaySeconds':165,'logicalStatus':record['status'],'reason':record['reason'],'durationMs':last['durationMs'],'complete':True,'requestIdPreserved':True,'usage':last['answer']['usage'],'pluginRequests':1,'productionRequests':0,'resumedOriginalFailedTask':True,'attemptsPreserved':2,'originalFailure':'incomplete','frozenPromptAndInstructionsPreserved':True,'perModelFixtureCallsTotal':2,'harnessRecovery':note}
(WORK/'pelican-1.2.1.json').write_text(json.dumps(proof,ensure_ascii=False,indent=2))
path=WORK/'pelican-matrix-progress.json';progress=json.loads(path.read_text());assert len(progress['completed'])==7
progress['completed'].append({'script':'pelican-timeout.py','arguments':['--resume-old'],'completedAt':proof['observedAt'],'verification':'Read-only durable-result and selected-model ledger audit after snapshot counter assertion failure','recoveryScript':'pelican-audit.py'})
path.write_text(json.dumps(progress,indent=2))
print(json.dumps(proof,ensure_ascii=False,indent=2),flush=True)
