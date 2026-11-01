"""复现整轮缓冲容量失败，并验证同一受控响应经流式接口完成。"""
from native_client import *
c=Client();s=json.loads((WORK/'state.json').read_text())
def instance():return next(v for v in c.api('/api/admin/plugins/instances') if v['id']==s['instanceId'])
def run():
 req={'id':str(uuid.uuid4()),'accountId':s['accounts'][0]['account_id'],'clientKeyId':s['clientKeyId'],'kind':'candy','model':'eval-large','effort':'','profile':'simple-v1'}
 status,result=c.route('api/run',req,timeout=150);assert status==200,(status,result);return result
old=run();assert old['record']['status']=='failed' and old['record']['samples'][0]['status']=='capacity',old
assert old['record']['samples'][0]['requestId'] is None
print('PASS: published 1.1.1 fails with capacity and no request ID on controlled large event response',flush=True)
_,digest=c.install(ROOT/'dist/cloudops.codex-candy-eval-1.1.2-x86_64-unknown-linux-gnu.tar.gz')
c.api('/api/admin/plugins/instances/switch-version',{'id':s['instanceId'],'target':{'artifactSha256':digest,'expectedRevision':instance()['revision']}})
new=run();assert new['persisted'] and new['record']['status']=='correct',new
assert new['record']['samples'][0]['answer']['text']=='21' and new['record']['samples'][0]['requestId']
assert new['record']['samples'][0]['answer']['usage']['total_tokens']==25
print('PASS: 1.1.2 drains the same large event response, preserves request ID, terminal and usage',flush=True)
report={'observed_date':'2026-11-01','host':'CPR 3.36.0','old_plugin':'1.1.1','new_plugin':'1.1.2','fixture':'800 empty text delta events with 8192-byte ignored extension field, followed by complete answer 21','old_status':old['record']['samples'][0]['status'],'new_status':new['record']['status'],'request_id_preserved':True,'archive_sha256':digest,'real_model_requests':False}
(WORK/'streaming-report.json').write_text(json.dumps(report,indent=2))
