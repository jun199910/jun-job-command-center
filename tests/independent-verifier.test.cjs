const {test}=require('node:test');
const assert=require('node:assert/strict');
const v=require('../verification/blind-verifier.cjs');
const task=()=>v.prepare({protocol_name:v.PROTOCOL,active:true,instructions:'원공고만 읽기'},{id:1,queue_status:'대기',company_name:'회사',job_url:'https://example.com/?id=1',notes:'secret',recommendation_score:99,company_id:4});
const report=()=>({company_name:'회사',job_url:'https://example.com/?id=1',access_status:'readable',checked_at:'2026-09-29T00:00:00Z',posting_status:'open',deadline:'상시채용',departments:[{name:'직무',duties:'업무',entry_level:true,education_major:'학력',required:[],preferred:[],location:'서울'}],unknowns:[],evidence:['원공고 근거']});
test('blind input contains only company and exact URL',()=>{
 const t=task();assert.deepEqual(Object.keys(t.input),['company_name','job_url']);assert.equal(t.agent_options.fork_turns,'none');assert.ok(!JSON.stringify(t).includes('secret'));
 assert.throws(()=>v.prepare({protocol_name:v.PROTOCOL,active:false},{}));
});
test('cannot compare or finalize before a separate-agent sealed report',()=>{
 assert.throws(()=>v.comparisonSQL({}));assert.throws(()=>v.seal(task(),report(),'/root'));
 const s=v.seal(task(),report(),'/root/blind');s.first_report.posting_status='closed';assert.throws(()=>v.comparisonSQL(s));
 assert.throws(()=>v.seal(task(),{...report(),job_url:'https://other.com'},'/root/blind'));
});
test('fail closed for unreadable, missing facts, and missing comparison',()=>{
 for(const change of [{access_status:'unreadable'},{posting_status:'unknown'},{unknowns:['마감일']}]){
 const s=v.seal(task(),{...report(),...change},'/root/blind');assert.equal(v.conclude(s,null).result,'확인불가');}
 const s=v.seal(task(),{...report(),posting_status:'closed'},'/root/blind');assert.equal(v.conclude(s,null).result,'마감');
});
test('results preserve report, exact-source comparison, conditional writes',()=>{
 const s=v.seal(task(),report(),'/root/blind');
 const compare={source_url:s.input.job_url,checks:['job_title','entry_level_ok','license_requirement','location'].map(main_field=>({main_field,main_value:'원본값',outcome:'match',evidence:'원공고 근거'}))};
 assert.equal(v.conclude(s,compare).result,'독립검증 통과');
 compare.checks[0].outcome='conflict';const final=v.conclude(s,compare);assert.equal(final.result,'검증충돌');
 const query=v.finalizeSQL(s,final);assert.ok(query.includes("queue_status='검증중'"));assert.ok(!query.includes('update public.companies'));assert.ok(query.includes('verifier_confidence=null'));
 assert.throws(()=>v.finalizeSQL(s,{...final,result:'독립검증 통과'}));
});
