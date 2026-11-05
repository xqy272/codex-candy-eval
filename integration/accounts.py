"""Account-name regression on an isolated official CPR, without model calls."""
import json
from native_client import Client, ROOT, WORK

c = Client()
assert not c.api('/api/admin/accounts')['items'], 'Requires a fresh isolated fixture'
archive = ROOT/'dist/cloudops.codex-candy-eval-1.3.0-x86_64-unknown-linux-gnu.tar.gz'
installed, digest = c.install(archive)
for i in range(7):
    name = f'fixture-account-{i+1}@example.invalid'
    imported = c.api('/api/admin/accounts/import', {'provider':'openai', 'data':{
        'authentication_kind':'api_key','name':name,
        'base_url':'http://127.0.0.1:18381/v1','api_key':f'fixture-upstream-{chr(97+i%5)}','transport':'http'}})
accounts = c.api('/api/admin/accounts')['items']
for a in accounts[:6]:
    c.api('/api/admin/accounts/update',{'accountId':a['id'],'enabled':False,'concurrencyLimit':2,'weight':1,'groupIds':[]})
snapshot = c.route('api/snapshot')[1]
state = {'instanceId':installed['defaultInstanceId'],'artifactSha256':digest,'accounts':snapshot['accounts']}
(WORK/'state.json').write_text(json.dumps(state))
print(json.dumps({'archiveSha256':digest,'snapshot':snapshot['accounts'],'controlledModelCalls':0}))
