alter table public.finance_entries add column revision integer not null default 0 check(revision>=0);
create table private.finance_corrections (
 id uuid primary key default gen_random_uuid(),entry_id uuid not null references public.finance_entries(id),revision integer not null,
 request_id uuid not null unique,request_payload jsonb not null,actor_id uuid not null references private.business_actors(id),actor_name text not null,
 before_snapshot jsonb not null,after_snapshot jsonb not null,temporary_request uuid not null,transaction_id bigint not null,
 created_at timestamptz not null default now(),unique(entry_id,revision));
alter table private.finance_corrections enable row level security;
revoke all on private.finance_corrections from public,anon,authenticated;
do $$ declare d text; begin
 d:=replace(pg_get_functiondef('private.guard_business_day()'::regprocedure),E'\r\n',E'\n');
 d:=replace(d,E'begin\n',$patch$begin
 if tg_table_name='finance_entries' and private.is_superadmin() then
  if tg_op='INSERT' then
   if exists(select 1 from private.finance_corrections c where c.actor_id=auth.uid() and c.transaction_id=txid_current() and c.temporary_request=new.request_id) then return new; end if;
  else
   if exists(select 1 from private.finance_corrections c where c.actor_id=auth.uid() and c.transaction_id=txid_current() and (c.entry_id=old.id or c.temporary_request=old.request_id)) then
    if tg_op='DELETE' then return old; else return new; end if;
   end if;
  end if;
 end if;
 $patch$);execute d;
 d:=replace(pg_get_functiondef('private.protect_corrected_purchase_payment()'::regprocedure),E'\r\n',E'\n');
 d:=replace(d,E'begin\n',$patch$begin
 if private.is_superadmin() and exists(select 1 from private.finance_corrections c where c.actor_id=auth.uid() and c.transaction_id=txid_current() and (c.entry_id=new.id or c.temporary_request=new.request_id)) then return new; end if;
 $patch$);execute d;
end $$;

