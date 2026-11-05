"""Same-instance 1.3.0 -> 1.3.1 display regression, no model execution."""
from pathlib import Path
import json, hashlib, datetime, tarfile
from native_client import Client, ROOT, WORK

c = Client()
state = json.loads((WORK/'state.json').read_text())
def read(path):
    status, value = c.route(path)
    assert status == 200, (path,status)
    return value
before = {path: read(path) for path in ['api/snapshot','api/workspace','api/tasks','api/history','api/batches']}
assert before['api/workspace']['draft']['selected'] == [a['account_id'] for a in state['accounts'] if a['enabled']]
archive = ROOT/'dist/cloudops.codex-candy-eval-1.3.1-x86_64-unknown-linux-gnu.tar.gz'
baseline = ROOT/'dist/cloudops.codex-candy-eval-1.3.0-x86_64-unknown-linux-gnu.tar.gz'
def manifest(path):
    with tarfile.open(path) as package:
        return json.load(package.extractfile('plugin.json'))
assert manifest(archive)['state'] == manifest(baseline)['state']
_, digest = c.install(archive)
instance = next(i for i in c.api('/api/admin/plugins/instances') if i['id'] == state['instanceId'])
c.api('/api/admin/plugins/instances/switch-version',{'id':instance['id'],'target':{'artifactSha256':digest,'expectedRevision':instance['revision']}})
after = {path: read(path) for path in before}
assert before == after, 'Metadata, workspace or existing records changed during upgrade'
assert len(json.loads((WORK/'upstream-observations.json').read_text())['models']) == 0
state['artifactSha256'] = digest
(WORK/'state.json').write_text(json.dumps(state))
proof = {
    'observedAtUtc':datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'baselineSha256':hashlib.sha256(baseline.read_bytes()).hexdigest(),
    'archiveSha256':digest,
    'sameInstance':True,
    'allPrivateStateDeclarationsUnchanged':True,
    'snapshotWorkspaceTasksHistoryBatchesUnchanged':True,
    'controlledModelCalls':0,
    'realModelRequests':0,
}
(WORK/'accounts-upgrade.json').write_text(json.dumps(proof,indent=2))
print('PASS: final 1.3.1 same-instance upgrade; exact metadata, workspace and record equality; zero model calls')
