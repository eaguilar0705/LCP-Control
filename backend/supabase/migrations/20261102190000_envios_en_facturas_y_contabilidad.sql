-- El envío cobrado al cliente forma parte del documento y del dinero recibido,
-- pero se registra separado de las ventas de perfumes. Pagar al transportista
-- es un gasto posterior: emitir una factura nunca supone que ya se pagó.
alter table public.documents
 add column shipping_method text check(shipping_method in ('moto','cargotrans','buses')),
 add column shipping_amount numeric(14,2) not null default 0 check(shipping_amount>=0 and shipping_amount<=10000000),
 add column shipping_nio numeric(24,2) not null default 0 check(shipping_nio>=0),
 add constraint documents_shipping_method_amount check(shipping_method is not null or shipping_amount=0);

insert into public.ledger_accounts(code,name,parent,bucket,nature,postable) values
 ('4120','Cobros por envío','4000','revenue','credit',true),
 ('5130-011','Envíos a clientes','5130','expense','debit',true);

-- Conservar las validaciones, bloqueos, descuentos e idempotencia del emisor
-- vigente. El total se completa antes del INSERT y de su control expectedTotal.
do $shipping_document$
declare definition text; marker text;
begin
 definition:=pg_get_functiondef('private.create_document(jsonb)'::regprocedure);
 marker:='v_catalog_rate numeric;';
 if position(marker in definition)=0 then raise exception 'No se encontró la declaración del emisor de documentos.'; end if;
 definition:=replace(definition,marker,marker||E'\n v_shipping numeric:=0; v_shipping_nio numeric:=0; v_shipping_method text;');
 marker:='select usd_to_nio into v_catalog_rate from public.exchange_rates where id;';
 if position(marker in definition)=0 then raise exception 'No se encontró la validación del emisor de documentos.'; end if;
 definition:=replace(definition,marker,marker||$validation$
 if p_payload ? 'shippingMethod' and jsonb_typeof(p_payload->'shippingMethod') not in ('string','null') then
  raise exception 'Selecciona un tipo de envío válido.';
 end if;
 v_shipping_method:=nullif(btrim(p_payload->>'shippingMethod'),'');
 if v_shipping_method is not null and v_shipping_method not in ('moto','cargotrans','buses') then
  raise exception 'Selecciona un tipo de envío válido.';
 end if;
 if p_payload ? 'shippingAmount' then v_shipping:=private.accounting_number(p_payload,'shippingAmount',10000000,2); end if;
 if v_shipping_method is null and v_shipping<>0 then raise exception 'Selecciona el tipo de envío para cobrarlo.'; end if;
 if v_shipping>0 then v_shipping_nio:=round(v_shipping*case when v_currency='NIO' then 1 else private.accounting_rate(p_payload) end,2); end if;
$validation$);
 marker:='v_total:=v_total-v_discount;';
 if position(marker in definition)=0 then raise exception 'No se encontró el total neto de productos.'; end if;
 definition:=replace(definition,marker,marker||E'\n v_total:=v_total+v_shipping;');
 marker:='created_by,original_total,discount_amount,invoice_discount)';
 if position(marker in definition)=0 then raise exception 'No se encontró la cabecera del documento.'; end if;
 definition:=replace(definition,marker,'created_by,original_total,discount_amount,invoice_discount,shipping_method,shipping_amount,shipping_nio)');
 marker:='v_uid,v_original,v_original-v_total,v_discount)';
 if position(marker in definition)=0 then raise exception 'No se encontraron los importes del documento.'; end if;
 definition:=replace(definition,marker,'v_uid,v_original,v_original-v_total+v_shipping,v_discount,v_shipping_method,v_shipping,v_shipping_nio)');
 execute definition;
end $shipping_document$;

-- La deuda, los cobros vinculados, POS y pagos divididos usan este mismo total
-- congelado. Una factura con datos históricos incompletos sigue siendo desconocida.
create or replace function private.credit_invoice_amount(p_id uuid) returns numeric
language sql stable security invoker set search_path='' as $$
 select case when count(i.id)>0 and count(c.document_item_id)=count(i.id)
  and bool_and(c.quantity=i.quantity and c.net_revenue_nio is not null and c.tax_nio is not null)
  then round(sum(c.net_revenue_nio+c.tax_nio),2)+(select d.shipping_nio from public.documents d where d.id=p_id) end
 from public.document_items i left join public.document_item_costs c
  on c.document_item_id=i.id and c.document_id=i.document_id and c.product_id=i.product_id
 where i.document_id=p_id
$$;
revoke all on function private.credit_invoice_amount(uuid) from public,anon,authenticated;

-- Los gastos de envío admiten caja o un banco concreto. Las solicitudes viejas
-- sin banco conservan la cuenta genérica; una selección explícita se valida.
alter table public.expense_records add column bank_ledger_account text references public.ledger_accounts(code);
create index expense_records_bank_account_idx on public.expense_records(bank_ledger_account) where bank_ledger_account is not null;
alter table public.expense_records drop constraint expense_records_category_check;
alter table public.expense_records add constraint expense_records_category_check check(category in (
 'impuestos_dgi','impuestos_alma','prestamo_acreedor','prestamo_bancario','interes_bancario','interes_acreedor',
 'renta','salario','papeleria','combustible','agua_luz','internet','limpieza','mobiliario','viatico','marketing','envios'));
