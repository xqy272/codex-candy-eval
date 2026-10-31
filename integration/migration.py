"""用已发布旧包复现状态冲突，验证两种旧格式向当前版迁移。"""
from native_client import Client,WORK,ROOT
import json,time,hashlib,uuid
r=ROOT
state=json.loads((WORK/'state.json').read_text());c=Client()
before=c.route('api/history')[1]['records'];assert before
(WORK/'upgrade-host').touch()
for _ in range(180):
    if (WORK/'host-upgraded').exists():break
    time.sleep(.5)
else:raise RuntimeError('Isolated host upgrade did not finish')
c=Client()
def instance():return next(v for v in c.api('/api/admin/plugins/instances') if v['id']==state['instanceId'])
_,broken=c.install(r/'dist/cloudops.codex-candy-eval-1.1.0-x86_64-unknown-linux-gnu.tar.gz')
def switch(digest):return c.raw('/api/admin/plugins/instances/switch-version',{'id':state['instanceId'],'target':{'artifactSha256':digest,'expectedRevision':instance()['revision']}})
status,result=switch(broken);assert status==409,(status,result)
assert '状态' in result.get('message',''),result
print('PASS: original 1.0.0 -> 1.1.0 state conflict reproduced on real upgraded host',flush=True)
if instance()['enabled']:c.api('/api/admin/plugins/instances/disable',{'id':state['instanceId']})
status,result=switch(broken);assert status==409,(status,result)
print('PASS: disabling the original instance does not bypass the schema conflict',flush=True)
_,fixed=c.install(r/'dist/cloudops.codex-candy-eval-1.1.1-x86_64-unknown-linux-gnu.tar.gz')
status,result=switch(fixed);assert status==200,(status,result)
i=instance()
if not i['enabled']:c.api('/api/admin/plugins/instances/update',{'id':i['id'],'instance':{k:i[k]for k in ['name','artifactSha256','configuration','bindings']}|{'enabled':True,'expectedRevision':i['revision']}})
assert instance()['running'] and instance()['loadError'] is None
after=c.route('api/history')[1]['records']
assert all(next(v for v in after if v['id']==record['id'])==record for record in before)
for record in before:assert c.route('api/detail',{'id':record['id']})[1]['record']==record
print('PASS: 1.0.0 -> 1.1.1 native migration retains every original record byte-for-byte as JSON',flush=True)
req={'id':'migration-new-run','accountId':state['accounts'][0]['account_id'],'clientKeyId':state['clientKeyId'],'model':'eval-candy','effort':'','kind':'candy','profile':'simple-v1'}
status,result=c.route('api/run',req);assert status==200 and result['persisted'] and result['record']['status']=='correct',(status,result)
assert c.route('api/detail',{'id':req['id']})[1]['record']['samples'][0]['answer']['text']=='21'
c.api('/api/admin/plugins/instances/disable',{'id':state['instanceId']});i=instance()
c.api('/api/admin/plugins/instances/update',{'id':i['id'],'instance':{k:i[k]for k in ['name','artifactSha256','configuration','bindings']}|{'enabled':True,'expectedRevision':i['revision']}})
assert any(v['id']==req['id']for v in c.route('api/history')[1]['records'])
print('PASS: schema 2 writes and disable/re-enable preserve new details',flush=True)
(WORK/'migration-report.json').write_text(json.dumps({'old_plugin':'1.0.0','broken_plugin':'1.1.0','fixed_plugin':'1.1.1','host_path':['3.35.1','3.36.0'],'old_history_preserved':True,'disabled_old_conflict_reproduced':True,'new_writes_and_reenable':True,'fixed_sha256':fixed},indent=2))

c=Client();s=json.loads((WORK/'state.json').read_text())
c.api('/api/admin/plugins/instances/disable',{'id':s['instanceId']})
broken=hashlib.sha256((r/'dist/cloudops.codex-candy-eval-1.1.0-x86_64-unknown-linux-gnu.tar.gz').read_bytes()).hexdigest()
fixed=hashlib.sha256((r/'dist/cloudops.codex-candy-eval-1.1.1-x86_64-unknown-linux-gnu.tar.gz').read_bytes()).hexdigest()
created=c.api('/api/admin/plugins/instances',{'name':'Migration from 1.1.0','artifactSha256':broken,'enabled':True,'configuration':{},'bindings':[]})
id=created['id'];c.extension=lambda:next(v for v in c.api('/api/admin/plugins/extensions')if v['target']['instanceId']==id)
req={'id':str(uuid.uuid4()),'accountId':s['accounts'][0]['account_id'],'clientKeyId':s['clientKeyId'],'model':'eval-candy','effort':'','kind':'candy','profile':'codex-context-v1'}
status,result=c.route('api/run',req);assert status==200 and result['persisted'],(status,result)
before=c.route('api/detail',{'id':req['id']})[1]['record'];summary=c.route('api/history')[1]['records']
i=next(v for v in c.api('/api/admin/plugins/instances')if v['id']==id)
c.api('/api/admin/plugins/instances/switch-version',{'id':id,'target':{'artifactSha256':fixed,'expectedRevision':i['revision']}})
assert c.route('api/history')[1]['records']==summary
assert c.route('api/detail',{'id':req['id']})[1]['record']==before
report=json.loads((WORK/'migration-report.json').read_text());report['v110_summary_and_details_preserved']=True
(WORK/'migration-report.json').write_text(json.dumps(report,indent=2))
s['instanceId']=id;(WORK/'state.json').write_text(json.dumps(s))
print('PASS: 1.1.0 -> 1.1.1 preserves both summaries and separate detail namespace',flush=True)
