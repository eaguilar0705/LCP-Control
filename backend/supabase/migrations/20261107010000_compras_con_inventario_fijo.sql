-- La recepción prepara existencias y costos. Su comprobante definitivo carga
-- Inventario una sola vez; el contador elige únicamente la contrapartida.
-- La cuenta temporal se conserva como respaldo histórico, nunca para operar.
create table private.purchase_inventory_origin_changes (
 id uuid primary key default gen_random_uuid(), entry_id uuid not null unique references public.journal_entries(id),
 before_snapshot jsonb not null, after_snapshot jsonb not null, created_at timestamptz not null default now()
);
alter table private.purchase_inventory_origin_changes enable row level security;
revoke all on private.purchase_inventory_origin_changes from public,anon,authenticated;

-- No se cambia ningún pago, importe, movimiento ni identificación original.
do $$
declare e record; l record; b jsonb; n integer; origin numeric;
begin
 for e in select distinct j.id,exists(select 1 from private.purchase_classifications pc where pc.entry_id=j.id) classification
  from public.journal_entries j join public.journal_lines jl on jl.entry_id=j.id and jl.account='2190'
  where exists(select 1 from private.purchase_classifications pc where pc.entry_id=j.id)
   or exists(select 1 from private.receipt_revisions r join public.purchase_shipments s on s.id=r.shipment_id
    where r.journal_entry_id=j.id and s.account='pending')
 loop
  b:=private.journal_snapshot(e.id);
  if e.classification then
   select sum(debit_nio-credit_nio) into origin from public.journal_lines where entry_id=e.id and account='2190';
   delete from private.journal_line_currencies where entry_id=e.id;
   delete from public.journal_lines where entry_id=e.id;
   insert into private.journal_line_currencies values(e.id,1,'NIO',1);
   insert into public.journal_lines values(e.id,1,'1130',origin,0,origin,0);
   n:=1;
   for l in select value x from jsonb_array_elements(b->'lines') where value->>'account'<>'2190' loop
    n:=n+1;
    insert into private.journal_line_currencies values(e.id,n,coalesce(l.x->>'currency','NIO'),coalesce((l.x->>'exchange_rate')::numeric,1));
    insert into public.journal_lines values(e.id,n,l.x->>'account',(l.x->>'debit')::numeric,(l.x->>'credit')::numeric,
     (l.x->>'debit_nio')::numeric,(l.x->>'credit_nio')::numeric);
   end loop;
  else
   -- La parte ya consumida se transfiere de Inventario al costo elegido.
   -- El total corregido se reconocerá en el comprobante de la compra.
   update public.journal_lines set account='1130' where entry_id=e.id and account='2190';
  end if;
  insert into private.purchase_inventory_origin_changes(entry_id,before_snapshot,after_snapshot)
   values(e.id,b,private.journal_snapshot(e.id));
 end loop;
end $$;

alter view private.operational_postings rename to operational_postings_before_fixed_purchase;
create view private.operational_postings as
 select o.* from private.operational_postings_before_fixed_purchase o
 left join public.purchase_corrections c on o.source='purchase_correction' and c.id=o.source_id
 left join public.purchase_shipments s on s.id=case when o.source='purchase' then o.source_id else c.shipment_id end
 where s.account is distinct from 'pending';
revoke all on private.operational_postings,private.operational_postings_before_fixed_purchase from public,anon,authenticated;

update public.ledger_accounts set active=false where code='2190';
create function private.reject_retired_purchase_account() returns trigger
language plpgsql set search_path='' as $$
begin
 if new.account='2190' then raise exception 'La cuenta Compras por clasificar fue retirada. Usa Inventario de perfumes como origen de la compra.'; end if;
 return new;
end $$;
create trigger retired_purchase_account before insert or update on public.journal_lines
 for each row execute function private.reject_retired_purchase_account();
revoke all on function private.reject_retired_purchase_account() from public,anon,authenticated;

do $$ declare d text; begin
 d:=pg_get_functiondef('private.ledger_account_restriction(text)'::regprocedure);
 d:=replace(d,E'begin\n',E'begin\n if p_code=''2190'' then return ''Cuenta retirada. Las compras cargan directamente Inventario de perfumes.''; end if;\n');execute d;
 d:=pg_get_functiondef('private.change_ledger_account(jsonb)'::regprocedure);
 d:=replace(d,E'begin\n',E'begin\n if v_code=''2190'' then raise exception ''La cuenta Compras por clasificar fue retirada.''; end if;\n');execute d;
 d:=pg_get_functiondef('private.save_ledger_account(jsonb)'::regprocedure);
 d:=replace(d,E'begin\n',E'begin\n if p_input->>''code''=''2190'' then raise exception ''La cuenta Compras por clasificar fue retirada.''; end if;\n');execute d;