create function private.finance_correction_context(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare e public.finance_entries%rowtype;
begin
 if auth.uid() is null or not private.is_superadmin() then raise insufficient_privilege; end if;
 select * into e from public.finance_entries where id=p_id;
 if not found then raise exception 'No se encontró el movimiento.'; end if;
 return jsonb_build_object('entry',to_jsonb(e)-'request_payload','credits',private.credit_accounts((now() at time zone 'America/Managua')::date),
 'history',coalesce((select jsonb_agg(jsonb_build_object('id',id,'revision',revision,'actorName',actor_name,'createdAt',created_at,'before',before_snapshot,'after',after_snapshot) order by revision desc) from private.finance_corrections where entry_id=e.id),'[]'));
end $$;
create function public.finance_correction_context(p_id uuid) returns jsonb language sql security invoker set search_path='' as $$select private.finance_correction_context(p_id)$$;
create function private.correct_finance_entry(p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare e public.finance_entries%rowtype;n public.finance_entries%rowtype;c private.finance_corrections%rowtype;
 v_id uuid;v_temp uuid:=gen_random_uuid();v_req uuid:=gen_random_uuid();actor text;r jsonb;
begin
 if auth.uid() is null or not private.is_superadmin() then raise insufficient_privilege; end if;
 perform pg_advisory_xact_lock(hashtextextended('lcp-business-day',0));
 perform pg_advisory_xact_lock(hashtextextended('finance-credit-ledger',0));
 perform pg_advisory_xact_lock(hashtextextended('finance-correction:'||coalesce(p_input->>'requestId',''),0));
 select * into c from private.finance_corrections where request_id=(p_input->>'requestId')::uuid;
 if found then
  if c.actor_id<>auth.uid() or c.request_payload<>p_input then raise exception 'La solicitud de edición cambió.'; end if;
  return c.after_snapshot;
 end if;
 select * into e from public.finance_entries where id=(p_input->>'entryId')::uuid for update;
 if not found or e.voided_at is not null then raise exception 'El movimiento no existe o está anulado.'; end if;
 if e.kind='opening' or p_input->>'kind'='opening' then raise exception 'Corrige los saldos iniciales desde Editar apertura contable.'; end if;
 if e.revision is distinct from (p_input->>'expectedRevision')::integer then raise exception 'El movimiento cambió. Actualiza su detalle antes de editarlo.'; end if;
 if exists(select 1 from private.purchase_payment_links where finance_entry_id=e.id) and nullif(p_input->>'shipmentId','')::uuid is distinct from e.shipment_id then
  raise exception 'Este pago está vinculado desde una clasificación. Desvincúlalo allí antes de asignarlo a otra compra.'; end if;
 select display_name into actor from private.business_actors where id=auth.uid();
 insert into private.finance_corrections(entry_id,revision,request_id,request_payload,actor_id,actor_name,before_snapshot,after_snapshot,temporary_request,transaction_id)
 values(e.id,e.revision+1,(p_input->>'requestId')::uuid,p_input,auth.uid(),coalesce(actor,'SuperAdmin'),to_jsonb(e)-'request_payload','{}',v_req,txid_current()) returning id into v_id;
 -- Se valida el reemplazo con las mismas reglas de un abono nuevo, excluyendo
 -- temporalmente el efecto anterior dentro de esta única transacción.
 update public.finance_entries set voided_at=now(),voided_by=auth.uid(),void_reason='Edición de movimiento' where id=e.id;
 v_temp:=private.record_finance_entry((p_input-'entryId'-'expectedRevision')||jsonb_build_object('requestId',v_req));
 select * into n from public.finance_entries where id=v_temp;
 update public.finance_entries set occurred_on=n.occurred_on,kind=n.kind,account=n.account,to_account=n.to_account,amount=n.amount,currency=n.currency,
 exchange_rate=n.exchange_rate,counterparty=n.counterparty,description=n.description,reference=n.reference,document_id=n.document_id,shipment_id=n.shipment_id,
 opening_settlement=n.opening_settlement,bank_ledger_account=n.bank_ledger_account,voided_at=null,voided_by=null,void_reason=null,revision=e.revision+1 where id=e.id;
 delete from public.finance_entries where id=v_temp;
 perform private.check_credit_pool();
 perform private.validate_purchase_classification(pc.shipment_id,pc.entry_id) from private.purchase_classifications pc where pc.shipment_id in (e.shipment_id,n.shipment_id);
 r:=(select to_jsonb(f)-'request_payload' from public.finance_entries f where id=e.id);
 update private.finance_corrections set after_snapshot=r where id=v_id;
 return r;
end $$;
create function public.correct_finance_entry(p_input jsonb) returns jsonb language sql security invoker set search_path='' as $$select private.correct_finance_entry(p_input)$$;

alter function private.operation_confirmation(text,uuid,boolean) rename to operation_confirmation_before_finance_edits;
create function private.operation_confirmation(p_kind text,p_request_id uuid,p_retire boolean default false) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r private.finance_corrections%rowtype;
begin
 if p_kind<>'finance-correction' then return private.operation_confirmation_before_finance_edits(p_kind,p_request_id,p_retire); end if;
 if auth.uid() is null or not private.is_superadmin() then raise insufficient_privilege; end if;
 perform pg_advisory_xact_lock(hashtextextended('lcp-business-day',0));
 select * into r from private.finance_corrections where actor_id=auth.uid() and request_id=p_request_id;
 if found then return jsonb_build_object('status','confirmed','id',r.entry_id); end if;
 if p_retire then insert into private.retired_operations(actor_id,kind,request_id) values(auth.uid(),p_kind,p_request_id) on conflict do nothing; end if;
 if exists(select 1 from private.retired_operations where actor_id=auth.uid() and kind=p_kind and request_id=p_request_id) then return jsonb_build_object('status','retired'); end if;
 return jsonb_build_object('status','missing');
end $$;
create trigger retired_operation before insert on private.finance_corrections for each row execute function private.prevent_retired_operation('finance-correction','actor_id','request_id');
revoke all on function private.operation_confirmation(text,uuid,boolean),private.operation_confirmation_before_finance_edits(text,uuid,boolean) from public,anon,authenticated;
revoke all on function private.finance_correction_context(uuid),public.finance_correction_context(uuid),private.correct_finance_entry(jsonb),public.correct_finance_entry(jsonb) from public,anon;
grant execute on function private.finance_correction_context(uuid),public.finance_correction_context(uuid),private.correct_finance_entry(jsonb),public.correct_finance_entry(jsonb) to authenticated;

-- Los resúmenes operativos también reconocen la parte de una corrección que
-- corresponde a costo de ventas o a merma, sin reescribir facturas anteriores.
do $$ declare d text; begin
 d:=pg_get_functiondef('public.report_digest(date,date)'::regprocedure);
 d:=replace(d,'public.report_digest(', 'private.report_digest_before_receipt_corrections(');
 execute d;
end $$;
create function private.report_digest_with_receipt_corrections(p_from date,p_to date) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare r jsonb; costs numeric; losses numeric; months jsonb;
begin
 r:=private.report_digest_before_receipt_corrections(p_from,p_to);
 if jsonb_typeof(r->'ledger') is distinct from 'object' then return r; end if;
 select coalesce(sum(l.debit_nio-l.credit_nio) filter(where l.account='5120'),0),coalesce(sum(l.debit_nio-l.credit_nio) filter(where l.account='5150'),0)
 into costs,losses from private.receipt_revisions v join public.journal_entries e on e.id=v.journal_entry_id join public.journal_lines l on l.entry_id=e.id
 where e.voided_at is null and e.occurred_on between p_from and p_to;
 r:=jsonb_set(r,'{ledger,costOfSalesNio}',to_jsonb((r#>>'{ledger,costOfSalesNio}')::numeric+costs));
 r:=jsonb_set(r,'{ledger,inventoryWriteOffNio}',to_jsonb((r#>>'{ledger,inventoryWriteOffNio}')::numeric+losses));
 with changes as (
 select to_char(e.occurred_on,'YYYY-MM') as month_key,coalesce(sum(l.debit_nio-l.credit_nio) filter(where l.account='5120'),0) costs,
 coalesce(sum(l.debit_nio-l.credit_nio) filter(where l.account='5150'),0) losses
 from private.receipt_revisions v join public.journal_entries e on e.id=v.journal_entry_id join public.journal_lines l on l.entry_id=e.id
 where e.voided_at is null and e.occurred_on between p_from and p_to and l.account in ('5120','5150') group by 1),
 original as(select x->>'month' as month_key,x from jsonb_array_elements(coalesce(r#>'{ledger,months}','[]'))x)
 select coalesce(jsonb_agg(coalesce(o.x,jsonb_build_object('month',c.month_key,'revenueNio',0,'shippingNio',0,'shippingExpenseNio',0,'salesTaxNio',0,'missingCostUnits',0,'missingRevenueLines',0,'soldUnits',0,'missingWriteOffUnits',0))||
 jsonb_build_object('costOfSalesNio',coalesce((o.x->>'costOfSalesNio')::numeric,0)+coalesce(c.costs,0),
 'inventoryWriteOffNio',coalesce((o.x->>'inventoryWriteOffNio')::numeric,0)+coalesce(c.losses,0)) order by coalesce(o.month_key,c.month_key)),'[]') into months
 from original o full join changes c on c.month_key=o.month_key;
 return jsonb_set(r,'{ledger,months}',months);
end $$;
create or replace function public.report_digest(p_from date,p_to date) returns jsonb
language sql security invoker set search_path='' as $$select private.report_digest_with_receipt_corrections(p_from,p_to)$$;
revoke all on function private.report_digest_before_receipt_corrections(date,date),private.report_digest_with_receipt_corrections(date,date) from public,anon;
revoke all on function private.report_digest_before_receipt_corrections(date,date) from authenticated;
grant execute on function private.report_digest_with_receipt_corrections(date,date) to authenticated;
notify pgrst,'reload schema';
