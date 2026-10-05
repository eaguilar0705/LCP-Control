-- The platform's RLS event-trigger helper is exposed through PostgREST by
-- default. It is only meaningful inside an event trigger, so no API client
-- should reach it. The `ensure_rls` event trigger keeps working: PostgreSQL
-- does not check EXECUTE privileges when it fires one.
do $$ begin
 if to_regprocedure('public.rls_auto_enable()') is not null then
  revoke execute on function public.rls_auto_enable() from anon, authenticated;
 end if;
end $$;