end $$;
alter function private.ledger_accounts_list() rename to ledger_accounts_list_before_fixed_purchase;
create function private.ledger_accounts_list() returns jsonb
language sql stable security definer set search_path='' as $$
 select coalesce(jsonb_agg(x order by x->>'code'),'[]') from jsonb_array_elements(private.ledger_accounts_list_before_fixed_purchase()) x where x->>'code'<>'2190';
$$;
revoke all on function private.ledger_accounts_list_before_fixed_purchase() from public,anon,authenticated;
revoke all on function private.ledger_accounts_list() from public,anon;
grant execute on function private.ledger_accounts_list() to authenticated;

create or replace function private.validate_purchase_classification(p_shipment uuid,p_entry uuid) returns void
language plpgsql security invoker set search_path='' as $$
declare total numeric; payable numeric; paid numeric;
begin
 select round((s->>'goods_amount')::numeric*(s->>'exchange_rate')::numeric,2)+round((s->>'shipping_amount')::numeric*(s->>'exchange_rate')::numeric,2)
 into total from (select private.receipt_snapshot(p_shipment) s)q;
 if not exists(select 1 from public.journal_lines l left join private.journal_line_currencies c on c.entry_id=l.entry_id and c.line_no=l.line_no
  where l.entry_id=p_entry and l.line_no=1 and l.account='1130' and l.debit=total and l.credit=0
   and l.debit_nio=total and l.credit_nio=0 and coalesce(c.currency,'NIO')='NIO' and coalesce(c.exchange_rate,1)=1)
  or exists(select 1 from public.journal_lines where entry_id=p_entry and (account='2190' or (line_no<>1 and account='1130'))) then
  raise exception 'El primer renglón debe ser Inventario de perfumes por C$ %, fijo en el Debe. Edita únicamente la contrapartida.',total;
 end if;
 select coalesce(sum(credit_nio-debit_nio),0) into payable from public.journal_lines where entry_id=p_entry and account='2111';
 select coalesce(sum(round(amount*exchange_rate,2)),0) into paid from public.finance_entries where shipment_id=p_shipment and voided_at is null;
 if payable<paid then raise exception 'La cuenta Proveedores debe cubrir los C$ % de abonos ya registrados. Revisa su vinculación.',paid; end if;
 if exists(select 1 from public.finance_entries f join public.journal_entries e on e.id=p_entry where f.shipment_id=p_shipment and f.voided_at is null and f.occurred_on<e.occurred_on) then
  raise exception 'La contabilización no puede quedar después de un abono vinculado. Revisa la fecha.';
 end if;
end $$;

do $$ declare d text; begin
 d:=pg_get_functiondef('private.classify_purchase(jsonb)'::regprocedure);
 d:=replace(d,'return old.result;','return private.get_journal_entry((old.result->>''id'')::uuid);');execute d;
 d:=pg_get_functiondef('private.purchase_accounting_rows(text,timestamptz,uuid)'::regprocedure);
 d:=replace(d,$needle$l.account='2190'$needle$,$patch$l.account='1130' and l.line_no=1$patch$);execute d;
 d:=pg_get_functiondef('private.revise_purchase_receipt(jsonb)'::regprocedure);
 d:=replace(d,$needle$if s.account='pending' then v_counterpart:='2190'; end if;$needle$,$patch$if s.account='pending' then v_counterpart:='1130'; end if;$patch$);
 d:=replace(d,$needle$and code<>'1130'$needle$,$patch$and (code<>'1130' or s.account='pending')$patch$);
 execute d;
end $$;

