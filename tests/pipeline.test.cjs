const {test}=require('node:test'),assert=require('node:assert/strict');
const {blindPrompt,blindTask,resultFor,fields}=require('../verification/pipeline.cjs');
const {audit}=require('../verification/source-audit.cjs');
test('blind prompt whitelist excludes all coordinator/main attributes',()=>{
 const job={queue_id:7,company_name:'회사',job_url:'https://example.com/job/7',protocol:'원공고만 확인',notes:'SECRET_MAIN',job_title:'SECRET_MAIN',score:'SECRET_MAIN',career_value:'SECRET_MAIN',first_report:'SECRET_MAIN'};
 assert.deepEqual(Object.keys(blindTask(job).input),['company_name','job_url']);
 assert.ok(!blindPrompt(job).includes('SECRET_MAIN'));
});
test('objective conflict cases cannot become a pass',()=>{
 const report={access_status:'readable',posting_status:'open',posting_title:'개발',deadline:'상시모집',departments:[{name:'개발',duties:'개발',entry_level:'가능',education:'무관',major:'무관',required_certificates:'명시 없음',required_skills:'명시 없음',location:'서울'}]};
 const checks=fields.map(field=>({field,outcome:'match',evidence:'원공고 사실'}));
 assert.equal(resultFor(report,{checks}),'독립검증 통과');
 assert.equal(resultFor({...report,departments:[]},{checks}),'확인불가');
 assert.equal(resultFor({...report,deadline:null},{checks}),'확인불가');
 for(const field of ['entry_level','required_certificates','recommended_department','required_skills','education','major','location']){
  assert.equal(resultFor(report,{checks:checks.map(c=>c.field===field?{...c,outcome:'conflict'}:c)}),'검증충돌');
 }
 assert.equal(resultFor({...report,posting_status:'closed'},{checks}),'마감확인');
 assert.equal(resultFor({...report,access_status:'unreadable'},{checks}),'확인불가');
 assert.equal(resultFor(report,{checks:checks.slice(1)}),'확인불가');
});
const event=(type,action)=>JSON.stringify({type:'item.completed',item:{type,action,results:[]}})+'\n';
test('source audit rejects search, other postings, shell, and comparator browsing',async()=>{
 const original='https://example.com/job/7';
 const trace=event('web_search',{type:'open_page',url:original});
 assert.equal((await audit(trace,original)).source_audit,'passed');
 await assert.rejects(audit(trace+event('web_search',{type:'search',query:'company'}),original));
 await assert.rejects(audit(trace+event('command_execution',{}),original));
 await assert.rejects(audit(trace,undefined));
 await assert.rejects(audit(trace+event('web_search',{type:'open_page',url:'https://example.com/job/8'}),original,async()=>({ok:true,text:async()=>'<html></html>'})));
 const image='https://img.example.com/original.jpg';
 assert.equal((await audit(trace+event('web_search',{type:'open_page',url:image}),original,async()=>({ok:true,text:async()=>`<img src="${image}">`}))).embedded_urls[0],image);
});
