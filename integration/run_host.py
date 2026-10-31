"""启动本机隔离宿主、数据库与受控上游，退出时停止并清理自建资源。"""
from pathlib import Path
import http.server,threading,json,secrets,subprocess,os,time,urllib.request,signal,uuid,re,sys,argparse,tempfile,shutil,socket
ROOT=Path(__file__).resolve().parents[1]
parser=argparse.ArgumentParser(description='启动完全隔离的 CPR 插件业务验证环境，仅调用受控上游')
parser.add_argument('--cpr-dir',type=Path,required=True)
parser.add_argument('--postgres-bin',type=Path,required=True)
parser.add_argument('--redis-server',type=Path,required=True)
parser.add_argument('--library-dir',type=Path)
parser.add_argument('--upgrade-cpr-dir',type=Path)
args=parser.parse_args()
WORK=ROOT/'.runtime/integration';WORK.mkdir(parents=True,exist_ok=True)
CPR=args.cpr_dir.resolve()
RUNTIME=Path(tempfile.mkdtemp(prefix='cpr-eval-'));RUNTIME.chmod(0o755)
if (WORK/'stop').exists():(WORK/'stop').unlink()
signal.signal(signal.SIGTERM,lambda *_:sys.exit(0))
password='Eval9!'+secrets.token_hex(16)
pgbin=args.postgres_bin.resolve()
env=os.environ.copy()
if args.library_dir:env['LD_LIBRARY_PATH']=str(args.library_dir.resolve())
children=[]
control_written=False
def spawn(args,log,cwd=RUNTIME,as_nobody=False):
    if as_nobody and os.geteuid()==0:args=['runuser','-u','nobody','--',*map(str,args)]
    handle=open(RUNTIME/log,'ab')
    p=subprocess.Popen(list(map(str,args)),cwd=cwd,env=env,stdout=handle,stderr=subprocess.STDOUT,start_new_session=True)
    children.append(p);return p
def run(args,as_nobody=False):
    if as_nobody and os.geteuid()==0:args=['runuser','-u','nobody','--',*map(str,args)]
    p=subprocess.run(list(map(str,args)),cwd=RUNTIME,env=env,capture_output=True)
    if p.returncode:raise RuntimeError(p.stderr.decode(errors='replace')[-1500:])
    return p.stdout
def wait_url(url):
    for _ in range(480):
        if 'app' in globals() and app.poll() is not None:raise RuntimeError('CPR host exited during startup')
        try:
            if urllib.request.build_opener(urllib.request.ProxyHandler({})).open(url,timeout=1).status<300:return
        except Exception:time.sleep(.25)
    raise RuntimeError('Server did not become ready')
class Mock(http.server.BaseHTTPRequestHandler):
    calls=[];lock=threading.Lock();closed=0
    def log_message(self,*args):pass
    def do_GET(self):
        data=json.dumps({'object':'list','data':[{'id':n,'object':'model','owned_by':'fixture'}for n in ['eval-candy','eval-fp','eval-pelican','eval-error','eval-incomplete','eval-slow']]}).encode()
        self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Content-Length',len(data));self.end_headers();self.wfile.write(data)
    def do_POST(self):
        body=json.loads(self.rfile.read(int(self.headers.get('Content-Length',0))))
        model=body.get('model','')
        with self.lock:self.calls.append({'model':model,'authorization':self.headers.get('Authorization'),'body':body});index=len(self.calls)
        if model=='eval-error':
            data=json.dumps({'error':{'message':'Isolated fixture failure','type':'invalid_request_error','code':'fixture_error'}}).encode()
            self.send_response(400);self.send_header('Content-Type','application/json');self.send_header('Content-Length',len(data));self.end_headers();self.wfile.write(data);return
        text='21'
        if model=='eval-pelican':text='```html\n<svg xmlns="http://www.w3.org/2000/svg" width="360" height="200"><rect width="360" height="200" fill="#eef5ff"/><circle cx="90" cy="150" r="30" fill="none" stroke="#246"/><circle cx="240" cy="150" r="30" fill="none" stroke="#246"/><text x="90" y="70">Pelican test fixture</text></svg>\n```'
        if model=='eval-fp':
            fixtures=json.loads((ROOT/'backend/tests/fixtures/fingerprint.json').read_text())
            content=json.dumps(body,ensure_ascii=False)
            suite=json.loads((ROOT/'data/enrollment-suite.json').read_text())
            count=next((c['expected_count']for c in suite if c['prompt'] in content.replace('\\n','\n')),240)
            numbers=re.findall(r'\d+',fixtures[(index-1)%3]['text'])
            text=json.dumps((numbers*4)[:count])
        rid='resp_fixture_'+str(index);mid='msg_fixture_'+str(index)
        item={'id':mid,'type':'message','role':'assistant','status':'completed','content':[{'type':'output_text','text':text,'annotations':[]}]}
        response={'id':rid,'object':'response','status':'completed','model':model,'output':[item],'usage':{'input_tokens':20,'output_tokens':5,'total_tokens':25,'input_tokens_details':{'cached_tokens':0},'output_tokens_details':{'reasoning_tokens':0}}}
        events=[('response.created',{'response':dict(response,status='in_progress',output=[])}),('response.output_item.added',{'output_index':0,'item':dict(item,status='in_progress',content=[])}),('response.content_part.added',{'item_id':mid,'output_index':0,'content_index':0,'part':{'type':'output_text','text':'','annotations':[]}}),('response.output_text.delta',{'item_id':mid,'output_index':0,'content_index':0,'delta':text}),('response.output_text.done',{'item_id':mid,'output_index':0,'content_index':0,'text':text}),('response.output_item.done',{'output_index':0,'item':item})]
        if model!='eval-incomplete':events.append(('response.completed',{'response':response}))
        data=''.join('event: '+kind+'\ndata: '+json.dumps(dict(type=kind,**payload))+'\n\n'for kind,payload in events).encode()
        self.send_response(200);self.send_header('Content-Type','text/event-stream');self.send_header('Content-Length',len(data));self.end_headers()
        try:
            if model=='eval-slow':time.sleep(10)
            self.wfile.write(data)
        except (BrokenPipeError,ConnectionResetError):
            with self.lock:self.closed+=1
