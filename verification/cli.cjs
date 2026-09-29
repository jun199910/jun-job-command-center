// JSON in/out, for the coordinator only. Emits SQL; never executes it automatically.
// node verification/cli.cjs prepare|seal|compare-sql|finalize-sql < coordinator-input.json
const fs=require('node:fs');
const v=require('./blind-verifier.cjs');
try {
 const input=JSON.parse(fs.readFileSync(0,'utf8'));
 let output;
 switch(process.argv[2]) {
 case 'prepare': output=v.prepare(input.protocol,input.queue);break;
 case 'seal': {
   const sealed=v.seal(input.task,input.report,input.agent_id);
   output={sealed,sql:v.sealSQL(sealed,input.previous_evidence)};break;
 }
 case 'compare-sql': output={sql:v.comparisonSQL(input.sealed)};break;
 case 'finalize-sql': {
   const final=v.conclude(input.sealed,input.comparison);
   output={final,sql:v.finalizeSQL(input.sealed,final)};break;
 }
 default: throw Error('Use prepare, seal, compare-sql, or finalize-sql');
 }
 process.stdout.write(JSON.stringify(output,null,2)+'\n');
} catch(error) { console.error(error.message);process.exitCode=1; }
