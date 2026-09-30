// Discovery-side adapter. Input: JSON file with company_name, exact job_url,
// optional company_id, posting_title, source_facts, posting_instance_key.
// Main recommendation/score/notes are deliberately not accepted here.
const fs=require('node:fs'),path=require('node:path');
(async()=>{
 const input=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
 const config=JSON.parse(fs.readFileSync(process.argv[3]||path.join(__dirname,'../.verification-runtime/config.json'),'utf8'));
 const allowed=['company_id','company_name','job_url','posting_title','source_facts','posting_instance_key'];
 if(Object.keys(input).some(k=>!allowed.includes(k)))throw Error('Unsupported discovery field');
 const r=await fetch(config.url+'/rest/v1/rpc/verification_worker',{method:'POST',headers:{apikey:config.anonKey,'Content-Type':'application/json'},body:JSON.stringify({action:'record_posting',payload:input,worker_token:config.workerToken})});
 if(!r.ok)throw Error('Discovery failed: '+r.status+' '+await r.text());console.log(JSON.stringify(await r.json(),null,2));
})().catch(e=>{console.error(e.message);process.exitCode=1;});
