begin;
create schema if not exists verification_private;
revoke all on schema verification_private from public,anon,authenticated;
create table if not exists verification_private.worker_credentials(id text primary key, token_hash text not null, enabled boolean not null default true);
revoke all on verification_private.worker_credentials from public,anon,authenticated;
alter table verification_private.worker_credentials enable row level security;
alter table public.companies add column if not exists posting_source_facts jsonb;
alter table public.companies add column if not exists posting_instance_key text not null default '';
alter table public.companies add column if not exists independent_verification jsonb;
alter table public.companies add column if not exists is_reposting boolean not null default false;
alter table public.independent_verification_queue add column if not exists content_hash text not null default 'initial';
alter table public.independent_verification_queue add column if not exists trigger_reason text not null default 'backfill';
alter table public.independent_verification_queue add column if not exists priority integer not null default 4;
alter table public.independent_verification_queue add column if not exists attempts integer not null default 0;
alter table public.independent_verification_queue add column if not exists lease_id uuid;
alter table public.independent_verification_queue add column if not exists lease_until timestamptz;
alter table public.independent_verification_queue add column if not exists first_report jsonb;
alter table public.independent_verification_queue add column if not exists report_hash text;
alter table public.independent_verification_queue add column if not exists report_sealed_at timestamptz;
alter table public.independent_verification_queue add column if not exists compared_at timestamptz;
alter table public.independent_verification_queue add column if not exists comparison jsonb;
alter table public.independent_verification_queue add column if not exists agent_id text;
alter table public.independent_verification_queue add column if not exists last_error text;
alter table public.independent_verification_queue add column if not exists protocol_snapshot text;
alter table public.independent_verification_queue add column if not exists next_attempt_at timestamptz;
alter table public.independent_verification_queue drop constraint if exists independent_verification_queue_company_id_job_url_key;
create unique index if not exists verification_unique_content on public.independent_verification_queue(company_id,job_url,content_hash);
create index if not exists verification_pending_priority on public.independent_verification_queue(priority,created_at) where queue_status in ('대기','검증중');
alter table public.independent_verification_queue enable row level security;
revoke insert,update,delete on public.independent_verification_queue from anon,authenticated;

create or replace function verification_private.content_key(facts jsonb,instance text) returns text language sql immutable set search_path='' as $$
 select case when facts is null and coalesce(instance,'')='' then 'initial' else encode(extensions.digest(coalesce(facts::text,'null')||'|'||coalesce(instance,''),'sha256'),'hex') end
$$;
create or replace function verification_private.enqueue() returns trigger language plpgsql security definer set search_path='' as $$
declare h text; why text; state text; qid bigint; previous public.independent_verification_queue%rowtype;
begin
 if new.job_url is null or btrim(new.job_url)='' then return new; end if;
 if tg_op='UPDATE' and new.job_url is not distinct from old.job_url and new.posting_source_facts is not distinct from old.posting_source_facts and new.posting_instance_key is not distinct from old.posting_instance_key then return new; end if;
 -- Discovery continues even while the protocol/worker is paused; claiming requires an active protocol.
 h:=verification_private.content_key(new.posting_source_facts,new.posting_instance_key);
 why:=case when tg_op='INSERT' then 'new_posting' when new.job_url is distinct from old.job_url or new.posting_instance_key is distinct from old.posting_instance_key then 'reposting' else 'content_changed' end;
 insert into public.independent_verification_queue(company_id,company_name,job_url,content_hash,trigger_reason,priority)
 values(new.id,new.company_name,new.job_url,h,why,case when new.status in ('마감','제외','보관') then 5 when new.posting_deadline between current_date and current_date+3 then 1 when new.recommendation_score>=70 then 2 when new.status='신규후보' then 3 else 4 end)
 on conflict(company_id,job_url,content_hash) do nothing returning id into qid;
 if qid is not null then
   update public.companies set verification_status='독립검증 대기',independent_verification=jsonb_build_object('queue_id',qid,'job_url',new.job_url,'status','독립검증 대기','trigger_reason',why),is_reposting=(why='reposting') where id=new.id;
 else
   -- Reverting to a previously seen revision does not create another run; show that revision's state.
   select * into previous from public.independent_verification_queue where company_id=new.id and job_url=new.job_url and content_hash=h;
   state:=coalesce(previous.verifier_result,case when previous.queue_status='검증중' then '독립검증 중' when previous.queue_status='오류' and previous.attempts>=3 then '확인불가' else '독립검증 대기' end);
   update public.companies set verification_status=state,status=case when state in ('마감','마감확인') then '마감' else status end,
    independent_verification=jsonb_build_object('queue_id',previous.id,'job_url',new.job_url,'status',state,'verified_at',previous.verifier_completed_at,'confidence',previous.verifier_confidence,'summary',previous.comparison->>'summary','conflicts',(select coalesce(jsonb_agg(x),'[]') from jsonb_array_elements(coalesce(previous.comparison->'checks','[]')) x where x->>'outcome'='conflict'),'report_sealed_at',previous.report_sealed_at,'compared_at',previous.compared_at,'report_hash',previous.report_hash,'agent_id',previous.agent_id) where id=new.id;
 end if;
 return new;
