"""1.4.1 final-archive preservation and native compatibility on loopback CPR only."""
from native_client import Client, ROOT, WORK
import datetime, hashlib, json, sys, tarfile, time, uuid

c = Client()
s = json.loads((WORK / 'state.json').read_text())
stage = sys.argv[1]
report = WORK / 'ui141-native.json'
proof = json.loads(report.read_text()) if stage != 'seed' and report.exists() else {'checks': [], 'realModelRequests': 0, 'hosts': []}
archive = ROOT / 'dist/cloudops.codex-candy-eval-1.4.1-x86_64-unknown-linux-gnu.tar.gz'
baseline = ROOT / 'dist/cloudops.codex-candy-eval-1.4.0-x86_64-unknown-linux-gnu.tar.gz'
ids = [next(a['account_id'] for a in s['accounts'] if a['name'].endswith(letter)) for letter in 'ABCDE']

def persist_state():
    latest = json.loads((WORK / 'state.json').read_text())
    latest.update(s)
    (WORK / 'state.json').write_text(json.dumps(latest))

def route(path, data=None):
    status, value = c.route(path, data)
    assert status == 200, (path, status, value)
    return value

def checkpoint(name):
    proof['checks'].append(name)
    proof['observedAtUtc'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    report.write_text(json.dumps(proof, ensure_ascii=False, indent=2))
    print('PASS: ' + name, flush=True)

def wait(task_id, timeout=180):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        row = route('api/task', {'id': task_id})['record']
        if row and row['status'] in ['completed', 'paused', 'stopped']:
            return row
        time.sleep(.2)
    raise TimeoutError('Controlled task did not reach a terminal or paused state')

def submit(kind, model, repeats=1):
    req = {'id': uuid.uuid4().hex, 'accountIds': ids[:2], 'clientKeyId': s['clientKeyId'],
           'model': model, 'effort': '', 'kind': kind, 'profile': 'simple-v1',
           'repeats': repeats, 'concurrency': 2, 'outputVersion': 'svg-v1'}
    batch = route('api/batch-submit', req)['batch']
    assert all(wait(task_id)['status'] == 'completed' for task_id in batch['taskIds'])
    return batch

def snapshot():
    return {path: route(path) for path in ['api/snapshot', 'api/workspace', 'api/tasks', 'api/history', 'api/batches']}

def manifest(path):
    with tarfile.open(path) as pack:
        return json.load(pack.extractfile('plugin.json'))

def no_replay():
    ledger = json.loads((WORK / 'upstream-observations.json').read_text())
    assert ledger['models'].count('eval-incomplete') == 1

if stage == 'idle':
    deadline = time.monotonic() + 180
    while time.monotonic() < deadline:
        if all(row['status'] not in ['queued', 'running', 'scoring'] for row in route('api/tasks')['records']):
            print('PASS: no active controlled tasks remain', flush=True)
            break
        time.sleep(.5)
    else:
        raise TimeoutError('Controlled tasks did not become quiescent')
elif stage == 'seed':
    paused_id = 'ui141-paused-' + uuid.uuid4().hex
    route('api/submit', {'id': paused_id, 'accountId': ids[0], 'clientKeyId': s['clientKeyId'],
          'model': 'eval-incomplete', 'effort': '', 'kind': 'fingerprint', 'profile': 'simple-v1', 'step': 0})
    assert wait(paused_id)['status'] == 'paused'
    batch = submit('candy', 'eval-candy', 3)
    workspace = route('api/workspace')
    draft = {'kind': 'candy', 'model': 'eval-candy', 'keyId': s['clientKeyId'],
             'selected': ids[:2], 'focus': ids[0], 'batchId': batch['request']['id'], 'drafts': {}, 'pending': None,
             'effort': '', 'profile': 'simple-v1', 'repeats': 3, 'outputVersion': 'svg-v1'}
    route('api/workspace', {'draft': draft, 'expectedVersion': workspace['version']})
    s.update({'preservedBatchId': batch['request']['id'], 'pausedId': paused_id})
    persist_state()
    before = snapshot()
    before['sample'] = route('api/sample', {'id': paused_id, 'key': wait(paused_id)['attempts'][0]['key']})
    before['detail'] = route('api/detail', {'id': s['baselineRecordId']})
    (WORK / 'ui141-before.json').write_text(json.dumps(before))
    checkpoint('Released 1.4.0 on official CPR 3.43.1 seeded with history, repeated batch, draft and unknown-consumption sample')
elif stage == 'upgrade':
    assert manifest(archive)['state'] == manifest(baseline)['state']
    _, digest = c.install(archive)
    instance = next(i for i in c.api('/api/admin/plugins/instances') if i['id'] == s['instanceId'])
    c.api('/api/admin/plugins/instances/switch-version', {'id': instance['id'], 'target': {'artifactSha256': digest, 'expectedRevision': instance['revision']}})
    before = json.loads((WORK / 'ui141-before.json').read_text())
    assert snapshot() == {key: value for key, value in before.items() if key.startswith('api/')}
    assert route('api/sample', {'id': s['pausedId'], 'key': wait(s['pausedId'])['attempts'][0]['key']}) == before['sample']
    assert route('api/detail', {'id': s['baselineRecordId']}) == before['detail']
    s['artifactSha256'] = digest
    persist_state()
    proof['archiveSha256'] = digest
    no_replay()
    checkpoint('Same-instance 1.4.0 -> 1.4.1 preserves every state declaration, collection, private draft and stored answer on CPR 3.43.1')
elif stage == 'switch':
    (WORK / 'ui141-host-before.json').write_text(json.dumps(snapshot()))
    (WORK / 'switch-complete').unlink(missing_ok=True)
    (WORK / 'switch-host').write_text('0')
    deadline = time.monotonic() + 120
    while not (WORK / 'switch-complete').exists():
        if time.monotonic() >= deadline:
            raise TimeoutError('Official 3.44.0 host switch did not finish')
        time.sleep(.25)
    assert snapshot() == json.loads((WORK / 'ui141-host-before.json').read_text())
    no_replay()
    checkpoint('Official CPR 3.43.1 -> 3.44.0 preserves final plugin instance, state and unknown-consumption pause without replay')
elif stage == 'business':
    host_version = sys.argv[2]
    binary = ROOT / '.runtime/hosts' / host_version / 'codex-proxy-rs/codex-proxy-rs'
    for kind, model in [('candy', 'eval-markdown'), ('fingerprint', 'eval-fp'), ('pelican', 'eval-pelican')]:
        batch = submit(kind, model)
        rows = [wait(task_id) for task_id in batch['taskIds']]
        assert all(row['pluginVersion'] == '1.4.1' and row['validSamples'] == (3 if kind == 'fingerprint' else 1) for row in rows)
        if kind == 'fingerprint':
            assert all(row['attribution']['results'] for row in rows)
        if kind == 'pelican':
            s['drawingBatchId'] = batch['request']['id']
            persist_state()
        checkpoint('Final archive completes two-account ' + kind + ' on official CPR ' + host_version)
    no_replay()
    proof['hosts'].append({'version': host_version, 'binarySha256': hashlib.sha256(binary.read_bytes()).hexdigest()})
    report.write_text(json.dumps(proof, ensure_ascii=False, indent=2))
else:
    raise ValueError('Unknown isolated verification stage')
