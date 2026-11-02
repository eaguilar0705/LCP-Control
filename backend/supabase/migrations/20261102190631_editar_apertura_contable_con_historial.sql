-- La apertura conserva su número, fecha y moneda. Cada edición guarda ambas
-- versiones y no representa un movimiento de efectivo de la jornada.
alter table public.journal_entries add column revision integer not null default 0 check(revision>=0);
create table private.opening_journal_corrections (
 id uuid primary key default gen_random_uuid(),
 entry_id uuid not null references public.journal_entries(id),
 revision integer not null check(revision>0),
 before_snapshot jsonb not null, after_snapshot jsonb not null,
 actor_id uuid not null references private.business_actors(id), actor_name text not null,
 created_at timestamptz not null default now(),
 request_id uuid not null unique, request_payload jsonb not null,
 unique(entry_id,revision)
);
create index opening_journal_corrections_actor on private.opening_journal_corrections(actor_id);
alter table private.opening_journal_corrections enable row level security;
revoke all on private.opening_journal_corrections from public,anon,authenticated;
create trigger prevent_retired_operation before insert on private.opening_journal_corrections
 for each row execute function private.prevent_retired_operation('opening-journal-correction','actor_id','request_id');

create function private.journal_snapshot(p_id uuid) returns jsonb language sql stable security definer set search_path='' as $$
 select to_jsonb(e)-'request_id'-'request_payload'||jsonb_build_object('lines',
  (select jsonb_agg(to_jsonb(l)||jsonb_build_object('name',a.name) order by l.line_no)
   from public.journal_lines l join public.ledger_accounts a on a.code=l.account where l.entry_id=e.id))
 from public.journal_entries e where e.id=p_id;
$$;
revoke all on function private.journal_snapshot(uuid) from public,anon,authenticated;
create function public.get_opening_journal_id() returns uuid language sql stable security invoker set search_path='' as $$
 select id from public.journal_entries where kind='opening' and voided_at is null;
$$;
revoke all on function public.get_opening_journal_id() from public,anon;
grant execute on function public.get_opening_journal_id() to authenticated;

