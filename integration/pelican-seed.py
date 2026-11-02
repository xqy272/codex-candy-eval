"""Create one original-package incomplete drawing before the same-instance upgrade."""
from native_client import Client,WORK
import json,uuid,time
c=Client();s=json.loads((WORK/'state.json').read_text())
req={'id':str(uuid.uuid4()),'accountId':s['accounts'][0]['account_id'],'clientKeyId':s['clientKeyId'],'model':'eval-pelican-resume','effort':'high','kind':'pelican','profile':'simple-v1','step':0}
assert c.route('api/submit',req)[0]==200
deadline=time.monotonic()+75
while time.monotonic()<deadline:
 r=c.route('api/task',{'id':req['id']})[1]['record']
 if r['status']=='paused':break
 time.sleep(.5)
assert r['reason']=='incomplete' and r['pluginVersion']=='1.2.0',r
print('PASS: original 1.2.0 incomplete drawing seeded for upgrade/resume',flush=True)
