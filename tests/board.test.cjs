const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../index.html'), 'utf8');
const script = source.match(/<script>([\s\S]*?)<\/script>/)[1];
function app(data = []) {
  const elements = Object.fromEntries(['q','status','tierFilter','refresh','rows','sync','logs','mAll','mTop','mApply','mVerify'].map(id => [id, { value:'', textContent:'', innerHTML:'', querySelectorAll:()=>[] }]));
  const calls = [];
  const context = vm.createContext({ ...elements, document:{getElementById:id=>elements[id]}, setInterval:()=>{}, fetch:async url=>{calls.push(url);return {ok:true,json:async()=>url.includes('activity_log')?[]:data}} });
  vm.runInContext(script, context);
  return {elements,calls,run:code=>vm.runInContext(code,context)};
}
test('tags use explicit evidence, never SCADA substring or missing data, at most four',()=>{
  const a=app();
  assert.equal(a.run('companyTags({}).length'),0);
  assert.equal(a.run("companyTags({verification_notes:'SCADA 공고 확인'}).length"),0);
  assert.equal(a.run("companyTags({notes:'운전 필수 아님'}).length"),0);
  assert.equal(a.run("companyTags({notes:'AutoCAD 필수 여부 확인 필요'})[0].label"),'⚠ CAD확인');
  assert.equal(a.run("companyTags({license_requirement:'전기기사 필수 아님 / 운전면허 필수',verification_notes:'운전가능 필수.',job_title:'ESS',entry_level_ok:true,career_value:'높음',commute_grade:'양호'}).length"),4);
});
test('full analysis preserves every field including future fields and escapes markup',()=>{
  const a=app();
  const result=a.run("analysisHTML({notes:'<script>alert(1)</script>',expected_career_path:'첫 단계 → 다음 단계',career_value_2y3y:'높음',extra_field:{detail:'추가 원문'},transfers:0,entry_level_ok:false,commute_minutes:null})");
  assert.ok(result.includes('&lt;script&gt;'));
  assert.ok(result.includes('추가 원문'));
  assert.ok(result.includes('첫 단계 → 다음 단계'));
  assert.ok(result.includes('<dd>0</dd>'));
  assert.ok(result.includes('<dd>아니오</dd>'));
  assert.ok(result.includes('확인 필요'));
  assert.equal(a.run('summaryCards({}).match(/class="summary-card"/g).length'),6);
  assert.ok(a.run('commuteText({walking_minutes:0,transfers:0,commute_minutes:0})').includes('도보 0분'));
});
test('50 candidates, filters, tiers, metrics and all link destinations survive rendering',async()=>{
  const data=Array.from({length:50},(_,i)=>({id:i,company_name:'회사'+i,job_title:'ESS 연구원',recommendation_score:95-i,status:i===0?'제외':i===1?'지원예정':'신규후보',entry_level_ok:true,job_url:'https://example.com/job?x=1&y=2',map_url:'https://example.com/map',route_url:'https://example.com/route',verification_status:'통과'}));
  const a=app(data); await a.run('load()');
  assert.equal((a.elements.rows.innerHTML.match(/data-company=/g)||[]).length,50);
  assert.equal(a.elements.mAll.textContent,49);
  assert.equal(a.elements.mApply.textContent,1);
  assert.equal(a.elements.mVerify.textContent,0);
  for(const url of ['https://example.com/job?x=1&amp;y=2','https://example.com/map','https://example.com/route'])assert.ok(a.elements.rows.innerHTML.includes(url));
  assert.ok(a.elements.rows.innerHTML.includes('95 (X)'));
  assert.ok(!a.elements.rows.innerHTML.includes('class="analysis-section"'));
  a.elements.status.value='제외';a.run('render()');assert.equal((a.elements.rows.innerHTML.match(/data-company=/g)||[]).length,1);
  a.elements.tierFilter.value='A';a.run('render()');assert.ok(a.elements.rows.innerHTML.includes('조건에 맞는 회사가 없습니다.'));
  a.elements.status.value='';a.elements.tierFilter.value='';a.elements.q.value='회사49';a.run('render()');assert.equal((a.elements.rows.innerHTML.match(/data-company=/g)||[]).length,1);
  assert.ok(a.calls.some(url=>url.endsWith('companies?select=*&order=recommendation_score.desc.nullslast')));
  assert.ok(a.calls.some(url=>url.endsWith('activity_log?select=*&order=created_at.desc&limit=20')));
  assert.equal(typeof a.elements.refresh.onclick,'function');
  assert.equal(typeof a.elements.status.onchange,'function');
});