create or replace function private.get_journal_entry(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
 if auth.uid() is null or private.staff_role() is distinct from 'admin' then raise insufficient_privilege; end if;
 result:=private.journal_snapshot(p_id);
 if result is null then raise exception 'No se encontró el comprobante.'; end if;
 if result->>'kind'='opening' then
  result:=result||jsonb_build_object('openingHistory',coalesce((select jsonb_agg(jsonb_build_object(
   'id',id,'revision',revision,'actorName',actor_name,'createdAt',created_at,'before',before_snapshot,'after',after_snapshot) order by revision desc)
   from private.opening_journal_corrections where entry_id=p_id),'[]'::jsonb),
   'openingAccounts',(select jsonb_agg(jsonb_build_object('code',code,'name',name,'bucket',bucket) order by code)
    from public.ledger_accounts a where postable and bucket in ('asset','liability','equity')
    and (active or exists(select 1 from public.journal_lines l where l.entry_id=p_id and l.account=a.code))));
 end if;
 return result;
end $$;

-- Excepción acotada para una edición de apertura ya auditada, incluso si
-- aquella fecha tiene cierre. Las operaciones ordinarias conservan su bloqueo.
do $guard$ declare s text; marker text:=' v_row:=case when tg_op='; begin
 s:=pg_get_functiondef('private.guard_business_day()'::regprocedure);
 if position(marker in s)=0 then raise exception 'Revisar la protección de jornadas antes de actualizar.'; end if;
 s:=replace(s,marker,$exception$ if tg_table_name='journal_entries' and tg_op='UPDATE' then
  if old.kind='opening' and new.kind='opening' and auth.uid() is not null and private.staff_role()='admin'
   and new.id=old.id and new.number=old.number and new.occurred_on=old.occurred_on
   and new.currency=old.currency and new.exchange_rate=old.exchange_rate
   and new.created_by=old.created_by and new.created_at=old.created_at
   and new.request_id=old.request_id and new.request_payload=old.request_payload
   and old.voided_at is null and new.voided_at is null and new.voided_by is null and new.void_reason is null
   and new.revision=old.revision+1
   and exists(select 1 from private.opening_journal_corrections c where c.entry_id=new.id and c.revision=new.revision
    and c.actor_id=auth.uid() and (c.before_snapshot->>'revision')::integer=old.revision
    and c.after_snapshot->>'description'=new.description and c.after_snapshot->>'reference'=new.reference) then
   return new;
  end if;
 end if;
$exception$||marker);
 execute s;
end $guard$;

create function private.correct_opening_journal(p_input jsonb) returns uuid
language plpgsql security definer set search_path='' as $$
declare
 v_id uuid:=(p_input->>'entryId')::uuid; v_request uuid:=(p_input->>'requestId')::uuid;
 e public.journal_entries%rowtype; saved private.opening_journal_corrections%rowtype;
 v_before jsonb; v_after jsonb; v_lines jsonb:='[]'; l jsonb; a public.ledger_accounts%rowtype;
 v_debit numeric; v_credit numeric; v_debit_nio numeric; v_credit_nio numeric; n integer:=0;
 v_description text:=btrim(p_input->>'description'); v_reference text:=coalesce(p_input->>'reference','');
begin
 if auth.uid() is null or private.staff_role() is distinct from 'admin' then raise insufficient_privilege; end if;
 if v_id is null or v_request is null then raise exception 'Falta identificar el comprobante o la solicitud.'; end if;
 perform pg_advisory_xact_lock(hashtextextended('lcp-business-day',0));
 select * into saved from private.opening_journal_corrections where request_id=v_request;
 if found then
  if saved.actor_id<>auth.uid() or saved.request_payload<>p_input then raise exception 'La solicitud de edición cambió.'; end if;
  return saved.entry_id;
 end if;
 select * into e from public.journal_entries where id=v_id for update;
 if not found or e.kind<>'opening' or e.voided_at is not null then raise exception 'Selecciona un comprobante de apertura vigente.'; end if;
 if not(p_input ? 'expectedRevision') or (p_input->>'expectedRevision')::integer is distinct from e.revision then
  raise exception 'La apertura cambió desde que abriste el formulario. Actualiza el comprobante antes de editarlo.';
 end if;
 if v_description is null or length(v_description) not between 1 and 300 or length(v_reference)>200 then raise exception 'Revisa el concepto y la referencia del comprobante.'; end if;
 if jsonb_typeof(p_input->'lines') is distinct from 'array' or jsonb_array_length(p_input->'lines') not between 2 and 100 then
  raise exception 'El comprobante necesita entre 2 y 100 renglones.';
 end if;
 v_before:=private.journal_snapshot(v_id);
 for l in select value from jsonb_array_elements(p_input->'lines') loop
  n:=n+1;
  v_debit:=private.accounting_number(l,'debit',100000000,2);
  v_credit:=private.accounting_number(l,'credit',100000000,2);
  if not((v_debit>0 and v_credit=0) or (v_credit>0 and v_debit=0)) then raise exception 'Cada renglón necesita un importe positivo en Debe o Haber.'; end if;
  select * into a from public.ledger_accounts where code=l->>'account';
  if not found or not a.postable or a.bucket not in ('asset','liability','equity') then raise exception 'La apertura solo admite cuentas de activo, pasivo y capital.'; end if;
  if not a.active and not exists(select 1 from public.journal_lines x where x.entry_id=v_id and x.account=a.code and x.debit=v_debit and x.credit=v_credit) then
   raise exception 'La cuenta % está inactiva. Selecciona una cuenta activa.',a.code;
  end if;
  v_lines:=v_lines||jsonb_build_array(jsonb_build_object('entry_id',v_id,'line_no',n,'account',a.code,'name',a.name,
   'debit',v_debit,'credit',v_credit,'debit_nio',round(v_debit*e.exchange_rate,2),'credit_nio',round(v_credit*e.exchange_rate,2)));
 end loop;
 if (select sum((x->>'debit')::numeric-(x->>'credit')::numeric) from jsonb_array_elements(v_lines)x)<>0
  or (select sum((x->>'debit_nio')::numeric-(x->>'credit_nio')::numeric) from jsonb_array_elements(v_lines)x)<>0 then
  raise exception 'El Debe y el Haber deben sumar lo mismo, también en córdobas.';
 end if;
 if exists(select 1 from jsonb_array_elements(v_lines)x where x->>'account' in ('1110-001','1110-002')
  group by x->>'account' having sum((x->>'debit_nio')::numeric-(x->>'credit_nio')::numeric)<0) then
  raise exception 'El saldo inicial de caja no puede ser negativo.';
 end if;
 -- El inventario se corrige con cantidades, costos y conciliación; cambiar
 -- sólo el mayor aquí dejaría una diferencia frente a las existencias.
 if (select coalesce(sum((x->>'debit_nio')::numeric-(x->>'credit_nio')::numeric),0) from jsonb_array_elements(v_lines)x where x->>'account'='1130')
  <> (select coalesce(sum(debit_nio-credit_nio),0) from public.journal_lines where entry_id=v_id and account='1130') then
  raise exception 'El saldo de inventario se corrige desde Inventario y su conciliación contable. Puedes editar las demás cuentas aquí.';
 end if;
 v_after:=v_before||jsonb_build_object('revision',e.revision+1,'description',v_description,'reference',v_reference,'lines',v_lines);
 if v_after-'revision'=v_before-'revision' then raise exception 'No hay cambios para guardar.'; end if;
 perform private.limit_catalog_writes();
 insert into private.opening_journal_corrections(entry_id,revision,before_snapshot,after_snapshot,actor_id,actor_name,request_id,request_payload)
 values(v_id,e.revision+1,v_before,v_after,auth.uid(),coalesce((select display_name from private.business_actors where id=auth.uid()),'Administrador'),v_request,p_input);
 update public.journal_entries set description=v_description,reference=v_reference,revision=revision+1 where id=v_id;
 delete from public.journal_lines where entry_id=v_id;
 insert into public.journal_lines(entry_id,line_no,account,debit,credit,debit_nio,credit_nio)
 select v_id,(x->>'line_no')::integer,x->>'account',(x->>'debit')::numeric,(x->>'credit')::numeric,(x->>'debit_nio')::numeric,(x->>'credit_nio')::numeric
 from jsonb_array_elements(v_lines)x;
 perform private.check_credit_pool();
 perform private.check_pos_balance();
 return v_id;
end $$;
create function public.correct_opening_journal(p_input jsonb) returns uuid
language sql security invoker set search_path='' as $$select private.correct_opening_journal(p_input);$$;
revoke all on function private.correct_opening_journal(jsonb),public.correct_opening_journal(jsonb) from public,anon;
grant execute on function private.correct_opening_journal(jsonb),public.correct_opening_journal(jsonb) to authenticated;

do $recovery$ declare s text; begin
 s:=pg_get_functiondef('private.operation_confirmation(text,uuid,boolean)'::regprocedure);
 if position('''business-day-prepare'') then' in s)=0 then raise exception 'Revisar la recuperación de solicitudes.'; end if;
 s:=replace(s,'''business-day-prepare'') then','''business-day-prepare'',''opening-journal-correction'') then');
 s:=replace(s,'when ''journal'' then','when ''opening-journal-correction'' then v_table:=''private.opening_journal_corrections'';v_actor:=''actor_id''; when ''journal'' then');
 execute s;
end $recovery$;
notify pgrst,'reload schema';
