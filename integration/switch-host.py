"""Switch only between the matrix directories registered when starting run_host.py."""
from native_client import Client,WORK
import sys,time,re
index=int(sys.argv[1]);expected=sys.argv[2]
assert index >= 0 and re.fullmatch(r'\d+\.\d+\.\d+',expected)
(WORK/'switch-complete').unlink(missing_ok=True)
(WORK/'switch-host').write_text(str(index))
for _ in range(240):
 if (WORK/'switch-complete').exists():
  try:
   c=Client();actual=c.api('/api/admin/system/version')['version']
   if actual==expected:print('PASS: isolated same-database host switched to '+actual,flush=True);break
  except Exception:pass
 time.sleep(.5)
else:raise RuntimeError('Matrix host did not become ready')