try:
    db=RUNTIME/'pg';db.mkdir();db.chmod(0o700)
    if os.geteuid()==0:os.chown(db,65534,65534)
    pw=RUNTIME/'pg.pass';pw.write_text(password);pw.chmod(0o600)
    if os.geteuid()==0:os.chown(pw,65534,65534)
    run([pgbin/'initdb','-D',db,'--username=cpr_eval','--pwfile='+str(pw),'--auth-host=scram-sha-256','--auth-local=trust','--no-locale','--encoding=UTF8'],True)
    spawn([pgbin/'postgres','-D',db,'-p','15432','-h','127.0.0.1','-k',db,'-c','shared_buffers=16MB','-c','max_connections=30'],'postgres.log',as_nobody=True)
    for _ in range(50):
        if subprocess.run([str(pgbin/'pg_isready'),'-h','127.0.0.1','-p','15432'],env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0:break
        time.sleep(.2)
    env['PGPASSWORD']=password
    run([pgbin/'createdb','-h','127.0.0.1','-p','15432','-U','cpr_eval','cpr_eval'])
    redis=spawn([args.redis_server.absolute(),'--bind','127.0.0.1','--port','16379','--requirepass',password,'--save','','--appendonly','no'],'redis.log')
    for _ in range(50):
        if redis.poll() is not None:raise RuntimeError((RUNTIME/'redis.log').read_text(errors='replace').replace(password,'[REDACTED]')[-1000:])
        try:
            with socket.create_connection(('127.0.0.1',16379),timeout=.5) as connection:
                connection.sendall(f'AUTH {password}\r\n'.encode())
                if connection.recv(64).startswith(b'+OK'):break
        except OSError:pass
        time.sleep(.1)
    else:raise RuntimeError('Test Redis did not become ready')
    deploy=RUNTIME/'deploy';deploy.mkdir()
    template=json.loads((ROOT/'integration/config-template.json').read_text())
    template['host']['listen']={'host':'127.0.0.1','port':18380}
    template['host']['runtime_data_dir']=str(RUNTIME/'data')
    template['host']['logging']['file']['enabled']=False
    template['store']['database']={'url':'postgres://cpr_eval@127.0.0.1:15432/cpr_eval','password':password}
    template['store']['redis']={'url':'redis://127.0.0.1:16379/','password':password}
    template['admin']['default_username']='eval-admin';template['admin']['default_password']=password
    template['api']['asset_directory']=str(CPR/'web/dist')
    (deploy/'config.yaml').write_text(json.dumps(template));(deploy/'config.yaml').chmod(0o600)
    upstream=http.server.ThreadingHTTPServer(('127.0.0.1',18381),Mock);upstream.daemon_threads=True
    threading.Thread(target=upstream.serve_forever,daemon=True).start()
    app=spawn([CPR/'codex-proxy-rs'],'app.log')
    try:wait_url('http://127.0.0.1:18380/healthz')
    except Exception:
        print((RUNTIME/'app.log').read_text(errors='replace')[-4500:]);raise
    control={'root':str(RUNTIME),'username':'eval-admin','password':password,'base':'http://127.0.0.1:18380'}
    (WORK/'control.json').write_text(json.dumps(control));(WORK/'control.json').chmod(0o600)
    control_written=True
    print('Isolated CPR host ready on 127.0.0.1:18380',flush=True)
    for _ in range(3600):
        if (WORK/'stop').exists():break
        if args.upgrade_cpr_dir and (WORK/'upgrade-host').exists():
            (WORK/'upgrade-host').unlink()
            os.killpg(app.pid,signal.SIGTERM);app.wait(timeout=15)
            upgraded=args.upgrade_cpr_dir.resolve()
            template['api']['asset_directory']=str(upgraded/'web/dist')
            (deploy/'config.yaml').write_text(json.dumps(template))
            app=spawn([upgraded/'codex-proxy-rs'],'app.log')
            wait_url('http://127.0.0.1:18380/healthz')
            (WORK/'host-upgraded').write_text('ready')
            print('Isolated CPR host upgraded with database preserved',flush=True)

        if app.poll() is not None:raise RuntimeError('CPR host exited')
        temporary=WORK/'upstream-observations.tmp'
        temporary.write_text(json.dumps({'models':[c['model']for c in Mock.calls],'closed':Mock.closed,'request_facts':[{'model':c['model'],'instructions_chars':len(c['body'].get('instructions','')),'input_items':len(c['body'].get('input',[])),'tools':len(c['body'].get('tools',[])),'tool_choice':c['body'].get('tool_choice')}for c in Mock.calls]}))
        temporary.replace(WORK/'upstream-observations.json')
        time.sleep(1)
finally:
    for child in reversed(children):
        if child.poll() is None:
            os.killpg(child.pid,signal.SIGTERM)
            try:child.wait(timeout=10)
            except subprocess.TimeoutExpired:os.killpg(child.pid,signal.SIGKILL)
    if control_written:(WORK/'control.json').unlink(missing_ok=True)
    shutil.rmtree(RUNTIME)
    print('Isolated host stopped; temporary database and credentials removed',flush=True)
