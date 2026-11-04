alter table public.ledger_accounts add column revision integer not null default 0 check(revision>=0);
create function private.ledger_account_revision() returns trigger language plpgsql set search_path='' as $$
begin
 new.revision:=old.revision+case when row(new.name,new.parent,new.bucket,new.nature,new.postable,new.active)
  is distinct from row(old.name,old.parent,old.bucket,old.nature,old.postable,old.active) then 1 else 0 end;
 return new;
end $$;
revoke all on function private.ledger_account_revision() from public,anon,authenticated;
create trigger ledger_account_revision before update on public.ledger_accounts for each row execute function private.ledger_account_revision();

create table private.ledger_account_changes (
 id uuid primary key default gen_random_uuid(), account_code text not null references public.ledger_accounts(code),
 action text not null check(action in ('create','rename','activate','deactivate')),
 before_snapshot jsonb, after_snapshot jsonb not null,
 actor_id uuid not null references private.business_actors(id),actor_name text not null,
 created_at timestamptz not null default now(),request_id uuid not null unique,request_payload jsonb not null
);
create index ledger_account_changes_account on private.ledger_account_changes(account_code);
create index ledger_account_changes_actor on private.ledger_account_changes(actor_id);
alter table private.ledger_account_changes enable row level security;
revoke all on private.ledger_account_changes from public,anon,authenticated;
create trigger prevent_retired_operation before insert on private.ledger_account_changes for each row
 execute function private.prevent_retired_operation('ledger-account-change','actor_id','request_id');

-- Cuentas usadas por las funciones de ventas, pagos, inventario, gastos e
-- importación. También se protegen sus cuentas mayores para no romper el árbol.
create function private.ledger_account_restriction(p_code text) returns text
language plpgsql stable security invoker set search_path='' as $$
declare a public.ledger_accounts%rowtype; protected boolean;
begin
 select * into a from public.ledger_accounts where code=p_code;
 if not found then return 'La cuenta ya no existe.'; end if;
 if p_code='4120' then return 'Cuenta retirada. Los envíos facturados se registran en 2117.'; end if;
 if a.active then
  with recursive required(code,parent) as (
   select code,parent from public.ledger_accounts where code=any(array[
    '1110-001','1110-002','1120-000','1120-001','1120-002','1120-003','1120-004','1120-005','1120-006',
    '1130','1140','1142','1210','1340','2111','2112','2113','2116','2117','3110-001','4110','4190','5120',
    '5130-001','5130-002','5130-003','5130-004','5130-005','5130-006','5130-007','5130-008','5130-009','5130-010','5130-011',
    '5140-001','5140-002','5150','6000'])
   union select p.code,p.parent from public.ledger_accounts p join required r on r.parent=p.code
  ) select exists(select 1 from required where code=p_code) into protected;
  if protected then return 'Cuenta necesaria para las operaciones del sistema.'; end if;
  if exists(select 1 from public.ledger_accounts where parent=p_code and active) then return 'Desactiva primero las subcuentas activas.'; end if;
 elsif a.parent is not null and not exists(select 1 from public.ledger_accounts where code=a.parent and active) then
  return 'Activa primero la cuenta mayor '||a.parent||'.';
 end if;
 return null;
end $$;
revoke all on function private.ledger_account_restriction(text) from public,anon,authenticated;

create function private.ledger_accounts_list() returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if auth.uid() is null or private.staff_role() is distinct from 'admin' then raise insufficient_privilege; end if;
 return (select coalesce(jsonb_agg(to_jsonb(a)||jsonb_build_object('restriction',private.ledger_account_restriction(a.code)) order by a.code),'[]') from public.ledger_accounts a);
end $$;
revoke all on function private.ledger_accounts_list() from public,anon;
grant execute on function private.ledger_accounts_list() to authenticated;
create function public.ledger_accounts_list() returns jsonb language sql stable security invoker set search_path='' as $$select private.ledger_accounts_list();$$;
revoke all on function public.ledger_accounts_list() from public,anon;
grant execute on function public.ledger_accounts_list() to authenticated;