end $$;
revoke all on function verification_private.enqueue() from public,anon,authenticated;
drop trigger if exists independent_posting_event on public.companies;
create trigger independent_posting_event after insert or update of job_url,posting_source_facts,posting_instance_key on public.companies for each row execute function verification_private.enqueue();

-- Single capability-gated RPC. The blind child never receives this credential.
create or replace function verification_private.worker(action text,payload jsonb,worker_token text) returns jsonb language plpgsql security definer set search_path='' as $$
declare q public.independent_verification_queue%rowtype; c0 public.companies%rowtype; p text; r jsonb; result text; lease uuid; summary jsonb; checks jsonb; required_fields text[]:=array['posting_status','posting_title','departments','recommended_department','entry_level','education','major','required_certificates','required_skills','location','deadline'];
begin
 if worker_token is null or not exists(select 1 from verification_private.worker_credentials where enabled and token_hash=encode(extensions.digest(worker_token,'sha256'),'hex')) then raise exception 'Unauthorized worker' using errcode='42501'; end if;
 if action='record_posting' then
   if nullif(btrim(payload->>'company_name'),'') is null or coalesce(payload->>'job_url','') !~ '^https?://' then raise exception 'Company name and exact URL required'; end if;
   if payload ? 'source_facts' and jsonb_typeof(payload->'source_facts') not in ('object','null') then raise exception 'Original source facts must be an object'; end if;
   if payload ? 'company_id' then select * into c0 from public.companies where id=(payload->>'company_id')::bigint for update;
   else
     if (select count(*) from public.companies where company_name=payload->>'company_name')>1 then raise exception 'Ambiguous company name: supply company_id'; end if;
     select * into c0 from public.companies where company_name=payload->>'company_name' for update;
   end if;
   if c0.id is null then
     if payload ? 'company_id' then raise exception 'Company ID not found'; end if;
     insert into public.companies(company_name,job_title,job_url,status,posting_source_facts,posting_instance_key)
     values(payload->>'company_name',coalesce(payload->>'posting_title','확인 필요'),payload->>'job_url','신규후보',nullif(payload->'source_facts','null'::jsonb),coalesce(payload->>'posting_instance_key','')) returning * into c0;
   else
     if c0.company_name<>payload->>'company_name' then raise exception 'Company identity mismatch'; end if;
     update public.companies set job_url=payload->>'job_url',
      posting_source_facts=case when payload ? 'source_facts' then nullif(payload->'source_facts','null'::jsonb) when job_url<>payload->>'job_url' then null else posting_source_facts end,
      posting_instance_key=case when payload ? 'posting_instance_key' then payload->>'posting_instance_key' when job_url<>payload->>'job_url' then '' else posting_instance_key end,
      status=case when status<>'제외' and job_url<>payload->>'job_url' then '신규후보' else status end where id=c0.id;
   end if;
   return (select jsonb_build_object('company_id',id,'job_url',job_url,'verification',independent_verification,'is_reposting',is_reposting) from public.companies where id=c0.id);
 end if;
 if action='claim' then
   select instructions into p from public.verifier_protocol where protocol_name='blind_job_posting_verifier_v1' and active order by id limit 1;
   if p is null then raise exception 'Protocol disabled'; end if;
   select v.* into q from public.independent_verification_queue v join public.companies c on c.id=v.company_id
   where (v.queue_status='대기' or (v.queue_status='검증중' and v.lease_until<now()) or (v.queue_status='오류' and v.next_attempt_at<=now())) and v.attempts<3
   and c.job_url=v.job_url and verification_private.content_key(c.posting_source_facts,c.posting_instance_key)=v.content_hash
   and (coalesce((payload->>'include_archived')::boolean,false) or c.status not in ('마감','제외','보관'))
   and (payload->>'queue_id' is null or v.id=(payload->>'queue_id')::bigint)
   and (payload->>'company_id' is null or v.company_id=(payload->>'company_id')::bigint)
   order by case when c.status in ('마감','제외','보관') then 5 when c.posting_deadline between current_date and current_date+3 then 1 when c.recommendation_score>=70 then 2 when c.status='신규후보' then 3 else 4 end,v.created_at,v.id for update of v skip locked limit 1;
   if not found then return null; end if;
   lease:=extensions.gen_random_uuid();
   update public.independent_verification_queue set queue_status='검증중',lease_id=lease,lease_until=now()+interval '20 minutes',attempts=attempts+1,protocol_snapshot=coalesce(protocol_snapshot,p) where id=q.id;
   update public.companies set verification_status='독립검증 중',independent_verification=coalesce(independent_verification,'{}')||jsonb_build_object('queue_id',q.id,'job_url',q.job_url,'status','독립검증 중') where id=q.company_id;
   return jsonb_build_object('queue_id',q.id,'lease_id',lease,'company_name',q.company_name,'job_url',q.job_url,'protocol',coalesce(q.protocol_snapshot,p),'first_report',q.first_report,'report_hash',q.report_hash,'agent_id',q.agent_id);
 end if;
 select * into q from public.independent_verification_queue where id=(payload->>'queue_id')::bigint for update;
 if not found or q.queue_status<>'검증중' or q.lease_id is distinct from (payload->>'lease_id')::uuid or q.lease_until<now() then raise exception 'Lease lost'; end if;
 if action='heartbeat' then update public.independent_verification_queue set lease_until=now()+interval '20 minutes' where id=q.id; return jsonb_build_object('ok',true); end if;
 if action='error' then
   update public.independent_verification_queue set queue_status='오류',last_error=left(payload->>'error',1000),lease_until=null,next_attempt_at=case when attempts<3 then now()+interval '5 minutes' else null end where id=q.id;
   update public.companies set verification_status=case when q.attempts<3 then '독립검증 대기' else '확인불가' end,independent_verification=coalesce(independent_verification,'{}')||jsonb_build_object('status',case when q.attempts<3 then '독립검증 대기' else '확인불가' end,'summary',case when q.attempts<3 then '실행 오류: 5분 후 자동 재시도 대기' else '검증 실행 오류: 재시도 한도 도달' end) where id=q.company_id and job_url=q.job_url and verification_private.content_key(posting_source_facts,posting_instance_key)=q.content_hash;
   return jsonb_build_object('ok',true);
 end if;
 if action='seal' then
   r:=payload->'report';
   if q.first_report is not null then raise exception 'First report immutable'; end if;
   if r->>'company_name' is distinct from q.company_name or r->>'job_url' is distinct from q.job_url or coalesce(r->>'access_status','') not in ('readable','unreadable') or coalesce(r->>'posting_status','') not in ('open','closed','unknown') or jsonb_typeof(r->'departments') is distinct from 'array' or jsonb_typeof(r->'evidence') is distinct from 'array' or coalesce(jsonb_array_length(r->'evidence'),0)=0 or nullif(payload->>'agent_id','') is null then raise exception 'Invalid blind report'; end if;
   update public.independent_verification_queue set first_report=r,report_hash=encode(extensions.digest(r::text,'sha256'),'hex'),report_sealed_at=now(),agent_id=payload->>'agent_id' where id=q.id returning * into q;
   return jsonb_build_object('report_hash',q.report_hash,'sealed_at',q.report_sealed_at);
 end if;
 if q.first_report is null or q.report_sealed_at is null or q.report_hash<>encode(extensions.digest(q.first_report::text,'sha256'),'hex') then raise exception 'First report must be sealed before comparison'; end if;
 if action='main' then
   select jsonb_build_object('job_title',c.job_title,'job_url',c.job_url,'location',c.location,'entry_level_ok',c.entry_level_ok,'license_requirement',c.license_requirement,'notes',c.notes,'verification_notes',c.verification_notes,'posting_deadline',c.posting_deadline,'posting_source_facts',c.posting_source_facts) into r from public.companies c where c.id=q.company_id and c.job_url=q.job_url and verification_private.content_key(c.posting_source_facts,c.posting_instance_key)=q.content_hash;
   if r is null then raise exception 'Superseded posting'; end if; return r;
 end if;
 if action<>'finalize' then raise exception 'Unknown action'; end if;
 if payload->>'report_hash' is distinct from q.report_hash then raise exception 'Report hash mismatch'; end if;
 checks:=payload->'comparison'->'checks';
 if jsonb_typeof(checks) is distinct from 'array' then raise exception 'Comparison checks required'; end if;
 if q.first_report->>'access_status'='unreadable' then result:='확인불가';
 elsif q.first_report->>'posting_status'='closed' then result:='마감확인';
 elsif exists(select 1 from jsonb_array_elements(checks)x where x->>'outcome'='conflict' and length(coalesce(x->>'evidence',''))>0) then result:='검증충돌';
 elsif q.first_report->>'posting_status'<>'open' or exists(select 1 from unnest(required_fields) f where not exists(select 1 from jsonb_array_elements(checks)x where x->>'field'=f and x->>'outcome'='match' and length(coalesce(x->>'evidence',''))>0)) or exists(select 1 from jsonb_array_elements(checks)x where x->>'outcome' is distinct from 'match') then result:='확인불가';
 elsif nullif(btrim(q.first_report->>'posting_title'),'') is null or nullif(btrim(q.first_report->>'deadline'),'') is null or (q.first_report->>'posting_title') ~* '확인불가|미확인|unknown' or (q.first_report->>'deadline') ~* '확인불가|미확인|unknown' or jsonb_array_length(q.first_report->'departments')=0 or exists(select 1 from jsonb_array_elements(q.first_report->'departments') d cross join unnest(array['name','duties','entry_level','education','major','required_certificates','required_skills','location']) k where nullif(btrim(d->>k),'') is null or (d->>k) ~* '확인불가|미확인|unknown') then result:='확인불가';
 else result:='독립검증 통과'; end if;
 summary:=jsonb_build_object('queue_id',q.id,'job_url',q.job_url,'status',result,'verified_at',now(),'confidence',null,'summary',payload->'comparison'->>'summary','conflicts',(select coalesce(jsonb_agg(x),'[]') from jsonb_array_elements(checks)x where x->>'outcome'='conflict'),'report_sealed_at',q.report_sealed_at,'compared_at',now(),'report_hash',q.report_hash,'agent_id',q.agent_id);
 update public.independent_verification_queue set queue_status='완료',verifier_result=result,verifier_confidence=null,comparison=payload->'comparison',compared_at=now(),verifier_completed_at=now(),lease_until=null,verifier_evidence=jsonb_build_object('protocol_name','blind_job_posting_verifier_v1','agent_id',q.agent_id,'first_report',q.first_report,'report_hash',q.report_hash,'report_sealed_at',q.report_sealed_at,'comparison',payload->'comparison','result',result)::text where id=q.id;
 update public.companies set verification_status=result,verification_confidence=null,last_verified_at=current_date,verified_posting_url=q.job_url,independent_verification=summary,status=case when result='마감확인' then '마감' else status end
 where id=q.company_id and job_url=q.job_url and verification_private.content_key(posting_source_facts,posting_instance_key)=q.content_hash;
 return summary||jsonb_build_object('applied_to_current',found);
