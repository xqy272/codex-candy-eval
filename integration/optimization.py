"""通过真实宿主验证请求语境、分组历史及定向清理，不调用真实模型。"""
from native_client import *
c=Client();state=json.loads((WORK/'state.json').read_text());checks=[]
def run(account,profile='codex-context-v1'):
 req={'id':str(uuid.uuid4()),'accountId':account,'clientKeyId':state['clientKeyId'],'kind':'candy','model':'eval-candy','effort':'high','profile':profile}
 status,r=c.route('api/run',req);assert status==200,(status,r);assert r['persisted'] and r['record']['status']=='correct';return req,r
a,b=[v['account_id']for v in state['accounts']]
req,r=run(b);assert r['record']['requestProfile']=='codex-context-v1' and r['record']['requestContextSha256']
time.sleep(1.2)
facts=json.loads((WORK/'upstream-observations.json').read_text())['request_facts'][-1]
assert facts['instructions_chars']>20000 and facts['input_items']>3 and facts['tools']>0 and facts['tool_choice']=='none',facts
checks.append('Pinned Codex context passes through real Core with tool execution disabled')
status,history=c.route('api/history');row=next(v for v in history['records']if v['id']==req['id'])
assert row.get('summaryOnly') and row['samples']==[]
status,detail=c.route('api/detail',{'id':req['id']});assert status==200 and detail['record']['samples'][0]['answer']['text']=='21'
checks.append('History list contains summaries and detail route retrieves the original response')
req['profile']='simple-v1';assert c.route('api/run',req)[0]==409
checks.append('Reusing an execution ID with a different request profile is rejected')
cleared_id=None
for _ in range(21):cleared_id=run(a,'simple-v1')[0]['id']
rows=c.route('api/history')[1]['records'];assert len([r for r in rows if r['accountId']==a and r['kind']=='candy'])==20
assert any(r['accountId']==b and r['requestProfile']=='codex-context-v1'for r in rows)
checks.append('Per-account retention preserves another account through 21 new runs')
status,_=c.route('api/clear',{'account_id':a,'kind':'candy'});assert status==200
rows=c.route('api/history')[1]['records'];assert not any(r['accountId']==a and r['kind']=='candy'for r in rows)
assert any(r['accountId']==b for r in rows)
assert c.route('api/detail',{'id':cleared_id})[1]['record'] is None
checks.append('Scoped history clearing removes detail data and preserves unrelated account records')
(WORK/'optimization-report.json').write_text(json.dumps({'checks':checks},indent=2))
for check in checks:print('PASS:',check)
