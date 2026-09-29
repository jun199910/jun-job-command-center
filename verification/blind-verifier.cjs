// Coordinator-only helpers. Never send this workspace or a queue row to the blind agent.
const { createHash, randomUUID } = require('node:crypto');
const PROTOCOL = 'blind_job_posting_verifier_v1';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sql = value => "'" + String(value).replace(/'/g, "''") + "'";
const identifier = value => { if (!/^\d+$/.test(String(value))) throw Error('Invalid queue ID'); return String(value); };
function prepare(protocol, queue) {
  if (protocol.protocol_name !== PROTOCOL || protocol.active !== true) throw Error('Active protocol required');
  if (!['대기','검증중'].includes(queue.queue_status)) throw Error('Queue not available');
  if (!queue.company_name || !queue.job_url || !/^https?:\/\//.test(queue.job_url)) throw Error('Exact source required');
  return {
    protocol_name: PROTOCOL, protocol_instructions: protocol.instructions,
    run_id: randomUUID(), queue_id: identifier(queue.id),
    // Whitelist, never spread queue/company fields into the agent input.
    input: { company_name: queue.company_name, job_url: queue.job_url },
    agent_options: { fork_turns: 'none' }
  };
}
function seal(task, report, agentId) {
  if (!agentId || agentId === '/root') throw Error('Separate agent required');
  if (report.company_name !== task.input.company_name || report.job_url !== task.input.job_url) throw Error('Source mismatch');
  if (!['readable','unreadable'].includes(report.access_status)) throw Error('Access status required');
  if (!['open','closed','unknown'].includes(report.posting_status)) throw Error('Posting status required');
  if (!report.checked_at || !Number.isFinite(Date.parse(report.checked_at))) throw Error('Check time required');
  if (!Array.isArray(report.departments) || !Array.isArray(report.unknowns) || !Array.isArray(report.evidence) || !report.evidence.length) throw Error('Structured evidence required');
  const record = { version:1, protocol_name:PROTOCOL, run_id:task.run_id, queue_id:task.queue_id,
    input:task.input, protocol_instructions:task.protocol_instructions, agent_id:agentId,
    isolation:'separate-agent/no-history', phase:'first_report_finalized',
    first_report:report, first_report_sha256:hash(report), sealed_at:new Date().toISOString() };
  return JSON.parse(JSON.stringify(record));
}
function assertSealed(record) {
  if (record.phase !== 'first_report_finalized' || hash(record.first_report) !== record.first_report_sha256) throw Error('Unsealed or modified first report');
}
function sealSQL(record, previousEvidence) {
  assertSealed(record);
  return `update public.independent_verification_queue set verifier_evidence=${sql(JSON.stringify(record))} where id=${identifier(record.queue_id)} and queue_status='검증중' and company_name=${sql(record.input.company_name)} and job_url=${sql(record.input.job_url)} and verifier_evidence is not distinct from ${previousEvidence == null?'null':sql(previousEvidence)} returning id,queue_status,verifier_evidence;`;
}
function comparisonSQL(record) {
  assertSealed(record);
  // Main analysis becomes available only after this exact first report is persisted.
  return `select c.* from public.companies c join public.independent_verification_queue q on q.company_id=c.id where q.id=${identifier(record.queue_id)} and q.queue_status='검증중' and q.verifier_evidence=${sql(JSON.stringify(record))};`;
}
function conclude(record, comparison) {
  assertSealed(record);
  const r=record.first_report;
  let result;
  if (r.access_status==='unreadable') result='확인불가';
  else if (r.posting_status==='closed') result='마감';
  else if (!comparison || comparison.source_url!==record.input.job_url || !Array.isArray(comparison.checks) || !comparison.checks.length) result='확인불가';
  else if (comparison.checks.some(c=>c.outcome==='conflict' && c.evidence)) result='검증충돌';
  else if (r.posting_status!=='open' || r.unknowns.length || !r.deadline || !r.departments.length || r.departments.some(d=>['name','duties','entry_level','education_major','required','preferred','location'].some(k=>d[k]===undefined||d[k]===null)) || ['job_title','entry_level_ok','license_requirement','location'].some(field=>!comparison.checks.some(c=>c.main_field===field)) || comparison.checks.some(c=>c.outcome!=='match' || !c.evidence || !c.main_field)) result='확인불가';
  else result='독립검증 통과';
  return { ...record, phase:'compared', comparison:comparison||null, result, compared_at:new Date().toISOString() };
}
function finalizeSQL(sealed, final) {
  assertSealed(sealed);
  const expected=conclude(sealed,final.comparison);
  if (final.phase!=='compared' || final.run_id!==sealed.run_id || final.first_report_sha256!==sealed.first_report_sha256 || hash(final.first_report)!==sealed.first_report_sha256 || final.result!==expected.result) throw Error('Invalid comparison');
  // Exact-match CAS prevents another run from being silently overwritten. No companies update.
  return `update public.independent_verification_queue set queue_status='완료',verifier_result=${sql(final.result)},verifier_confidence=null,verifier_evidence=${sql(JSON.stringify(final))},verifier_completed_at=now() where id=${identifier(sealed.queue_id)} and queue_status='검증중' and verifier_evidence=${sql(JSON.stringify(sealed))} returning id,company_id,company_name,job_url,queue_status,verifier_result,verifier_confidence,verifier_completed_at;`;
}
module.exports={PROTOCOL,prepare,seal,sealSQL,comparisonSQL,conclude,finalizeSQL};
