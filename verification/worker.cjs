const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawn}=require('node:child_process');
const {randomUUID}=require('node:crypto');
const legacy=require('./blind-verifier.cjs');
const {blindTask,blindPrompt,comparePrompt,resultFor}=require('./pipeline.cjs');
const config=JSON.parse(fs.readFileSync(process.argv[2]||path.join(__dirname,'../.verification-runtime/config.json'),'utf8'));
const runtime=path.dirname(path.resolve(process.argv[2]||path.join(__dirname,'../.verification-runtime/config.json')));
fs.mkdirSync(path.join(runtime,'runs'),{recursive:true});
const log=(stage,data={})=>{const record=JSON.stringify({at:new Date().toISOString(),stage,...data});console.log(record);fs.appendFileSync(path.join(runtime,'worker.jsonl'),record+'\n');};
async function rpc(action,payload={}){
 const res=await fetch(config.url+'/rest/v1/rpc/verification_worker',{method:'POST',headers:{apikey:config.anonKey,'Content-Type':'application/json'},body:JSON.stringify({action,payload,worker_token:config.workerToken}),signal:AbortSignal.timeout(30000)});
 if(!res.ok)throw Error('RPC '+action+': '+res.status+' '+(await res.text()).slice(0,800));return res.json();
}
async function agent(prompt,web,dir,originalUrl){
 const empty=fs.mkdtempSync(path.join(os.tmpdir(),'jun-blind-'));
 const output=path.join(dir,web?'blind.json':'comparison.json');
 const schema=path.join(dir,web?'blind-schema.json':'comparison-schema.json');require('./schemas.cjs').write(schema,web);
 const args=['exec','--ignore-user-config','--ephemeral','--skip-git-repo-check','--sandbox','read-only','-C',empty,'-c','features.shell_tool=false','-c','features.apps=false','-c','features.hooks=false','-c','features.memories=false','-c','features.multi_agent=false','-c','features.remote_plugin=false','-c',`web_search="${web?'live':'disabled'}"`,'--json','--output-schema',schema,'-o',output,'-'];
 // Do not inherit project/thread pipes, MCP connections, database or worker credentials.
 const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>['PATH','Path','SystemRoot','WINDIR','TEMP','TMP','USERPROFILE','APPDATA','LOCALAPPDATA','HOMEDRIVE','HOMEPATH','PATHEXT','COMSPEC'].includes(k)));
 let threadId=null,trace='',stderr='';
 const child=spawn(config.codex||'codex',args,{env,windowsHide:true,stdio:['pipe','pipe','pipe'],cwd:empty});
 const timeout=setTimeout(()=>child.kill(),8*60*1000);
 child.stdout.on('data',b=>{trace+=b;});child.stderr.on('data',b=>{stderr+=b;});child.stdin.end(prompt);
 const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);}).finally(()=>clearTimeout(timeout));
 fs.writeFileSync(path.join(dir,web?'blind-trace.jsonl':'comparison-trace.jsonl'),trace);
 if(code!==0){
  const failures=trace.split('\n').map(l=>{try{return JSON.parse(l)}catch{return {}}}).filter(e=>e.type==='error'||e.type==='turn.failed').map(e=>e.message||e.error?.message||JSON.stringify(e));
  throw Error('Isolated Codex exited '+code+': '+(failures.join(' | ')||stderr||'No diagnostic emitted').slice(-800));
 }
 for(const line of trace.split('\n')){if(!line.trim())continue;let e;try{e=JSON.parse(line)}catch{continue}if(e.type==='thread.started')threadId=e.thread_id;if(['command_execution','mcp_tool_call'].includes(e.item?.type))throw Error('Forbidden tool in isolated context');}
 if(!threadId)throw Error('No isolated thread identity');
 const audit=await require('./source-audit.cjs').audit(trace,originalUrl);
 fs.writeFileSync(path.join(dir,web?'source-audit.json':'comparison-audit.json'),JSON.stringify(audit,null,2));
 const raw=fs.readFileSync(output,'utf8').trim().replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,'');
 return {report:JSON.parse(raw),threadId};
}
async function recoverBlind(job,dir){
 const root=path.join(runtime,'runs');
 for(const name of fs.readdirSync(root).filter(n=>n.startsWith(job.queue_id+'-')).reverse()){
  const prior=path.join(root,name);if(prior===dir)continue;
  try{
   const trace=fs.readFileSync(path.join(prior,'blind-trace.jsonl'),'utf8');
   const report=JSON.parse(fs.readFileSync(path.join(prior,'blind.json'),'utf8'));
   const threadId=trace.split('\n').map(l=>{try{return JSON.parse(l)}catch{return {}}}).find(e=>e.type==='thread.started')?.thread_id;
   legacy.seal(blindTask(job),report,threadId);
   const audit=await require('./source-audit.cjs').audit(trace,job.job_url);
   for(const file of ['blind-input.txt','blind-trace.jsonl','blind.json'])fs.copyFileSync(path.join(prior,file),path.join(dir,file));
   fs.writeFileSync(path.join(dir,'source-audit.json'),JSON.stringify(audit,null,2));
   log('recovered_blind_report',{queue_id:job.queue_id,thread_id:threadId});
   return {report,threadId};
  }catch{/* Invalid/incomplete attempts cannot be used; a fresh blind context will run. */}
 }
 return null;
}
let busy=false,pending=false,done=0,cooldownUntil=0;
async function drain(){
 if(Date.now()<cooldownUntil)return;
 if(busy){pending=true;return;}busy=true;
 try{
 do {pending=false;
  if(fs.existsSync(path.join(runtime,'stop-after-current'))){log('worker_stopped_after_current');process.exit(0);}
  if(config.maxJobs&&done>=config.maxJobs)break;
  const job=await rpc('claim',{include_archived:!!config.includeArchived,...(config.companyId?{company_id:config.companyId}:{}),...(config.queueIds?.length?{queue_id:config.queueIds[done]}:{})});
  if(!job)break;
  const claim={queue_id:job.queue_id,lease_id:job.lease_id};
  const dir=path.join(runtime,'runs',job.queue_id+'-'+randomUUID());fs.mkdirSync(dir);
  log('claimed',{queue_id:job.queue_id,company_name:job.company_name});
  const heartbeat=setInterval(()=>rpc('heartbeat',claim).catch(e=>log('heartbeat_error',{queue_id:job.queue_id,error:e.message})),60000);
  try{
   let report=job.first_report,reportHash=job.report_hash;
   if(!report){
    const input=blindPrompt(job);fs.writeFileSync(path.join(dir,'blind-input.txt'),input);
    const child=await recoverBlind(job,dir)||await agent(input,true,dir,job.job_url);report=child.report;
    legacy.seal(blindTask(job),report,child.threadId);
    const sealed=await rpc('seal',{...claim,report,agent_id:child.threadId});reportHash=sealed.report_hash;
    log('sealed',{queue_id:job.queue_id,thread_id:child.threadId,report_hash:reportHash,sealed_at:sealed.sealed_at});
   }
   const main=await rpc('main',claim);log('comparison_unlocked',{queue_id:job.queue_id});
   const compared=await agent(comparePrompt(report,main),false,dir);
   const comparison=compared.report;
   comparison.agent_id=compared.threadId;
   if(!Array.isArray(comparison.checks)||typeof comparison.summary!=='string')throw Error('Malformed comparison');
   const result=await rpc('finalize',{...claim,report_hash:reportHash,comparison});
   if(result.status!==resultFor(report,comparison))throw Error('Server/client result mismatch');
   fs.writeFileSync(path.join(dir,'result.json'),JSON.stringify(result,null,2));
   log('completed',{queue_id:job.queue_id,status:result.status,applied_to_current:result.applied_to_current});done++;
  }catch(e){log('job_error',{queue_id:job.queue_id,error:e.message});await rpc('error',{...claim,error:e.message}).catch(x=>log('error_save_failed',{error:x.message}));done++;
   if(/usage.limit|rate.limit|quota|authentication|unauthorized|token.expired|401|429/i.test(e.message)){cooldownUntil=Date.now()+30*60*1000;log('dispatcher_cooldown',{until:new Date(cooldownUntil).toISOString()});break;}
  }
  finally{clearInterval(heartbeat);}
 }while(!config.maxJobs||done<config.maxJobs);
 }catch(e){log('dispatcher_error',{error:e.message});}
 finally{busy=false;if(config.maxJobs&&done>=config.maxJobs){log('sample_batch_complete',{done});process.exit(0);}if(pending)setImmediate(drain);}
}
let socket,heartbeat;
function connect(){
 socket=new WebSocket(config.url.replace(/^http/,'ws')+'/realtime/v1/websocket?apikey='+encodeURIComponent(config.anonKey)+'&vsn=1.0.0');
 socket.onopen=()=>{socket.send(JSON.stringify({topic:'realtime:verification-events',event:'phx_join',payload:{config:{postgres_changes:[{event:'*',schema:'public',table:'companies'}]}},ref:'1'}));heartbeat=setInterval(()=>{if(socket.readyState===1)socket.send(JSON.stringify({topic:'phoenix',event:'heartbeat',payload:{},ref:String(Date.now())}));},25000);};
 socket.onmessage=e=>{const m=JSON.parse(e.data);if(m.event==='postgres_changes'){log('db_event');drain();}if(m.event==='phx_reply'&&m.ref==='1'){log('realtime_join',{status:m.payload?.status});drain();}};
 socket.onclose=()=>{clearInterval(heartbeat);log('realtime_disconnected');setTimeout(connect,5000);};socket.onerror=()=>{};
}
log('worker_started',{pid:process.pid,mode:config.maxJobs?'sample':'continuous'});if(!config.maxJobs)fs.writeFileSync(path.join(runtime,'worker.pid'),String(process.pid));
connect();drain();
// Recovery checks only pending event rows, never rechecks all companies or completed jobs.
setInterval(drain,60000);