create function private.change_ledger_account(p_input jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare a public.ledger_accounts%rowtype; p public.ledger_accounts%rowtype; saved private.ledger_account_changes%rowtype;
 v_code text:=btrim(p_input->>'code'); v_action text:=p_input->>'action'; v_name text:=btrim(p_input->>'name');
 v_request uuid:=(p_input->>'requestId')::uuid; v_before jsonb; v_after jsonb; v_restriction text;
begin
 if auth.uid() is null or private.staff_role() is distinct from 'admin' then raise insufficient_privilege; end if;
 if v_request is null then raise exception 'Falta identificar la solicitud.'; end if;
 perform pg_advisory_xact_lock(hashtextextended('lcp-business-day',0));
 perform pg_advisory_xact_lock(hashtextextended('ledger-accounts',0));
 select * into saved from private.ledger_account_changes where request_id=v_request;
 if found then
  if saved.actor_id<>auth.uid() or saved.request_payload<>p_input then raise exception 'La solicitud de la cuenta cambió.'; end if;
  return saved.after_snapshot;
 end if;
 if v_action is null or v_action not in ('create','rename','activate','deactivate') or v_code is null or v_code !~ '^[1-6][0-9]{3}(-[0-9]{3}){0,3}$' then
  raise exception 'Revisa el código y la operación de la cuenta.';
 end if;
 if v_action in ('create','rename') and length(coalesce(v_name,'')) not between 1 and 160 then raise exception 'Escribe un nombre de entre 1 y 160 caracteres.'; end if;
 select * into a from public.ledger_accounts where code=v_code for update;
 if v_action='create' then
  if found then raise exception 'Ese código ya está registrado. Usa otro código o reactiva la cuenta existente.'; end if;
  select * into p from public.ledger_accounts where code=p_input->>'parent' and active for update;
  if not found or left(v_code,1)<>left(p.code,1) then raise exception 'Selecciona una cuenta mayor activa del mismo tipo.'; end if;
  insert into public.ledger_accounts(code,name,parent,bucket,nature) values(v_code,v_name,p.code,p.bucket,p.nature) returning * into a;
 else
  if not found then raise exception 'La cuenta ya no existe. Actualiza la lista.'; end if;
  if not(p_input ? 'expectedRevision') or private.accounting_number(p_input,'expectedRevision',1000000000,0)<>a.revision then
   raise exception 'La cuenta cambió desde que abriste la lista. Actualiza antes de guardar.';
  end if;
  v_before:=to_jsonb(a);
  if v_action='rename' then
   if v_name=a.name then raise exception 'No hay cambios para guardar.'; end if;
   update public.ledger_accounts set name=v_name where code=v_code returning * into a;
  else
   if a.active=(v_action='activate') then raise exception 'La cuenta ya tiene ese estado. Actualiza la lista.'; end if;
   v_restriction:=private.ledger_account_restriction(v_code);
   if v_restriction is not null then raise exception '%',v_restriction; end if;
   update public.ledger_accounts set active=(v_action='activate') where code=v_code returning * into a;
  end if;
 end if;
 v_after:=to_jsonb(a);
 insert into private.ledger_account_changes(account_code,action,before_snapshot,after_snapshot,actor_id,actor_name,request_id,request_payload)
 values(v_code,v_action,v_before,v_after,auth.uid(),coalesce((select display_name from private.business_actors where id=auth.uid()),'Administración'),v_request,p_input);
 return v_after;
end $$;
revoke all on function private.change_ledger_account(jsonb) from public,anon;
grant execute on function private.change_ledger_account(jsonb) to authenticated;
create function public.change_ledger_account(p_input jsonb) returns jsonb language sql security invoker set search_path='' as $$select private.change_ledger_account(p_input);$$;
revoke all on function public.change_ledger_account(jsonb) from public,anon;
grant execute on function public.change_ledger_account(jsonb) to authenticated;

-- Mantener compatibles las importaciones existentes: no crear subcuentas en
-- una cuenta mayor inactiva, y compartir el bloqueo con la nueva administración.
do $legacy$ declare s text; begin
 s:=pg_get_functiondef('private.save_ledger_account(jsonb)'::regprocedure);
 s:=regexp_replace(s,E'begin\\s*',E'begin\n perform pg_advisory_xact_lock(hashtextextended(''lcp-business-day'',0));\n perform pg_advisory_xact_lock(hashtextextended(''ledger-accounts'',0));\n');
 if position('and not postable' in s)=0 then raise exception 'Revisar la importación de cuentas.'; end if;
 s:=replace(s,'and not postable','and not postable and active');
 execute s;
 s:=pg_get_functiondef('private.operation_confirmation(text,uuid,boolean)'::regprocedure);
 if position('''invoice-correction'') then' in s)=0 then raise exception 'Revisar la recuperación de cuentas.'; end if;
 s:=replace(s,'''invoice-correction'') then','''invoice-correction'',''ledger-account-change'') then');
 s:=replace(s,'when ''journal'' then','when ''ledger-account-change'' then v_table:=''private.ledger_account_changes'';v_actor:=''actor_id''; when ''journal'' then');
 execute s;
end $legacy$;
notify pgrst,'reload schema';
