"""1.4.0 final-archive upgrade and execution checks on isolated official CPR."""
from native_client import Client, ROOT, WORK
import datetime, hashlib, json, sys, tarfile, time, uuid

stage = sys.argv[1]
c = Client()
s = json.loads((WORK/'state.json').read_text())
proof_path = WORK/'native-ui-proof.json'
proof = json.loads(proof_path.read_text()) if proof_path.exists() and stage != 'seed' else {'checks': [], 'realModelRequests': 0}

def route(path, data=None):
    status, value = c.route(path, data)
    assert status == 200, (path, status, value)
    return value

def wait(id, statuses=('completed', 'paused', 'stopped'), timeout=180):
    deadline = time.monotonic()+timeout
    while time.monotonic() < deadline:
        row = route('api/task', {'id': id})['record']
        if row and row['status'] in statuses:
            return row
        time.sleep(.25)
    raise AssertionError(('Task deadline', id, row.get('status') if row else None))

def checkpoint(name):
    proof['checks'].append(name)
    proof_path.write_text(json.dumps(proof, ensure_ascii=False, indent=2))
    print('PASS: '+name, flush=True)

def ledger():
    return json.loads((WORK/'upstream-observations.json').read_text())

accounts = [next(a['account_id'] for a in s['accounts'] if a['name'].endswith(letter)) for letter in 'ABCDE']

def request(kind, model, ids=None, repeats=1):
    return {'id': uuid.uuid4().hex, 'accountIds': ids or accounts[:1], 'clientKeyId': s['clientKeyId'],
            'model': model, 'effort': '', 'kind': kind, 'profile': 'simple-v1',
            'repeats': repeats, 'concurrency': 2, 'outputVersion': 'svg-v1'}

def submit(req):
    return route('api/batch-submit', req)['batch']

if stage == 'seed':
    paused_id = 'baseline-paused-'+uuid.uuid4().hex
    route('api/submit', {'id': paused_id, 'accountId': accounts[0], 'clientKeyId': s['clientKeyId'],
          'model': 'eval-incomplete', 'effort': '', 'kind': 'fingerprint', 'profile': 'simple-v1', 'step': 0})
    paused = wait(paused_id)
    assert paused['status'] == 'paused'
    b = submit(request('candy', 'eval-candy', accounts[:2], 3))
    assert all(wait(id)['status'] == 'completed' for id in b['taskIds'])
    draft = {'kind': 'candy', 'model': 'eval-candy', 'keyId': s['clientKeyId'],
             'selected': accounts[:2], 'focus': accounts[0], 'batchId': b['request']['id'],
             'drafts': {}, 'pending': None, 'effort': '', 'profile': 'simple-v1', 'repeats': 3,
             'outputVersion': 'svg-v1'}
    workspace = route('api/workspace')
    route('api/workspace', {'draft': draft, 'expectedVersion': workspace['version']})
    before = {path: route(path) for path in ['api/snapshot', 'api/workspace', 'api/tasks', 'api/history', 'api/batches']}
    before['baselineDetail'] = route('api/detail', {'id': s['baselineRecordId']})
    before['pausedSample'] = route('api/sample', {'id': paused_id, 'key': paused['attempts'][0]['key']})
    (WORK/'native-ui-before.json').write_text(json.dumps(before))
    s['pausedId'] = paused_id
    s['preservedBatchId'] = b['request']['id']
    (WORK/'state.json').write_text(json.dumps(s))
    checkpoint('Released 1.3.1 on official CPR 3.39.0 seeded with legacy history, completed batch, private draft and paused sample')
    (WORK/'switch-complete').unlink(missing_ok=True)
    (WORK/'switch-host').write_text('0')