-- La edición y los borradores usan siempre el cargo vigente de la recepción.
alter function private.get_journal_entry(uuid) rename to get_journal_entry_before_fixed_purchase;
create function private.get_journal_entry(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare r jsonb; s jsonb; changes jsonb;
begin
 r:=private.get_journal_entry_before_fixed_purchase(p_id);
 select private.receipt_snapshot(shipment_id) into s from private.purchase_classifications where entry_id=p_id;
 select coalesce(jsonb_agg(jsonb_build_object('id',id,'revision',coalesce((before_snapshot->>'revision')::integer,0),
  'actorName','Actualización del sistema','createdAt',created_at,'before',before_snapshot,'after',after_snapshot)),'[]') into changes
 from private.purchase_inventory_origin_changes where entry_id=p_id;
 return r||jsonb_build_object('purchaseInventoryDebit',case when s is null then null else
  round((s->>'goods_amount')::numeric*(s->>'exchange_rate')::numeric,2)+round((s->>'shipping_amount')::numeric*(s->>'exchange_rate')::numeric,2) end,
  'editingAccounts',(select coalesce(jsonb_agg(a),'[]') from jsonb_array_elements(coalesce(r->'editingAccounts','[]'))a where a->>'code'<>'2190'),
  'editHistory',coalesce(r->'editHistory','[]')||changes);
end $$;
revoke all on function private.get_journal_entry_before_fixed_purchase(uuid) from public,anon,authenticated;
revoke all on function private.get_journal_entry(uuid) from public,anon;
grant execute on function private.get_journal_entry(uuid) to authenticated;

create function private.fixed_purchase_draft(p_data jsonb) returns jsonb
language plpgsql stable security invoker set search_path='' as $$
declare s jsonb; total numeric; lines jsonb;
begin
 if p_data->>'submitName' is distinct from 'classify_purchase' then return p_data; end if;
 s:=private.receipt_snapshot(nullif(p_data#>>'{extraInput,shipmentId}','')::uuid);
 if s is null then return p_data; end if;
 total:=round((s->>'goods_amount')::numeric*(s->>'exchange_rate')::numeric,2)+round((s->>'shipping_amount')::numeric*(s->>'exchange_rate')::numeric,2);
 select jsonb_build_array(jsonb_build_object('account','1130','currency','NIO','exchangeRate',1,'debit',total,'credit',0))||
  coalesce(jsonb_agg(value order by ordinality) filter(where value->>'account' not in ('2190','1130')),'[]') into lines
  from jsonb_array_elements(p_data->'lines') with ordinality;
 return p_data||jsonb_build_object('fixedInventoryDebit',total,'lines',lines);
end $$;
do $$ declare d text; begin
 d:=pg_get_functiondef('private.save_accounting_draft(jsonb)'::regprocedure);
 d:=replace(d,$needle$data=p_input->'data'$needle$,$patch$data=private.fixed_purchase_draft(p_input->'data')$patch$);
 d:=replace(d,$needle$auth.uid(),p_input->'data')$needle$,$patch$auth.uid(),private.fixed_purchase_draft(p_input->'data'))$patch$);
 execute d;
end $$;
alter function private.accounting_drafts(integer) rename to accounting_drafts_before_fixed_purchase;
create function private.accounting_drafts(p_offset integer default 0) returns jsonb
language sql stable security definer set search_path='' as $$
 select coalesce(jsonb_agg(x||jsonb_build_object('data',private.fixed_purchase_draft(x->'data')) order by ordinality),'[]')
 from jsonb_array_elements(private.accounting_drafts_before_fixed_purchase(p_offset)) with ordinality as d(x,ordinality);
$$;
revoke all on function private.fixed_purchase_draft(jsonb),private.accounting_drafts_before_fixed_purchase(integer) from public,anon,authenticated;
revoke all on function private.accounting_drafts(integer) from public,anon;
grant execute on function private.accounting_drafts(integer) to authenticated;

alter function private.ledger_report(date,date) rename to ledger_report_before_fixed_purchase;
create function private.ledger_report(p_from date,p_to date) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare r jsonb; meta jsonb;
begin
 r:=private.ledger_report_before_fixed_purchase(p_from,p_to);
 select jsonb_build_object('pendingCount',count(*),'pendingTotalNio',coalesce(sum(total),0),
  'unpostedDifferenceNio',coalesce(sum(total-posted),0)) into meta from (
  select round((snap.s->>'goods_amount')::numeric*(snap.s->>'exchange_rate')::numeric,2)+round((snap.s->>'shipping_amount')::numeric*(snap.s->>'exchange_rate')::numeric,2) total,
   coalesce((select sum(l.debit_nio-l.credit_nio) from public.journal_lines l where l.entry_id=e.id and l.line_no=1 and l.account='1130' and e.voided_at is null and e.occurred_on<=p_to),0) posted
  from public.purchase_shipments s cross join lateral(select private.receipt_snapshot(s.id) s)snap
  left join private.purchase_classifications pc on pc.shipment_id=s.id left join public.journal_entries e on e.id=pc.entry_id
  where s.account='pending' and not exists(select 1 from public.purchase_corrections c where c.shipment_id=s.id)
   and (snap.s->>'incurred_on')::date<=p_to and ((r->>'startOn') is null or (snap.s->>'incurred_on')::date>=(r->>'startOn')::date)
 )q where total<>posted;
 return r||jsonb_build_object('purchaseAccounting',meta,'accounts',(
  select coalesce(jsonb_agg(a),'[]') from jsonb_array_elements(r->'accounts')a
  where a->>'code'<>'2190' or coalesce((a->>'opening')::numeric,0)<>0 or coalesce((a->>'debit')::numeric,0)<>0
   or coalesce((a->>'credit')::numeric,0)<>0 or coalesce((a->>'closing')::numeric,0)<>0));
end $$;
revoke all on function private.ledger_report_before_fixed_purchase(date,date) from public,anon,authenticated;
revoke all on function private.ledger_report(date,date) from public,anon;
grant execute on function private.ledger_report(date,date) to authenticated;
notify pgrst,'reload schema';
