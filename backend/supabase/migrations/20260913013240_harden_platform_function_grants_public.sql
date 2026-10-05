-- anon and authenticated also inherit EXECUTE from PUBLIC, so the previous
-- revoke alone does not close the function.
do $$ begin
 if to_regprocedure('public.rls_auto_enable()') is not null then
  revoke execute on function public.rls_auto_enable() from public;
 end if;
end $$;