elif stage == 'upgrade':
    deadline = time.monotonic()+120
    while not (WORK/'switch-complete').exists():
        if time.monotonic() >= deadline:
            raise TimeoutError('Registered official host switch did not finish')
        time.sleep(.25)
    archive = ROOT/'dist/cloudops.codex-candy-eval-1.4.0-x86_64-unknown-linux-gnu.tar.gz'
    old = ROOT/'dist/cloudops.codex-candy-eval-1.3.1-x86_64-unknown-linux-gnu.tar.gz'
    def manifest(path):
        with tarfile.open(path) as p:
            return json.load(p.extractfile('plugin.json'))
    assert manifest(archive)['state'] == manifest(old)['state']
    _, digest = c.install(archive)
    instance = next(i for i in c.api('/api/admin/plugins/instances') if i['id'] == s['instanceId'])
    if instance['artifactSha256'] != digest:
        c.api('/api/admin/plugins/instances/switch-version', {'id': instance['id'], 'target': {'artifactSha256': digest, 'expectedRevision': instance['revision']}})
    before = json.loads((WORK/'native-ui-before.json').read_text())
    for path in ['api/snapshot', 'api/workspace', 'api/history', 'api/batches']:
        assert route(path) == before[path], path
    current_tasks = route('api/tasks')['records']
    for original in before['api/tasks']['records']:
        after = next(r for r in current_tasks if r['id'] == original['id'])
        assert original == after, original['id']
    assert route('api/detail', {'id': s['baselineRecordId']}) == before['baselineDetail']
    paused = route('api/task', {'id': s['pausedId']})['record']
    assert route('api/sample', {'id': s['pausedId'], 'key': paused['attempts'][0]['key']}) == before['pausedSample']
    time.sleep(1.2)
    assert ledger()['models'].count('eval-incomplete') == 1
    s['artifactSha256'] = digest
    (WORK/'state.json').write_text(json.dumps(s))
    proof['archiveSha256'] = digest
    proof['officialHostVersion'] = '3.43.1'
    host = ROOT/'.runtime/hosts/3.43.1/codex-proxy-rs/codex-proxy-rs'
    proof['hostBinarySha256'] = hashlib.sha256(host.read_bytes()).hexdigest()
    checkpoint('Same plugin instance upgraded across CPR 3.39.0 to 3.43.1 and 1.3.1 to 1.4.0 with every private-state declaration, old result, draft, batch and paused sample unchanged')
    checkpoint('Paused unknown-consumption request was not automatically replayed')
elif stage == 'business':
    for kind, model in [('candy', 'eval-candy'), ('fingerprint', 'eval-fp'), ('pelican', 'eval-pelican')]:
        b = submit(request(kind, model, accounts[:2]))
        rows = [wait(id) for id in b['taskIds']]
        assert all(r['status'] == 'completed' and r['validSamples'] == (3 if kind == 'fingerprint' else 1) for r in rows)
        if kind == 'candy':
            assert all(r['verdict'] == 'correct' for r in rows)
        if kind == 'fingerprint':
            assert all(r['attribution']['results'] for r in rows)
        if kind == 'pelican':
            sample = route('api/sample', {'id': rows[0]['id'], 'key': rows[0]['attempts'][0]['key']})['sample']
            assert sample['answer']['completed'] and '<svg' in sample['answer']['text']
            s['drawingBatchId'] = b['request']['id']
            (WORK/'state.json').write_text(json.dumps(s))
        checkpoint('Final archive completed two-account '+kind+' using only loopback controlled responses')
    partial = submit(request('fingerprint', 'eval-partial'))
    row = wait(partial['taskIds'][0])
    assert row['status'] == 'paused' and row['validSamples'] == 2
    kept = row['attempts'][:2]
    route('api/resume', {'id': row['id']})
    complete = wait(row['id'])
    assert complete['status'] == 'completed' and complete['validSamples'] == 3
    assert complete['attempts'][:2] == kept and len(complete['attempts']) == 4
    checkpoint('Fingerprint missing-sample resume preserves first two attempts and issues one additional controlled request')
    slow = submit(request('candy', 'eval-slow', accounts[:2], 3))
    wait(slow['taskIds'][0], ('running',))
    route('api/account-stop', {'id': slow['request']['id'], 'account_id': accounts[0]})
    rows = [wait(id) for id in slow['taskIds']]
    assert all(r['status'] == ('stopped' if r['accountId'] == accounts[0] else 'completed') for r in rows)
    checkpoint('Stopping one account covers its remaining repeats while sibling account completes')
    stopped = submit(request('candy', 'eval-slow', accounts[:2], 3))
    wait(stopped['taskIds'][0], ('running',))
    route('api/batch-stop', {'id': stopped['request']['id']})
    assert all(wait(id)['status'] == 'stopped' for id in stopped['taskIds'])
    checkpoint('Stopping whole batch persists scope and retains earlier completed batches')
    proof['observedAtUtc'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    time.sleep(1.2)
    observed_ledger = ledger()
    proof['fixtureLedger'] = {k: observed_ledger[k] for k in ['models', 'peak', 'account_peak', 'timeline']}
    proof_path.write_text(json.dumps(proof, ensure_ascii=False, indent=2))
else:
    raise ValueError('Unknown stage')
