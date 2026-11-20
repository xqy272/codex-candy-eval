"""1.4.4 upgrade, queue admission and business checks on disposable loopback CPR."""
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
report = WORK / 'queue144-native.json'
proof = json.loads(report.read_text()) if args.stage != 'seed' and report.exists() else {'checks': [], 'realModelRequests': 0}
ids = [next(a['account_id'] for a in s['accounts'] if a['name'].endswith(letter)) for letter in 'AB']
archive = ROOT / 'dist/cloudops.codex-candy-eval-1.4.4-x86_64-unknown-linux-gnu.tar.gz'
baseline = ROOT / 'dist/cloudops.codex-candy-eval-1.4.3-x86_64-unknown-linux-gnu.tar.gz'

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
    return {'id': uuid.uuid4().hex, 'accountIds': accounts or ids, 'clientKeyId': s['clientKeyId'],
            'model': model, 'effort': '', 'kind': kind, 'profile': 'simple-v1',
            'repeats': repeats, 'concurrency': 2, 'outputVersion': 'svg-v1'}

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

def no_replay():
    assert json.loads((WORK / 'upstream-observations.json').read_text())['models'].count('eval-incomplete') == 1

if args.stage == 'seed':
    paused = submit(request('fingerprint', 'eval-incomplete', accounts=ids[:1]), 'paused')
    s['pausedId'] = paused['taskIds'][0]
    completed = submit(request('candy', 'eval-candy', 3))
    s['preservedBatchId'] = completed['request']['id']
    workspace = route('api/workspace')
    draft = {'kind': 'candy', 'model': 'eval-candy', 'keyId': s['clientKeyId'],
             'selected': ids, 'focus': ids[0], 'batchId': completed['request']['id'], 'drafts': {},
             'pending': None, 'effort': '', 'profile': 'simple-v1', 'repeats': 3, 'outputVersion': 'svg-v1'}
    route('api/workspace', {'draft': draft, 'expectedVersion': workspace['version']})
    before = snapshot()
    before['pausedSample'] = route('api/sample', {'id': s['pausedId'], 'key': wait(s['pausedId'])['attempts'][0]['key']})
    before['legacyDetail'] = route('api/detail', {'id': s['baselineRecordId']})
    (WORK / 'queue144-before.json').write_text(json.dumps(before))
    checkpoint('Released 1.4.3 on CPR 3.43.1 retains a legacy answer, repeated batch, draft and unknown-consumption sample for upgrade')
elif args.stage == 'upgrade':
    assert manifest(archive)['state'] == manifest(baseline)['state']
    (WORK / 'switch-complete').unlink(missing_ok=True)
    (WORK / 'switch-host').write_text('0')
    deadline = time.monotonic() + 120
    while not (WORK / 'switch-complete').exists():
        assert time.monotonic() < deadline, 'Official host upgrade timed out'
        time.sleep(.25)
    c = Client()
    _, digest = c.install(archive)
    instance = next(i for i in c.api('/api/admin/plugins/instances') if i['id'] == s['instanceId'])
    c.api('/api/admin/plugins/instances/switch-version', {'id': instance['id'], 'target': {'artifactSha256': digest, 'expectedRevision': instance['revision']}})
    before = json.loads((WORK / 'queue144-before.json').read_text())
    assert snapshot() == {k: v for k, v in before.items() if k.startswith('api/')}
    assert route('api/sample', {'id': s['pausedId'], 'key': wait(s['pausedId'])['attempts'][0]['key']}) == before['pausedSample']
    assert route('api/detail', {'id': s['baselineRecordId']}) == before['legacyDetail']
    no_replay()
    s['artifactSha256'] = digest
    proof.update({'archiveSha256': digest, 'hostVersion': '3.53.1', 'hostBinarySha256': hashlib.sha256((ROOT / '.runtime/hosts/3.53.1/codex-proxy-rs/codex-proxy-rs').read_bytes()).hexdigest()})
    checkpoint('Same database and plugin instance upgrade from CPR 3.43.1 / plugin 1.4.3 to CPR 3.53.1 / plugin 1.4.4 preserves all state and does not replay the uncertain sample')
elif args.stage == 'business':
    for kind, model, key in [('candy', 'eval-markdown', 'candyBatchId'), ('fingerprint', 'eval-fp', 'fingerprintBatchId'), ('pelican', 'eval-pelican', 'drawingBatchId'), ('ciallo', 'eval-ciallo', 'cialloBatchId')]:
        batch = submit(request(kind, model))
        rows = [wait(task_id) for task_id in batch['taskIds']]
        assert all(r['pluginVersion'] == '1.4.4' and r['validSamples'] == (3 if kind == 'fingerprint' else 1) for r in rows)
        if kind == 'fingerprint':
            assert all(r['attribution']['results'] for r in rows)
        s[key] = batch['request']['id']
        checkpoint('Final archive completes two-account ' + kind + ' on official CPR 3.53.1')
    incomplete = submit(request('ciallo', 'eval-ciallo-incomplete'), 'paused')
    assert all(wait(i)['answerPreview'] == 'Partial Ciallo fixture.' for i in incomplete['taskIds'])
    s['incompleteCialloBatchId'] = incomplete['request']['id']
    no_replay()
    checkpoint('Incomplete Ciallo remains paused and preserves its partial reply on CPR 3.53.1')
elif args.stage == 'capacity':
    initial = route('api/tasks')['capacity']
    assert initial == {'limit': 16, 'used': 3, 'available': 13}, initial
    batches = [submit(request('candy', 'eval-error', n, ids[:1]), 'paused') for n in [5, 5]]
    assert route('api/tasks')['capacity'] == {'limit': 16, 'used': 13, 'available': 3}
    last_request = request('candy', 'eval-error', 3, ids[:1])
    last = submit(last_request, 'paused')
    assert route('api/tasks')['capacity'] == {'limit': 16, 'used': 16, 'available': 0}
    assert route('api/batch-submit', last_request)['batch']['taskIds'] == last['taskIds']
    rejected = request('candy', 'eval-candy', accounts=ids[:1])
    assert c.route('api/batch-submit', rejected)[0] == 409
    assert all(b['request']['id'] != rejected['id'] for b in route('api/batches')['records'])
    checkpoint('Real host reports all 16 unfinished tasks, rejects over-capacity admission and accepts the same full-queue batch ID without duplicate work')
    for batch in batches + [last]:
        route('api/batch-stop', {'id': batch['request']['id']})
    assert route('api/tasks')['capacity'] == initial
    no_replay()
    checkpoint('Stopping the controlled failed batches releases exactly 13 task places and leaves the original uncertain sample untouched')
