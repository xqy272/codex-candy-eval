"""1.4.5 paused-queue regression on disposable CPR 3.53.1 and loopback fixtures."""
import argparse
import datetime
import hashlib
import json
import tarfile
import time
import uuid
from native_client import Client, ROOT, WORK

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('stage', choices=['seed', 'upgrade', 'business', 'capacity'])
args = parser.parse_args()
c = Client()
s = json.loads((WORK / 'state.json').read_text())
report = WORK / 'paused145-native.json'
proof = json.loads(report.read_text()) if args.stage != 'seed' and report.exists() else {'checks': [], 'realModelRequests': 0}

def route(path, data=None):
    status, value = c.route(path, data)
    assert status == 200, (path, status, value)
    return value

def checkpoint(message):
    proof['checks'].append(message)
    proof['observedAtUtc'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    report.write_text(json.dumps(proof, ensure_ascii=False, indent=2))
    (WORK / 'state.json').write_text(json.dumps(s))
    print('PASS: ' + message, flush=True)

def wait(task_id):
    deadline = time.monotonic() + 180
    while time.monotonic() < deadline:
        row = route('api/task', {'id': task_id})['record']
        if row['status'] in ['completed', 'paused', 'stopped']:
            return row
        time.sleep(.2)
    raise TimeoutError('Controlled task did not finish')

def request(kind, model, repeats=1, accounts=None):
    return {'id': uuid.uuid4().hex, 'accountIds': accounts or s['allAccountIds'], 'clientKeyId': s['clientKeyId'],
            'model': model, 'effort': '', 'kind': kind, 'profile': 'simple-v1',
            'repeats': repeats, 'concurrency': 4, 'outputVersion': 'svg-v1'}

def submit(req, terminal='completed'):
    batch = route('api/batch-submit', req)['batch']
    assert all(wait(task_id)['status'] == terminal for task_id in batch['taskIds'])
    return batch

def snapshot():
    value = {path: route(path) for path in ['api/snapshot', 'api/workspace', 'api/tasks', 'api/history', 'api/batches']}
    value['api/tasks'].pop('capacity', None)
    return value

def manifest(path):
    with tarfile.open(path) as pack:
        return json.load(pack.extractfile('plugin.json'))

def ledger():
    return json.loads((WORK / 'upstream-observations.json').read_text())

def no_replay():
    assert ledger()['models'].count('eval-incomplete') == 1

if args.stage == 'seed':
    for letter in 'FGH':
        c.api('/api/admin/accounts/import', {'provider': 'openai', 'data': {'authentication_kind': 'api_key', 'name': 'Eval account ' + letter,
              'base_url': 'http://127.0.0.1:18381/v1', 'api_key': 'fixture-upstream-' + letter.lower(), 'transport': 'http'}})
    s['accounts'] = route('api/snapshot')['accounts']
    s['allAccountIds'] = [next(a['account_id'] for a in s['accounts'] if a['name'] == 'Eval account ' + letter) for letter in 'ABCDEFGH']
    deadline = time.monotonic() + 90
    while 'eval-candy' not in route('api/models', {'clientKeyId': s['clientKeyId']})['models']:
        assert time.monotonic() < deadline, 'Controlled catalog did not become ready'
        time.sleep(.5)
    original = route('api/detail', {'id': s['baselineRecordId']})['record']
    if original['status'] != 'correct':
        req = {'id': uuid.uuid4().hex, 'accountId': s['allAccountIds'][0], 'clientKeyId': s['clientKeyId'], 'model': 'eval-candy', 'effort': '', 'kind': 'candy'}
        assert route('api/run', req)['record']['status'] == 'correct'
        s['baselineRecordId'] = req['id']
    paused = submit(request('fingerprint', 'eval-incomplete', accounts=s['allAccountIds'][:1]), 'paused')
    s['pausedId'] = paused['taskIds'][0]
    incomplete = submit(request('ciallo', 'eval-ciallo-incomplete'), 'paused')
    s['pausedBatchId'] = incomplete['request']['id']
    s['pausedTaskIds'] = paused['taskIds'] + incomplete['taskIds']
    cap = route('api/tasks')['capacity']
    assert cap == {'limit': 16, 'used': 9, 'available': 7}, cap
    blocked = request('ciallo', 'eval-ciallo')
    assert c.route('api/batch-submit', blocked)[0] == 409
    assert all(b['request']['id'] != blocked['id'] for b in route('api/batches')['records'])
    completed = submit(request('candy', 'eval-candy', 3, s['allAccountIds'][:2]))
    s['preservedBatchId'] = completed['request']['id']
    workspace = route('api/workspace')
    draft = {'kind': 'ciallo', 'model': 'eval-ciallo', 'keyId': s['clientKeyId'], 'selected': s['allAccountIds'],
             'focus': s['allAccountIds'][0], 'batchId': '', 'drafts': {}, 'pending': None, 'effort': '', 'profile': 'simple-v1', 'repeats': 1, 'outputVersion': 'svg-v1'}
    route('api/workspace', {'draft': draft, 'expectedVersion': workspace['version']})
    before = snapshot()
    before['pausedDetails'] = [route('api/task', {'id': task_id}) for task_id in s['pausedTaskIds']]
    before['pausedSamples'] = [route('api/sample', {'id': task_id, 'key': wait(task_id)['attempts'][0]['key']}) for task_id in s['pausedTaskIds']]
    (WORK / 'paused145-before.json').write_text(json.dumps(before))
    no_replay()
    checkpoint('Released 1.4.4 reproduces nine paused records, zero active work, seven free places and rejection of eight new accounts')
elif args.stage == 'upgrade':
    archive = ROOT / 'dist/cloudops.codex-candy-eval-1.4.5-x86_64-unknown-linux-gnu.tar.gz'
    baseline = ROOT / 'dist/cloudops.codex-candy-eval-1.4.4-x86_64-unknown-linux-gnu.tar.gz'
    assert manifest(archive)['state'] == manifest(baseline)['state']
    _, digest = c.install(archive)
    instance = next(i for i in c.api('/api/admin/plugins/instances') if i['id'] == s['instanceId'])
    c.api('/api/admin/plugins/instances/switch-version', {'id': instance['id'], 'target': {'artifactSha256': digest, 'expectedRevision': instance['revision']}})
    before = json.loads((WORK / 'paused145-before.json').read_text())
    assert snapshot() == {k: v for k, v in before.items() if k.startswith('api/')}
    for n, task_id in enumerate(s['pausedTaskIds']):
        assert route('api/task', {'id': task_id}) == before['pausedDetails'][n]
        assert route('api/sample', {'id': task_id, 'key': wait(task_id)['attempts'][0]['key']}) == before['pausedSamples'][n]
    assert route('api/tasks')['capacity'] == {'limit': 16, 'used': 0, 'available': 16, 'paused': 9}
    s['artifactSha256'] = digest
    proof.update({'archiveSha256': digest, 'hostVersion': '3.53.1', 'hostBinarySha256': hashlib.sha256((ROOT / '.runtime/hosts/3.53.1/codex-proxy-rs/codex-proxy-rs').read_bytes()).hexdigest()})
    no_replay()
    checkpoint('Same-instance 1.4.4 to final 1.4.5 preserves every record, private draft, frozen plan and sample while immediately releasing the nine paused places without replay')
elif args.stage == 'business':
    for kind, model in [('candy', 'eval-markdown'), ('fingerprint', 'eval-fp'), ('pelican', 'eval-pelican')]:
        batch = submit(request(kind, model, accounts=s['allAccountIds'][:2]))
        assert all(wait(task_id)['pluginVersion'] == '1.4.5' for task_id in batch['taskIds'])
        checkpoint('Final archive completes two-account ' + kind + ' on official CPR 3.53.1')
    partial = submit(request('ciallo', 'eval-ciallo-incomplete', accounts=s['allAccountIds'][:2]), 'paused')
    s['resumeId'] = partial['taskIds'][1]
    no_replay()
    checkpoint('New incomplete Ciallo releases its queue places and keeps its saved replies available for manual resumption')
elif args.stage == 'capacity':
    saved = route('api/task', {'id': s['resumeId']})['record']
    saved_sample = route('api/sample', {'id': s['resumeId'], 'key': saved['attempts'][0]['key']})
    full = [route('api/batch-submit', request('candy', 'eval-slow'))['batch'] for _ in range(2)]
    assert route('api/tasks')['capacity']['used'] == 16
    assert c.route('api/resume', {'id': s['resumeId']})[0] == 409
    assert route('api/task', {'id': s['resumeId']})['record'] == saved
    assert route('api/sample', {'id': s['resumeId'], 'key': saved['attempts'][0]['key']}) == saved_sample
    checkpoint('A real full queue rejects paused resumption without changing its saved task or sample')
    for batch in full:
        route('api/batch-stop', {'id': batch['request']['id']})
    deadline = time.monotonic() + 30
    while route('api/tasks')['capacity']['used']:
        assert time.monotonic() < deadline
        time.sleep(.2)
    route('api/resume', {'id': s['resumeId']})
    resumed = wait(s['resumeId'])
    assert resumed['status'] == 'paused' and len(resumed['attempts']) == len(saved['attempts']) + 1
    assert resumed['frozenPlan'] == saved['frozenPlan']
    assert route('api/sample', {'id': s['resumeId'], 'key': saved['attempts'][0]['key']}) == saved_sample
    no_replay()
    checkpoint('After space is released, explicit resumption reuses the frozen plan, adds one controlled attempt and retains the original answer; the uncertain fingerprint is never replayed')
