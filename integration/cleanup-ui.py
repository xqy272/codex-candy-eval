"""Read-only check that run_host.py removed only its own temporary resources."""
from pathlib import Path
import json, socket
ROOT = Path(__file__).resolve().parents[1]
WORK = ROOT/'.runtime/integration'
target = json.loads((WORK/'cleanup-target.json').read_text())
runtime = Path(target['root'])
assert str(runtime).startswith('/tmp/cpr-eval-')
closed = {}
for port in target['ports']:
    connection = socket.socket()
    connection.settimeout(.5)
    closed[str(port)] = connection.connect_ex(('127.0.0.1', port)) != 0
    connection.close()
report = {'temporaryDatabaseAndCredentialsRemoved': not runtime.exists(),
          'controlFileRemoved': not (WORK/'control.json').exists(),
          'portsClosed': closed}
(WORK/'cleanup-ui.json').write_text(json.dumps(report, indent=2))
assert report['temporaryDatabaseAndCredentialsRemoved'] and report['controlFileRemoved'] and all(closed.values())
print('PASS: temporary database, credentials, control file and four loopback listeners removed')
