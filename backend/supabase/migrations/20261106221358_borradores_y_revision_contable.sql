create table private.accounting_drafts (
 id uuid primary key,actor_id uuid not null references private.business_actors(id),revision integer not null default 0,
 data jsonb not null check(octet_length(data::text)<=250000),updated_at timestamptz not null default now(),completed_at timestamptz);
create index accounting_drafts_owner_idx on private.accounting_drafts(actor_id,updated_at desc,id);
create table private.accounting_draft_requests (
 request_id uuid primary key,actor_id uuid not null references private.business_actors(id),payload jsonb not null,result jsonb not null,created_at timestamptz not null default now());
alter table private.accounting_drafts enable row level security;
alter table private.accounting_draft_requests enable row level security;
revoke all on private.accounting_drafts,private.accounting_draft_requests from public,anon,authenticated;
create function private.save_accounting_draft(p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare d private.accounting_drafts%rowtype;r private.accounting_draft_requests%rowtype;result jsonb;
begin
 if auth.uid() is null or private.staff_role() is distinct from 'admin' then raise insufficient_privilege; end if;
 perform pg_advisory_xact_lock(hashtextextended('lcp-business-day',0));
 perform pg_advisory_xact_lock(hashtextextended('accounting-draft:'||coalesce(p_input->>'draftId',''),0));
 select * into r from private.accounting_draft_requests where request_id=(p_input->>'requestId')::uuid;
 if found then
  if r.actor_id<>auth.uid() or r.payload<>p_input then raise exception 'La solicitud de borrador cambió.'; end if;
  return r.result;
 end if;
 if jsonb_typeof(p_input->'data') is distinct from 'object' or octet_length((p_input->'data')::text)>250000 then raise exception 'El borrador no tiene un formato válido.'; end if;
 if coalesce(p_input#>>'{data,kind}','') not in ('income','expense','deposit','transfer','adjustment','card_settlement') or jsonb_typeof(p_input#>'{data,lines}') is distinct from 'array' or jsonb_array_length(p_input#>'{data,lines}') not between 1 and 100 then raise exception 'Revisa el tipo y los renglones del borrador.'; end if;
 if nullif(p_input#>>'{data,submitName}','') is not null and p_input#>>'{data,submitName}' not in ('record_journal_entry','correct_journal_entry','classify_purchase') then raise exception 'Tipo de borrador no disponible.'; end if;
 select * into d from private.accounting_drafts where id=(p_input->>'draftId')::uuid for update;
 if found then
  if d.actor_id<>auth.uid() and not private.is_superadmin() then raise insufficient_privilege; end if;
  if d.completed_at is not null or d.revision is distinct from (p_input->>'expectedRevision')::integer then raise exception 'El borrador cambió o ya fue contabilizado. Actualiza su lista.'; end if;
  update private.accounting_drafts set data=p_input->'data',revision=revision+1,updated_at=now() where id=d.id returning * into d;
 else
  if (p_input->>'expectedRevision')::integer<>-1 then raise exception 'El borrador ya no está disponible.'; end if;
  insert into private.accounting_drafts(id,actor_id,data) values((p_input->>'draftId')::uuid,auth.uid(),p_input->'data') returning * into d;
 end if;
 result:=jsonb_build_object('id',d.id,'revision',d.revision,'data',d.data);
 insert into private.accounting_draft_requests values((p_input->>'requestId')::uuid,auth.uid(),p_input,result,now());
 return result;
end $$;
create function public.save_accounting_draft(p_input jsonb) returns jsonb language sql security invoker set search_path='' as $$select private.save_accounting_draft(p_input)$$;
create function private.accounting_drafts(p_offset integer default 0) returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
 if auth.uid() is null or private.staff_role() is distinct from 'admin' then raise insufficient_privilege; end if;
 if p_offset<0 or p_offset>100000 then raise exception 'Página inválida.'; end if;
 return (select coalesce(jsonb_agg(to_jsonb(r) order by r.updated_at desc,r.id desc),'[]') from (
 select d.id,d.revision,d.data,d.updated_at,a.display_name actor_name from private.accounting_drafts d join private.business_actors a on a.id=d.actor_id
 where d.completed_at is null and (d.actor_id=auth.uid() or private.is_superadmin()) order by d.updated_at desc,d.id desc limit 50 offset p_offset)r);
end $$;
create function public.accounting_drafts(p_offset integer default 0) returns jsonb language sql security invoker set search_path='' as $$select private.accounting_drafts(p_offset)$$;
create function private.finish_accounting_draft(p_input jsonb) returns void
language plpgsql security invoker set search_path='' as $$
declare d private.accounting_drafts%rowtype;
begin
 if nullif(p_input->>'draftId','') is null then return; end if;
 select * into d from private.accounting_drafts where id=(p_input->>'draftId')::uuid for update;
 if not found or (d.actor_id<>auth.uid() and not private.is_superadmin()) then raise exception 'El borrador ya no está disponible.'; end if;
 if d.completed_at is not null or d.revision is distinct from (p_input->>'draftRevision')::integer then raise exception 'El borrador cambió. Revisa su versión actual antes de contabilizarlo.'; end if;
 update private.accounting_drafts set completed_at=now() where id=d.id;
end $$;
do $$ declare d text; begin
 d:=pg_get_functiondef('private.record_journal_entry(jsonb)'::regprocedure);
 d:=replace(d,'return v_id;','perform private.finish_accounting_draft(p_input); return v_id;');execute d;
 d:=pg_get_functiondef('private.correct_journal_entry(jsonb)'::regprocedure);
 d:=replace(d,'return a;','perform private.finish_accounting_draft(p_input); return a;');
 -- El comprobante de costo de una recepción se corrige desde su fuente, para
 -- mantener el valor y las cantidades sincronizados con el asiento.
 d:=replace(d,$needle$if e.kind='opening' then$needle$,$patch$if exists(select 1 from private.receipt_revisions where journal_entry_id=e.id) then raise exception 'Usa Editar recepción para corregir también las existencias y su valor.'; end if; if e.kind='opening' then$patch$);
 d:=replace(d,'perform private.validate_purchase_classification(pc.shipment_id,e.id) from private.purchase_classifications pc where pc.entry_id=e.id;',
 'if not exists(select 1 from private.purchase_classification_requests where actor_id=auth.uid() and transaction_id=txid_current()) then perform private.validate_purchase_classification(pc.shipment_id,e.id) from private.purchase_classifications pc where pc.entry_id=e.id; end if;');execute d;
end $$;

-- Reabrir la clasificación conserva su comprobante anulado y su historial.
alter function private.void_journal_entry(uuid,text) rename to void_journal_entry_before_classification;
create function private.void_journal_entry(p_id uuid,p_reason text) returns uuid
language plpgsql security definer set search_path='' as $$
declare e public.journal_entries%rowtype;b jsonb;change_id uuid;actor text;receipt uuid;
begin
 if auth.uid() is null or private.staff_role() is distinct from 'admin' then raise insufficient_privilege; end if;
 if exists(select 1 from private.receipt_revisions where journal_entry_id=p_id) then raise exception 'Usa Editar recepción para corregir este asiento con su inventario.'; end if;
 select shipment_id into receipt from private.purchase_classifications where entry_id=p_id;
 if receipt is null then return private.void_journal_entry_before_classification(p_id,p_reason); end if;
 if not private.is_superadmin() then raise insufficient_privilege; end if;
 perform pg_advisory_xact_lock(hashtextextended('lcp-business-day',0));
 perform pg_advisory_xact_lock(hashtextextended('finance-credit-ledger',0));
 select * into e from public.journal_entries where id=p_id for update;
 if e.voided_at is not null then return e.id; end if;
 if exists(select 1 from public.finance_entries where shipment_id=receipt and voided_at is null) then raise exception 'Esta compra tiene abonos. Corrige su clasificación conservando Proveedores o corrige primero los pagos vinculados.'; end if;
 if length(btrim(coalesce(p_reason,''))) not between 1 and 500 then raise exception 'Indica el motivo de la corrección.'; end if;
 b:=private.journal_snapshot(e.id);select display_name into actor from private.business_actors where id=auth.uid();
 insert into private.journal_corrections(entry_id,revision,request_id,request_payload,actor_id,actor_name,before_snapshot,after_snapshot,transaction_id)
 values(e.id,e.revision+1,gen_random_uuid(),jsonb_build_object('action','return_pending','reason',p_reason),auth.uid(),coalesce(actor,'SuperAdmin'),b,'{}',txid_current()) returning id into change_id;
 update public.journal_entries set voided_at=now(),voided_by=auth.uid(),void_reason=p_reason,revision=revision+1 where id=e.id;
 update private.journal_corrections set after_snapshot=private.journal_snapshot(e.id) where id=change_id;
 return e.id;
end $$;

do $$ declare d text; begin
 d:=pg_get_functiondef('private.classify_purchase(jsonb)'::regprocedure);
 d:=replace(d,'if pc.entry_id is null then','if pc.entry_id is null or exists(select 1 from public.journal_entries where id=pc.entry_id and voided_at is not null) then');
 d:=replace(d,'values(s.id,v_entry,auth.uid());','values(s.id,v_entry,auth.uid()) on conflict(shipment_id) do update set entry_id=excluded.entry_id;');
 d:=replace(d,'if d<s.incurred_on or d is null then', 'if d<(private.receipt_snapshot(s.id)->>''incurred_on'')::date or d is null then');
 execute d;
end $$;

-- Las correcciones aparecen como eventos en su fecha, con importes NIO
-- diferenciales. La compra original y las facturas emitidas quedan intactas.
do $$ declare d text; marker text:= '), page as(select event_row from events'; begin
 d:=pg_get_functiondef('private.purchase_report_events(date,date,integer,integer)'::regprocedure);
 if position(marker in d)=0 then raise exception 'No se encontró la página de eventos de compra esperada.'; end if;
 d:=replace(d,marker,$patch$
 union all select (r.created_at at time zone 'America/Managua')::date,r.id,
 jsonb_build_object('id',r.id,'request_id',r.request_id,'incurred_on',(r.created_at at time zone 'America/Managua')::date,
 'created_at',r.created_at,'supplier',r.after_snapshot->>'supplier','agency','','reference',r.after_snapshot->>'reference','note','Corrección de recepción',
 'currency','NIO','exchange_rate',1,'account','pending','event_kind','correction',
 'goods_amount',round((r.after_snapshot->>'goods_amount')::numeric*(r.after_snapshot->>'exchange_rate')::numeric,2)-round((r.before_snapshot->>'goods_amount')::numeric*(r.before_snapshot->>'exchange_rate')::numeric,2),
 'shipping_amount',round((r.after_snapshot->>'shipping_amount')::numeric*(r.after_snapshot->>'exchange_rate')::numeric,2)-round((r.before_snapshot->>'shipping_amount')::numeric*(r.before_snapshot->>'exchange_rate')::numeric,2),
 'goods_nio',round((r.after_snapshot->>'goods_amount')::numeric*(r.after_snapshot->>'exchange_rate')::numeric,2)-round((r.before_snapshot->>'goods_amount')::numeric*(r.before_snapshot->>'exchange_rate')::numeric,2),
 'shipping_nio',round((r.after_snapshot->>'shipping_amount')::numeric*(r.after_snapshot->>'exchange_rate')::numeric,2)-round((r.before_snapshot->>'shipping_amount')::numeric*(r.before_snapshot->>'exchange_rate')::numeric,2),
 'units',(r.after_snapshot->>'units')::integer-(r.before_snapshot->>'units')::integer,'shipping_per_unit',0,'purchase_shipment_lines','[]'::jsonb)
 from private.receipt_revisions r where (r.created_at at time zone 'America/Managua')::date between p_from and p_to
 ), page as(select event_row from events$patch$);
 execute d;
end $$;

alter function private.operation_confirmation(text,uuid,boolean) rename to operation_confirmation_before_accounting_drafts;
create function private.operation_confirmation(p_kind text,p_request_id uuid,p_retire boolean default false) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r jsonb;
begin
 if p_kind<>'accounting-draft' then return private.operation_confirmation_before_accounting_drafts(p_kind,p_request_id,p_retire); end if;
 if auth.uid() is null or private.staff_role() is distinct from 'admin' then raise insufficient_privilege; end if;
 perform pg_advisory_xact_lock(hashtextextended('lcp-business-day',0));
 select result into r from private.accounting_draft_requests where actor_id=auth.uid() and request_id=p_request_id;
 if r is not null then return jsonb_build_object('status','confirmed','id',r->'id'); end if;
 if p_retire then insert into private.retired_operations(actor_id,kind,request_id) values(auth.uid(),p_kind,p_request_id) on conflict do nothing; end if;
 if exists(select 1 from private.retired_operations where actor_id=auth.uid() and kind=p_kind and request_id=p_request_id) then return jsonb_build_object('status','retired'); end if;
 return jsonb_build_object('status','missing');
end $$;
create trigger retired_operation before insert on private.accounting_draft_requests for each row execute function private.prevent_retired_operation('accounting-draft','actor_id','request_id');
revoke all on function private.operation_confirmation(text,uuid,boolean),private.operation_confirmation_before_accounting_drafts(text,uuid,boolean),private.finish_accounting_draft(jsonb),private.void_journal_entry_before_classification(uuid,text) from public,anon,authenticated;
revoke all on function private.save_accounting_draft(jsonb),public.save_accounting_draft(jsonb),private.accounting_drafts(integer),public.accounting_drafts(integer),private.void_journal_entry(uuid,text) from public,anon;
grant execute on function private.save_accounting_draft(jsonb),public.save_accounting_draft(jsonb),private.accounting_drafts(integer),public.accounting_drafts(integer),private.void_journal_entry(uuid,text) to authenticated;
notify pgrst,'reload schema';