create function private.expense_bank_from_request() returns trigger
language plpgsql security definer set search_path='' as $$
declare v_bank text:=nullif(new.request_payload->>'bankLedgerAccount','');
begin
 if v_bank is not null then
  if coalesce(nullif(new.request_payload->>'account',''),'caja')<>'banco' then
   raise exception 'El banco pagador solo corresponde a un gasto pagado por banco.';
  end if;
  if not exists(select 1 from public.ledger_accounts where code=v_bank and active and postable and
   ((new.currency='NIO' and code in ('1120-001','1120-003','1120-005')) or
    (new.currency='USD' and code in ('1120-002','1120-004','1120-006')))) then
   raise exception 'Selecciona BAC, LAFISE o Ficohsa en la moneda del gasto.';
  end if;
 end if;
 new.bank_ledger_account:=v_bank;
 return new;
end $$;
revoke all on function private.expense_bank_from_request() from public,anon,authenticated;
create trigger expense_bank_account before insert on public.expense_records for each row execute function private.expense_bank_from_request();

alter view private.operational_postings rename to operational_postings_before_shipping;
create view private.operational_postings as
 select o.day,o.source,o.source_id,
  case when o.source='expense' and o.debit>0 and e.category='envios' then '5130-011'
   when o.source='expense' and o.credit>0 and e.account='banco' then coalesce(e.bank_ledger_account,o.account)
   else o.account end account,o.debit,o.credit
 from private.operational_postings_before_shipping o left join public.expense_records e on o.source='expense' and e.id=o.source_id
 union all
 select (d.created_at at time zone 'America/Managua')::date,'sale',d.id,
  private.sale_ledger_account(d.payment_method,d.currency),d.shipping_nio,0::numeric
 from public.documents d where d.kind='invoice' and d.shipping_nio>0
  and not exists(select 1 from public.invoice_payments ip where ip.document_id=d.id)
 union all
 select (d.created_at at time zone 'America/Managua')::date,'sale',d.id,'4120',0::numeric,d.shipping_nio
 from public.documents d where d.kind='invoice' and d.shipping_nio>0;
revoke all on private.operational_postings,private.operational_postings_before_shipping from public,anon,authenticated;

-- Devolver perfumes conserva el envío cobrado; la nota de crédito revierte
-- solamente los renglones elegidos, sin volver a abonar al transportista.
-- Los informes muestran envío aparte del ingreso y margen de los productos.
do $shipping_reports$
declare definition text; marker text;
begin
 definition:=pg_get_functiondef('public.report_digest(date,date)'::regprocedure);
 marker:='''revenueNio'', coalesce(round(sum(f.net_revenue_nio) filter (where f.revenue_known), 2), 0),';
 if position(marker in definition)=0 then raise exception 'No se encontró el resumen contable de productos.'; end if;
 definition:=replace(definition,marker,marker||$total$
      'shippingNio', (select coalesce(sum(d.shipping_nio),0) from public.documents d
        where d.kind='invoice' and d.created_at>=v_from and d.created_at<v_until),
      'shippingExpenseNio', (select coalesce(sum(jl.debit_nio-jl.credit_nio),0)
        from public.journal_entries e join public.journal_lines jl on jl.entry_id=e.id
        where e.voided_at is null and e.occurred_on between p_from and p_to and jl.account='5130-011'),
$total$);
 marker:='''revenueNio'', coalesce(l.revenue, 0), ''salesTaxNio'', coalesce(l.tax, 0),';
 if position(marker in definition)=0 then raise exception 'No se encontró el resumen contable mensual.'; end if;
 definition:=replace(definition,marker,marker||$month$
                 'shippingNio', (select coalesce(sum(d.shipping_nio),0) from public.documents d
                   where d.kind='invoice' and d.created_at>=v_from and d.created_at<v_until
                    and to_char(d.created_at at time zone 'America/Managua','YYYY-MM')=coalesce(l.month,w.month)),
                 'shippingExpenseNio', coalesce(se.amount,0),
$month$);
 -- Un mes con un pago al transportista también aparece si no hubo facturas.
 -- Solo se incorporan comprobantes; expense_records se suma por separado en
 -- el navegador y volver a incluirlo aquí duplicaría el gasto de categoría envios.
 marker:='from month_lines l full join month_writeoffs w on w.month = l.month';
 if position(marker in definition)=0 then raise exception 'No se encontró el calendario contable mensual.'; end if;
 definition:=replace(definition,marker,marker||$expense_month$
        full join (select to_char(e.occurred_on,'YYYY-MM') as month,sum(jl.debit_nio-jl.credit_nio) amount
          from public.journal_entries e join public.journal_lines jl on jl.entry_id=e.id
          where e.voided_at is null and e.occurred_on between p_from and p_to and jl.account='5130-011'
          group by 1) se on se.month=coalesce(l.month,w.month)
$expense_month$);
 -- Los COALESCE anteriores al JOIN usan también el mes de los comprobantes.
 -- Conservar la condición del JOIN original, que todavía no incluye se.
 definition:=regexp_replace(definition,'coalesce\(l\.month,\s*w\.month\)', 'coalesce(l.month,w.month,se.month)','g');
 definition:=replace(definition,'se.month=coalesce(l.month,w.month,se.month)','se.month=coalesce(l.month,w.month)');
 execute definition;
end $shipping_reports$;

notify pgrst,'reload schema';
