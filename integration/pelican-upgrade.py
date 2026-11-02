"""Preserve the failed 1.2.0 task during native same-instance upgrade."""
from native_client import Client,WORK,ROOT
import runpy,json,time
c=Client()
before=c.route('api/tasks')[1]['records']
id=next(r['id'] for r in before if r.get('kind')=='pelican' and r.get('reason') in ['timeout','incomplete'] and r.get('pluginVersion')=='1.2.0')
report=c.route('api/task',{'id':id})[1]
sample=c.route('api/sample',{'id':id,'key':report['record']['attempts'][0]['key']})[1]
count=lambda:len(json.loads((WORK/'upstream-observations.json').read_text())['models'])
time.sleep(1.2) # The fixture flushes its observation snapshot once per second.
start=count()
runpy.run_path(str(ROOT/'integration/compatibility.py'))
assert c.route('api/task',{'id':id})[1]==report
assert c.route('api/sample',{'id':id,'key':report['record']['attempts'][0]['key']})[1]==sample
time.sleep(1.2)
assert count()-start==4,'Paused drawing must not auto-replay on upgrade'
(WORK/'pelican-upgrade.json').write_text(json.dumps({'oldTaskPreserved':True,'oldSamplePreserved':True,'pausedTaskNotAutomaticallyRetried':True,'controlledCompatibilityRequests':4,'productionRequests':0},indent=2))
print('PASS: 1.2.0 paused drawing and sample preserved; no automatic replay',flush=True)