end $$;
revoke all on function verification_private.worker(text,jsonb,text) from public;
grant usage on schema verification_private to anon,authenticated;
grant execute on function verification_private.worker(text,jsonb,text) to anon,authenticated;
create or replace function public.verification_worker(action text,payload jsonb,worker_token text) returns jsonb language sql security invoker set search_path='' as $$
 select verification_private.worker(action,payload,worker_token)
$$;
revoke all on function public.verification_worker(text,jsonb,text) from public;
grant execute on function public.verification_worker(text,jsonb,text) to anon,authenticated;

-- Preserve existing completed reports, including the original Lifac run. Never requeue them.
insert into public.independent_verification_queue(company_id,company_name,job_url,content_hash,trigger_reason,priority)
select id,company_name,job_url,verification_private.content_key(posting_source_facts,posting_instance_key),'backfill',case when status in ('마감','제외','보관') then 5 when posting_deadline between current_date and current_date+3 then 1 when recommendation_score>=70 then 2 when status='신규후보' then 3 else 4 end from public.companies where nullif(btrim(job_url),'') is not null on conflict(company_id,job_url,content_hash) do nothing;
update public.companies c set verification_status='독립검증 대기',independent_verification=jsonb_build_object('queue_id',q.id,'job_url',q.job_url,'status','독립검증 대기') from public.independent_verification_queue q where q.company_id=c.id and q.job_url=c.job_url and q.content_hash=verification_private.content_key(c.posting_source_facts,c.posting_instance_key) and q.queue_status='대기' and c.status not in ('마감','제외','보관');
do $$ begin if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='companies') then alter publication supabase_realtime add table public.companies; end if; end $$;
notify pgrst,'reload schema';
commit;
