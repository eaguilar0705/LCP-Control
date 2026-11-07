-- Una revisión de recepción pendiente usa Inventario como contrapartida de su
-- costo definitivo. Sus patas opuestas en la misma cuenta no son otra compra.
-- No se reescriben comprobantes, renglones, solicitudes ni historiales previos.

-- Las revisiones nuevas consolidan antes de guardar. Una corrección sin
-- efecto contable conserva su revisión de cantidades/costo, sin crear asiento.
do $new_receipt_postings$
declare definition text; marker text;
begin
 definition:=replace(pg_get_functiondef('private.revise_purchase_receipt(jsonb)'::regprocedure),E'\r\n',E'\n');
 marker:='from (values(''1130'',v_inventory_delta),(v_cost_account,v_remainder),(v_counterpart,-v_delta))p(account,amount) where amount<>0;';
 if position(marker in definition)=0 then raise exception 'Revisar la distribución contable de las correcciones de recepción.'; end if;
 definition:=replace(definition,marker,$replacement$
 from (select account,sum(amount) amount from
  (values('1130',v_inventory_delta),(v_cost_account,v_remainder),(v_counterpart,-v_delta))p(account,amount)
  group by account having sum(amount)<>0)p;
$replacement$);
 execute definition;
end $new_receipt_postings$;

-- La lectura del mayor consolida exclusivamente asientos generados por una
-- revisión. Comprobantes manuales, compras clasificadas y operaciones de otras
-- cuentas mantienen sus movimientos brutos y sus saldos originales.
create view private.receipt_normalized_journal_lines as
 select l.entry_id,l.line_no,l.account,l.debit_nio,l.credit_nio
 from public.journal_lines l
 where not exists(select 1 from private.receipt_revisions r where r.journal_entry_id=l.entry_id)
 union all
 select l.entry_id,min(l.line_no),l.account,
  greatest(sum(l.debit_nio-l.credit_nio),0),greatest(-sum(l.debit_nio-l.credit_nio),0)
 from public.journal_lines l
 where exists(select 1 from private.receipt_revisions r where r.journal_entry_id=l.entry_id)
 group by l.entry_id,l.account having sum(l.debit_nio-l.credit_nio)<>0;
revoke all on private.receipt_normalized_journal_lines from public,anon,authenticated;

create function private.receipt_posting_metadata(p_entry uuid) returns jsonb
language sql stable security invoker set search_path='' as $$
 select case when exists(select 1 from private.receipt_revisions where journal_entry_id=p_entry) then
  jsonb_build_object('receiptCorrection',true,
   'sourceReceiptId',(select shipment_id from private.receipt_revisions where journal_entry_id=p_entry limit 1),
   'receiptPostingNormalized',
    (select count(*) from public.journal_lines where entry_id=p_entry)<>
    (select count(*) from private.receipt_normalized_journal_lines where entry_id=p_entry),
   'receiptNoAccountingEffect',not exists(select 1 from private.receipt_normalized_journal_lines where entry_id=p_entry))
  else '{}'::jsonb end;
$$;
revoke all on function private.receipt_posting_metadata(uuid) from public,anon,authenticated;

do $receipt_ledger$
declare definition text; marker text;
begin
 definition:=pg_get_functiondef('private.ledger_report_before_fixed_purchase(date,date)'::regprocedure);
 marker:='from public.journal_entries e join public.journal_lines l on l.entry_id=e.id where e.voided_at is null and e.occurred_on<=p_to';
 if position(marker in definition)=0 then raise exception 'Revisar la lectura de comprobantes del mayor.'; end if;
 definition:=replace(definition,marker,'from public.journal_entries e join private.receipt_normalized_journal_lines l on l.entry_id=e.id where e.voided_at is null and e.occurred_on<=p_to');
 marker:='private.inventory_adjustment_journal_metadata(e.id)';
 if position(marker in definition)=0 then raise exception 'Revisar los metadatos de comprobantes del mayor.'; end if;
 definition:=replace(definition,marker,marker||'||private.receipt_posting_metadata(e.id)');
 execute definition;

 definition:=pg_get_functiondef('public.journal_entries_page(date,date,integer,integer,timestamptz,integer)'::regprocedure);
 if position(marker in definition)=0 then raise exception 'Revisar los metadatos de la lista de comprobantes.'; end if;
 definition:=replace(definition,marker,marker||'||private.receipt_posting_metadata(e.id)');
 execute definition;
end $receipt_ledger$;

-- El detalle presenta los importes netos y conserva los renglones históricos
-- para consultarlos. El PDF y la pantalla consumen el mismo detalle autorizado.
alter function private.get_journal_entry(uuid) rename to get_journal_entry_before_receipt_netting;
create function private.get_journal_entry(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb; metadata jsonb; lines jsonb;
begin
 result:=private.get_journal_entry_before_receipt_netting(p_id);
 metadata:=private.receipt_posting_metadata(p_id);
 if metadata->>'receiptPostingNormalized'='true' then
  select coalesce(jsonb_agg(jsonb_build_object(
   'entry_id',l.entry_id,'line_no',l.line_no,'account',l.account,'name',a.name,
   'displayAccount',coalesce(a.display_code,a.code),'currency','NIO','exchange_rate',1,
   'debit',l.debit_nio,'credit',l.credit_nio,'debit_nio',l.debit_nio,'credit_nio',l.credit_nio)
   order by l.line_no),'[]'::jsonb) into lines
  from private.receipt_normalized_journal_lines l join public.ledger_accounts a on a.code=l.account where l.entry_id=p_id;
  return result||metadata||jsonb_build_object('receiptOriginalLines',result->'lines','lines',lines);
 end if;
 return result||metadata;
end $$;
revoke all on function private.get_journal_entry_before_receipt_netting(uuid) from public,anon,authenticated;
revoke all on function private.get_journal_entry(uuid) from public,anon;
grant execute on function private.get_journal_entry(uuid) to authenticated;

notify pgrst,'reload schema';
