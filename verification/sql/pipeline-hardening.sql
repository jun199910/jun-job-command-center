begin;
alter table public.verifier_protocol enable row level security;
revoke insert,update,delete,truncate on public.verifier_protocol from anon,authenticated;
create policy verifier_protocol_read on public.verifier_protocol for select to anon,authenticated using(true);
alter function public.archive_closed_job_score() set search_path='';
alter function public.set_updated_at() set search_path='';
revoke all on function verification_private.content_key(jsonb,text) from public,anon,authenticated;
commit;
