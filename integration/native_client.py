"""隔离测试宿主的管理 API 客户端与受控账号初始化。"""
from pathlib import Path
import json,urllib.request,urllib.error,http.cookiejar,hashlib,time,uuid
ROOT=Path(__file__).resolve().parents[1]
WORK=ROOT/'.runtime/integration'
class Client:
 def __init__(self):
  self.control=json.loads((WORK/'control.json').read_text());self.base=self.control['base']
  if self.base!='http://127.0.0.1:18380' or self.control['username']!='eval-admin':raise ValueError('只接受 run_host.py 创建的隔离测试实例')
  self.cookies=http.cookiejar.CookieJar()
  self.opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),urllib.request.HTTPCookieProcessor(self.cookies))
  self.api('/api/auth/login',{'mode':'admin','username':self.control['username'],'password':self.control['password']})
 def raw(self,path,data=None,timeout=45):
  headers={'Origin':self.base}
  if isinstance(data,bytes):headers['Content-Type']='application/octet-stream'
  elif data is not None:headers['Content-Type']='application/json';data=json.dumps(data).encode()
  req=urllib.request.Request(self.base+path,data=data,headers=headers)
  try:
   r=self.opener.open(req,timeout=timeout);return r.status,json.load(r)
  except urllib.error.HTTPError as e:
   try:body=json.load(e)
   except Exception:body={'message':'non-JSON HTTP error'}
   return e.code,body
 def api(self,path,data=None):
  status,result=self.raw(path,data)
  if status>=300:raise RuntimeError(f'{path}: HTTP {status}: {result.get("message",result.get("error",{}))}')
  return result.get('data',result)
 def extension(self):
  views=self.api('/api/admin/plugins/extensions')
  if (WORK/'state.json').exists():
   selected=json.loads((WORK/'state.json').read_text()).get('instanceId')
   matching=[v for v in views if v['target']['instanceId']==selected]
   if matching:return matching[0]
  return next(v for v in views if any(p['id']=='codex-candy-eval'for p in v['pages']))
 def route(self,path,data=None,timeout=45):
  t=self.extension()['target'];prefix='/api/admin/plugins/extensions/'+t['instanceId']+'/'+t['artifactSha256']+'/'+str(t['revision'])+'/api/'
  return self.raw(prefix+path,data,timeout)
 def install(self,path):
  source=Path(path);data=source.read_bytes();digest=hashlib.sha256(data).hexdigest()
  verify=self.api('/api/admin/plugins/artifacts/upload/verify',data)
  assert verify['metadata']['sha256']==digest
  result=self.api('/api/admin/plugins/artifacts/upload?sha256='+digest,data)
  return result,digest
if __name__=='__main__':
 import argparse
 parser=argparse.ArgumentParser(description='在隔离宿主安装测试包并创建受控账号与 Key')
 parser.add_argument('--baseline',type=Path)
 args=parser.parse_args()
 client=Client()
 if client.api('/api/admin/accounts')['items']:raise RuntimeError('测试宿主必须没有既有账号')
 old=args.baseline or ROOT/'dist/cloudops.codex-candy-eval-1.2.1-x86_64-unknown-linux-gnu.tar.gz'
 installed,digest=client.install(old)
 instances=client.api('/api/admin/plugins/instances')
 print('Verified and installed baseline; instance status:',[(v['enabled'],v['running'],v['loadError'])for v in instances if v['artifactSha256']==digest])
 for name,key in [(f'Eval account {letter}',f'fixture-upstream-{letter.lower()}')for letter in 'ABCDE']:
  result=client.api('/api/admin/accounts/import',{'provider':'openai','data':{'authentication_kind':'api_key','name':name,'base_url':'http://127.0.0.1:18381/v1','api_key':key,'transport':'http'}})
  print('Imported fixture:',name,'response fields',list(result))
 key=client.api('/api/admin/client-keys/create',{'name':'Eval client','groupIds':[],'maxConcurrency':2,'requestsPerMinute':0})
 snapshot=client.route('api/snapshot')[1]
 state={'instanceId':installed['defaultInstanceId'],'baselineSha256':digest,'accounts':snapshot['accounts'],'clientKeyId':key['id']}
 (WORK/'state.json').write_text(json.dumps(state,ensure_ascii=False,indent=2))
 status,models=client.route('api/models',{'clientKeyId':key['id']})
 print('Plugin bridge snapshot:',len(snapshot['accounts']),'accounts; models:',status,models)

 seed={'id':str(uuid.uuid4()),'accountId':state['accounts'][0]['account_id'],'clientKeyId':state['clientKeyId'],'model':'eval-candy','effort':'','kind':'candy'}
 assert client.route('api/run',seed)[0]==200
 state['baselineRecordId']=seed['id'];(WORK/'state.json').write_text(json.dumps(state))
