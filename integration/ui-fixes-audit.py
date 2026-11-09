"""Export only non-secret 1.4.1 evidence after both native runs finish."""
from pathlib import Path
from collections import Counter
import datetime, hashlib, json, shutil

ROOT = Path(__file__).resolve().parents[1]
WORK = ROOT / '.runtime/integration'
archive = ROOT / 'dist/cloudops.codex-candy-eval-1.4.1-x86_64-unknown-linux-gnu.tar.gz'
digest = hashlib.sha256(archive.read_bytes()).hexdigest()
artifact = json.loads((ROOT / '.runtime/ui141-archive.json').read_text())
business = json.loads((WORK / 'ui141-native.json').read_text())
assert business['archiveSha256'] == artifact['archiveSha256'] == digest
assert len(business['checks']) == 9
assert [host['version'] for host in business['hosts']] == ['3.43.1', '3.44.0']
ui = []
for version in ['3.43.1', '3.44.0']:
    evidence = json.loads((WORK / ('ui141-' + version) / 'verification.json').read_text())
    assert evidence['hostVersion'] == version and evidence['archiveSha256'] == digest
    assert evidence['controlledUiCalls'] == 6 and not evidence['javascriptErrors']
    assert len(evidence['checks']) >= 38
    ui.append(evidence)
ledger = json.loads((WORK / 'upstream-observations.json').read_text())
assert len(ledger['models']) == 40 and ledger['active'] == 0
assert 1 <= ledger['peak'] <= 2 and max(ledger['account_peak'].values()) == 1
assert ledger['models'].count('eval-incomplete') == 1
audit = {'controlledRequestsFinalEnvironment': len(ledger['models']),
         'modelCounts': dict(Counter(ledger['models'])), 'activeAtEnd': ledger['active'],
         'globalPeak': ledger['peak'], 'maximumPerAccountPeak': max(ledger['account_peak'].values()),
         'acceptedBrowserCalls': {item['hostVersion']: item['controlledUiCalls'] for item in ui},
         'realModelRequests': 0}
for file, value in [('native-ui-business-1.4.1.json', business), ('final-audit-1.4.1.json', audit),
                    ('native-ui-1.4.1.json', {'runs': ui})]:
    (ROOT / 'docs' / file).write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
source = WORK / 'ui141-3.44.0'
for name, target in [
    ('accounts-key-help.png', 'native-ui-1.4.1-help.png'),
    ('overview-warm.png', 'native-ui-1.4.1-overview.png'),
    ('result-warm.png', 'native-ui-1.4.1-result.png'),
    ('result-dark.png', 'native-ui-1.4.1-dark.png'),
    ('result-custom.png', 'native-ui-1.4.1-custom.png'),
    ('result-mobile-390.png', 'native-ui-1.4.1-mobile.png'),
    ('result-mobile-320.png', 'native-ui-1.4.1-mobile-320.png'),
]:
    shutil.copyfile(source / name, ROOT / 'docs' / target)
proof = {
    'observedAtUtc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'version': '1.4.1', 'baseCommit': '532da98a8b4dfa735d98de649300a893ea856702',
    'archive': artifact, 'rustTestsPassed': 37, 'rustFmt': True,
    'allTargetsClippyWarningsDenied': True, 'fixedSourcesVerified': 92,
    'frontendLockedOfflineInstallAndBuild': True, 'uiTestsPassed': 34,
    'nativeBusinessChecksPassed': len(business['checks']),
    'nativeUiChecksPassed': {item['hostVersion']: len(item['checks']) for item in ui},
    'nativeHosts': business['hosts'], 'controlledRequestsFinalEnvironment': len(ledger['models']),
    'realModelRequests': 0, 'productionInspected': False, 'productionModified': False,
    'productionVersionReportedByUser': {'version': '3.44.0', 'date': '2026-11-09', 'independentlyReinspected': False},
    'evidence': ['native-ui-business-1.4.1.json', 'native-ui-1.4.1.json', 'final-audit-1.4.1.json', 'credentials-cleanup-1.4.1.json'],
    'limits': [
        'Only the official 3.43.1 and 3.44.0 hosts were run, not every patch in the declared range.',
        'Controlled fixtures establish persistence, execution and UI behavior, not model identity accuracy.',
        'Source/raw copy and grading retain original responses; reading-only formatting repairs never modify storage.',
        'Development candidates were discarded. This evidence covers a fresh database with the exact final archive only.',
        'No production plugin installation, production theme change or real model request was performed.'
    ]
}
(ROOT / 'docs/verification-1.4.1.json').write_text(json.dumps(proof, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print('PASS: non-secret final-archive evidence and CPR 3.44.0 fixture screenshots exported')
