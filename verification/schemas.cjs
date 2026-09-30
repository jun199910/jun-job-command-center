const fs=require('node:fs');
const nullable={type:['string','null']}, text={type:'string'},strings={type:'array',items:text};
const object=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const department=object(Object.fromEntries(['name','duties','entry_level','education','major','education_major','required_certificates','preferred_certificates','required_skills','preferred_skills','required','preferred','location','restrictions'].map(k=>[k,nullable])));
const blind=object({company_name:text,job_url:text,access_status:{type:'string',enum:['readable','unreadable']},checked_at:text,posting_status:{type:'string',enum:['open','closed','unknown']},posting_title:nullable,deadline:nullable,departments:{type:'array',items:department},unknowns:strings,evidence:{type:'array',minItems:1,items:object({url:text,location:text,excerpt:text})},limitations:strings});
const comparison=object({checks:{type:'array',items:object({field:text,outcome:{type:'string',enum:['match','conflict','unknown']},main_value:nullable,independent_value:nullable,evidence:text})},summary:text});
function write(file,isBlind){fs.writeFileSync(file,JSON.stringify(isBlind?blind:comparison));}
module.exports={write,blind,comparison};
