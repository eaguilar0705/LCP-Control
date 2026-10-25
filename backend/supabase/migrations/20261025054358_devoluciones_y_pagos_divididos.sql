-- Las facturas emitidas y sus cobros se conservan. Cada devolución tiene su
-- propia fecha, número, costo congelado, responsable y comprobante.
create table public.invoice_payments (
 document_id uuid not null references public.documents(id), line_no integer not null,
 method text not null, currency text not null check(currency in ('NIO','USD')),
 amount numeric(18,2) not null check(amount>0), exchange_rate numeric(14,6) not null check(exchange_rate>0),
 amount_nio numeric(18,2) not null check(amount_nio>0), rounding_nio numeric(18,2) not null default 0,
 amount_document numeric(18,2) not null default 0 check(amount_document>=0),
 primary key(document_id,line_no)
);
create table public.sales_returns (
 id uuid primary key default gen_random_uuid(), number bigint generated always as identity unique,
 document_id uuid not null references public.documents(id), occurred_on date not null,
 request_id uuid not null unique, request_payload jsonb not null,
 reason text not null check(length(btrim(reason)) between 1 and 500),
 currency text not null check(currency in ('NIO','USD')), exchange_rate numeric(14,6) not null,
 amount numeric(18,2) not null check(amount>0), amount_nio numeric(18,2) not null check(amount_nio>0),
 credit_reduction_nio numeric(18,2) not null check(credit_reduction_nio>=0),
 refund_nio numeric(18,2) not null check(refund_nio>=0), refund_account text references public.ledger_accounts(code),
 journal_entry_id uuid not null unique references public.journal_entries(id),
 created_by uuid not null references private.business_actors(id), created_at timestamptz not null default now(),
 check(credit_reduction_nio+refund_nio=amount_nio)
);
create index sales_returns_document on public.sales_returns(document_id,occurred_on);
create index sales_returns_created_by on public.sales_returns(created_by);
create index sales_returns_refund_account on public.sales_returns(refund_account);
create table public.sales_return_lines (
 return_id uuid not null references public.sales_returns(id), document_item_id uuid not null references public.document_items(id),
 product_id uuid not null references public.products(id), quantity integer not null check(quantity>0),
 description text not null, amount numeric(18,2) not null, amount_nio numeric(18,2) not null,
 cost_nio numeric(24,2) not null, restock boolean not null, tax_nio numeric(18,2) not null default 0,
 primary key(return_id,document_item_id)
);
create index sales_return_lines_item on public.sales_return_lines(document_item_id);
create index sales_return_lines_product on public.sales_return_lines(product_id);
alter table public.invoice_payments enable row level security;
alter table public.sales_returns enable row level security;
alter table public.sales_return_lines enable row level security;
revoke all on public.invoice_payments,public.sales_returns,public.sales_return_lines from public,anon,authenticated;
grant select on public.invoice_payments,public.sales_returns,public.sales_return_lines to authenticated;
create policy staff_read on public.invoice_payments for select to authenticated using(
 (select private.staff_role())='admin' or exists(select 1 from public.documents d where d.id=document_id and d.created_by=(select auth.uid()) and (select private.staff_role())='operator'));
create policy admin_read on public.sales_returns for select to authenticated using((select private.staff_role())='admin');
create policy admin_read on public.sales_return_lines for select to authenticated using((select private.staff_role())='admin');
create trigger business_day_guard before insert or update or delete on public.sales_returns for each row execute function private.guard_business_day();
create trigger retired_operation_guard before insert on public.sales_returns for each row execute function private.prevent_retired_operation('sales-return','created_by','request_id');
-- Una reducción histórica de C$0.01 puede redondearse a US$0.00. El lado NIO
-- sigue siendo positivo y de un solo signo. Los comprobantes manuales calculan
-- NIO desde el nominal y nunca pueden insertar este caso especial 0/0→positivo.
alter table public.journal_lines drop constraint journal_lines_check;
alter table public.journal_lines add constraint journal_lines_check check(
 (debit>0 and credit=0) or (credit>0 and debit=0) or
 (debit=0 and credit=0 and ((debit_nio>0 and credit_nio=0) or (credit_nio>0 and debit_nio=0)))
);

create or replace function public.create_document(p_payload jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare v_result jsonb;
begin
 perform pg_advisory_xact_lock(hashtextextended('lcp-business-day',0));
 v_result:=private.create_document(p_payload);
 if p_payload ? 'payments' then perform private.save_invoice_payments((v_result->>'id')::uuid,p_payload); end if;
 return v_result||case when p_payload ? 'payments' then jsonb_build_object('payments',p_payload->'payments') else '{}'::jsonb end;
end $$;
create function private.save_invoice_payments(p_document uuid,p_payload jsonb) returns void
language plpgsql security definer set search_path='' as $$
declare d public.documents%rowtype; p jsonb; n integer:=0; v_amount numeric; v_rate numeric; v_nio numeric; v_sum numeric:=0;
 v_expected numeric; v_document_rate numeric; v_difference numeric; v_last integer;
begin
 if auth.uid() is null or private.staff_role() not in ('admin','operator') then raise insufficient_privilege; end if;
 select * into d from public.documents where id=p_document for update;
 if d.created_by<>auth.uid() or d.request_payload<>p_payload then raise exception 'La solicitud de la factura cambió.'; end if;
 if exists(select 1 from public.invoice_payments where document_id=p_document) then return; end if;
 if d.kind<>'invoice' or d.payment_method='pending' or coalesce((p_payload->>'taxRate')::numeric,0)<>0
  or jsonb_typeof(p_payload->'payments') is distinct from 'array' or jsonb_array_length(p_payload->'payments') not between 2 and 10 then
  raise exception 'El pago dividido necesita entre 2 y 10 pagos y una factura de contado.';
 end if;
 v_document_rate:=case d.currency when 'NIO' then 1 else (d.request_payload->>'exchangeRate')::numeric end;
 v_expected:=private.credit_invoice_amount(d.id);
 for p in select value from jsonb_array_elements(p_payload->'payments') loop
  n:=n+1;
  if p->>'method' is null or p->>'method' not in ('cash','card_pos','bank_transfer','bac_nio','bac_usd','lafise_nio','lafise_usd','ficohsa_nio','ficohsa_usd')
   or p->>'currency' is null or p->>'currency' not in ('NIO','USD') then raise exception 'Selecciona un método y moneda para cada pago.'; end if;
  v_amount:=private.accounting_number(p,'amount',100000000,2);
  v_rate:=private.accounting_number(p,'exchangeRate',1000000,6);
  if v_amount<=0 or v_rate<=0 or (p->>'currency'='NIO' and v_rate<>1) then raise exception 'Revisa el importe y el tipo de cambio de cada pago.'; end if;
  if (p->>'method' in ('bac_nio','lafise_nio','ficohsa_nio') and p->>'currency'<>'NIO') or
     (p->>'method' in ('bac_usd','lafise_usd','ficohsa_usd') and p->>'currency'<>'USD') then raise exception 'La moneda del pago debe coincidir con la cuenta bancaria.'; end if;
  v_nio:=round(v_amount*v_rate,2);
  if v_nio<=0 then raise exception 'Cada pago debe equivaler al menos a un centavo.'; end if;
  insert into public.invoice_payments values(d.id,n,p->>'method',p->>'currency',v_amount,v_rate,v_nio,0,0);
  v_sum:=v_sum+v_nio;
 end loop;
 if d.payment_method is distinct from p_payload->'payments'->0->>'method' then raise exception 'El método principal debe coincidir con el primer pago.'; end if;
 if round(v_sum/v_document_rate,2)<>d.total then raise exception 'Los pagos deben completar exactamente el total de la factura.'; end if;
 v_difference:=v_expected-v_sum;
 if abs(v_difference)>0.01*greatest(2,(select count(*) from public.document_items where document_id=d.id)) then raise exception 'La conversión de pagos no coincide con la venta.'; end if;
 select line_no into v_last from public.invoice_payments where document_id=d.id order by amount_nio desc,line_no limit 1;
 update public.invoice_payments set amount_nio=amount_nio+v_difference,rounding_nio=v_difference where document_id=d.id and line_no=v_last;
 update public.invoice_payments set amount_document=round(amount_nio/v_document_rate,2) where document_id=d.id;
 update public.invoice_payments set amount_document=amount_document+d.total-(select sum(amount_document) from public.invoice_payments where document_id=d.id) where document_id=d.id and line_no=v_last;
end $$;
revoke all on function private.save_invoice_payments(uuid,jsonb) from public,anon;
grant execute on function private.save_invoice_payments(uuid,jsonb) to authenticated;

-- La copia conserva todos los eventos, incluido el total de costo reconocido.
alter view private.operational_postings rename to operational_postings_before_split;
revoke all on private.operational_postings_before_split from public,anon,authenticated;
create or replace view private.operational_postings as
 select p.* from private.operational_postings_before_split p
 where not (p.source='sale' and exists(select 1 from public.invoice_payments ip where ip.document_id=p.source_id)
  and exists(select 1 from public.documents d where d.id=p.source_id and p.account=private.sale_ledger_account(d.payment_method,d.currency)))
 union all
 select (d.created_at at time zone 'America/Managua')::date,'sale',d.id,private.sale_ledger_account(p.method,p.currency),p.amount_nio,0::numeric
 from public.invoice_payments p join public.documents d on d.id=p.document_id;

-- Caja conserva la moneda física de cada tramo. Los comprobantes de NC se
-- incorporan por business_day_report, igual que los demás comprobantes.
do $migration$
declare s text; a text:='select currency,total amount from sales where payment_method=''cash'' and created_at>=(select opened_at from start)';
 b text:='select currency,total amount from sales where payment_method=''cash'' and created_at>=(select opened_at from start) and not exists(select 1 from public.invoice_payments ip where ip.document_id=sales.id)
 union all select ip.currency,ip.amount from public.invoice_payments ip join sales s on s.id=ip.document_id where ip.method=''cash'' and s.created_at>=(select opened_at from start)';
begin
 s:=replace(pg_get_functiondef('private.business_day_operational_report(date)'::regprocedure),chr(13),'');
 if position(a in s)=0 then raise exception 'No se encontró el cálculo de caja esperado.'; end if;
 s:=replace(s,a,b);
 s:=replace(s,'select payment_method,currency,count(*) invoices,sum(total) amount,sum(units) units
  from sales group by payment_method,currency',
  'select method payment_method,currency,count(*) invoices,sum(amount) amount,sum(units) units from (
   select payment_method method,currency,total amount,units from sales where not exists(select 1 from public.invoice_payments ip where ip.document_id=sales.id)
   union all select ip.method,ip.currency,ip.amount,0 from public.invoice_payments ip join sales s on s.id=ip.document_id
  ) p group by method,currency');
 execute s;
 s:=pg_get_functiondef('private.cashflow_rows(date,date)'::regprocedure);
 a:='from public.documents d where d.kind=''invoice'' and d.payment_method not in (''pending'',''card_pos'')';
 if position(a in s)=0 then raise exception 'No se encontró el flujo de caja esperado.'; end if;
 s:=replace(s,a,a||' and not exists(select 1 from public.invoice_payments ip where ip.document_id=d.id)');
 a:='select s.day,s.account,''sales''::text,coalesce(s.amount,0),0::numeric,';
 b:='select (d.created_at at time zone ''America/Managua'')::date,case when ip.method=''cash'' then ''caja'' else ''banco'' end,''sales''::text,ip.amount_nio,0::numeric,0::bigint
 from public.invoice_payments ip join public.documents d on d.id=ip.document_id where ip.method<>''card_pos'' and (d.created_at at time zone ''America/Managua'')::date between p_from and p_to
 union all '||a;
 if position(a in s)=0 then raise exception 'No se encontró la salida del flujo de caja esperada.'; end if;
 execute replace(s,a,b);
end $migration$;

create function private.invoice_return_detail(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare d public.documents%rowtype; v_result jsonb;
begin
 if auth.uid() is null or private.staff_role() is distinct from 'admin' then raise insufficient_privilege; end if;
 select * into d from public.documents where id=p_id and kind='invoice';
 if not found then raise exception 'La factura no existe.'; end if;
 select jsonb_build_object('documentId',d.id,'number',d.number,'currency',d.currency,'exchangeRate',case d.currency when 'NIO' then 1 else (d.request_payload->>'exchangeRate')::numeric end,
 'items',coalesce((select jsonb_agg(jsonb_build_object('id',i.id,'description',i.description,'quantity',i.quantity,'returned',coalesce(r.quantity,0),'unitPrice',i.unit_price) order by i.description)
 from public.document_items i left join (select l.document_item_id,sum(l.quantity) quantity from public.sales_return_lines l group by l.document_item_id) r on r.document_item_id=i.id where i.document_id=d.id),'[]'::jsonb),
 'returns',coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'number','NC-'||lpad(r.number::text,6,'0'),'date',r.occurred_on,'reason',r.reason,'amount',r.amount,'creditReductionNio',r.credit_reduction_nio,'refundNio',r.refund_nio,'journalEntryId',r.journal_entry_id) order by r.number) from public.sales_returns r where r.document_id=d.id),'[]'::jsonb)) into v_result;
 return v_result;
end $$;
create function public.invoice_return_detail(p_id uuid) returns jsonb language sql stable security invoker set search_path='' as $$select private.invoice_return_detail(p_id)$$;

create function private.record_sales_return(p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare d public.documents%rowtype; old_return public.sales_returns%rowtype;
 v_request uuid:=(p_input->>'requestId')::uuid; v_id uuid:=gen_random_uuid(); v_journal uuid:=gen_random_uuid();
 v_day date:=(now() at time zone 'America/Managua')::date; v_reason text:=btrim(coalesce(p_input->>'reason',''));
 p jsonb; i record; v_quantity integer; v_returned integer; v_amount numeric:=0; v_nio numeric:=0; v_cost numeric:=0;
 v_line_amount numeric; v_line_nio numeric; v_line_cost numeric; v_restock boolean; v_tax numeric:=0; v_line_tax numeric;
 v_paid numeric:=0; v_already numeric:=0; v_owed numeric:=0; v_reduce numeric:=0; v_refund numeric:=0;
 v_account text; v_rate numeric; v_number bigint; v_before integer; v_total integer; v_average numeric;
 v_lines jsonb:='[]'; v_line jsonb; v_index integer:=0; v_native_debit numeric:=0; v_native_credit numeric:=0;
begin
 if auth.uid() is null or private.staff_role() is distinct from 'admin' then raise insufficient_privilege; end if;
 if v_request is null then raise exception 'Falta el identificador de la devolución.'; end if;
 perform pg_advisory_xact_lock(hashtextextended('lcp-business-day',0));
 perform pg_advisory_xact_lock(hashtextextended('sales-return:'||v_request::text,0));
 select * into old_return from public.sales_returns where request_id=v_request;
 if found then
  if old_return.created_by<>auth.uid() or old_return.request_payload<>p_input then raise exception 'La devolución ya existe con otros datos.'; end if;
  return jsonb_build_object('id',old_return.id,'number','NC-'||lpad(old_return.number::text,6,'0'),'amount',old_return.amount,'refundNio',old_return.refund_nio,'creditReductionNio',old_return.credit_reduction_nio);
 end if;
 if not exists(select 1 from public.business_days where day=v_day and closed_at is null) then raise exception 'Abre la jornada actual para registrar la devolución.'; end if;
 if length(v_reason) not between 1 and 500 then raise exception 'Indica el motivo de la devolución.'; end if;
 if jsonb_typeof(p_input->'items') is distinct from 'array' or jsonb_array_length(p_input->'items') not between 1 and 100 then raise exception 'Selecciona los productos que se devuelven.'; end if;
 perform pg_advisory_xact_lock(hashtextextended('finance-credit-ledger',0));
 select * into d from public.documents where id=(p_input->>'documentId')::uuid and kind='invoice' for update;
 if not found then raise exception 'La factura no existe.'; end if;
 v_rate:=case d.currency when 'NIO' then 1 else (d.request_payload->>'exchangeRate')::numeric end;
 perform private.set_cost_cause(jsonb_build_object('kind','invoice_return','reference',d.number));
 if v_rate is null or private.credit_invoice_amount(d.id) is null then raise exception 'Completa el tipo de cambio y los costos históricos de la factura antes de devolverla.'; end if;
 if exists(select 1 from jsonb_array_elements(p_input->'items') item_json(value) group by item_json.value->>'itemId' having count(*)>1) then raise exception 'No repitas un producto en la devolución.'; end if;
 -- Orden global de productos y existencias, igual que en ventas y compras.
 perform 1 from public.products where id in(select di.product_id from public.document_items di join jsonb_array_elements(p_input->'items') item_json(value) on di.id=(item_json.value->>'itemId')::uuid where di.document_id=d.id) order by id for update;
 for p in select value from jsonb_array_elements(p_input->'items') order by value->>'itemId' loop
  select di.*,c.quantity cost_quantity,c.unit_cost_nio,c.net_revenue_nio,c.tax_nio,
   coalesce(c.total_cost_nio,round(c.quantity*c.unit_cost_nio,2)) historical_cost into i
   from public.document_items di join public.document_item_costs c on c.document_item_id=di.id
   where di.id=(p->>'itemId')::uuid and di.document_id=d.id;
  if not found or i.unit_cost_nio is null or i.cost_quantity<>i.quantity or i.net_revenue_nio is null or i.tax_nio is null then raise exception 'El producto no tiene un registro contable histórico completo.'; end if;
  v_quantity:=private.accounting_number(p,'quantity',9999,0);
  select coalesce(sum(quantity),0),coalesce(sum(amount_nio),0),coalesce(sum(cost_nio),0),coalesce(sum(tax_nio),0) into v_returned,v_line_nio,v_line_cost,v_line_tax from public.sales_return_lines where document_item_id=i.id;
  if v_quantity<=0 or v_quantity>i.quantity-v_returned then raise exception 'La cantidad supera lo pendiente de devolver de %.',i.description; end if;
  v_line_amount:=round((v_returned+v_quantity)*i.unit_price,2)-round(v_returned*i.unit_price,2);
  -- Diferencias acumuladas: la última fracción devuelve exactamente el total congelado.
  v_line_nio:=round((i.net_revenue_nio+i.tax_nio)*(v_returned+v_quantity)/i.quantity,2)-v_line_nio;
  v_line_tax:=round(i.tax_nio*(v_returned+v_quantity)/i.quantity,2)-v_line_tax;
  v_line_cost:=round(i.historical_cost*(v_returned+v_quantity)/i.quantity,2)-v_line_cost;
  v_restock:=coalesce((p->>'restock')::boolean,true);
  if v_restock then
   perform 1 from public.inventory_balances where product_id=i.product_id order by location for update;
   select quantity into v_before from public.inventory_balances where product_id=i.product_id and location=d.location;
   if v_before is null then raise exception 'Registra el conteo de % antes de devolverlo al inventario.',i.description; end if;
   select sum(quantity) into v_total from public.inventory_balances where product_id=i.product_id;
   select average_cost_nio into v_average from public.product_costs where product_id=i.product_id for update;
   perform private.receive_inventory_value(i.product_id,v_quantity,v_line_cost,v_total,v_average);
   update public.inventory_balances set quantity=v_before+v_quantity,updated_at=now() where product_id=i.product_id and location=d.location;
   insert into public.inventory_movements(product_id,location,type,quantity,before_quantity,after_quantity,actor_id,reference,note,is_invoice_reversal)
   values(i.product_id,d.location,'ADJUSTMENT',v_quantity,v_before,v_before+v_quantity,auth.uid(),d.number,'Devolución: '||v_reason,true);
  end if;
  v_amount:=v_amount+v_line_amount; v_nio:=v_nio+v_line_nio; v_cost:=v_cost+v_line_cost; v_tax:=v_tax+v_line_tax;
  v_lines:=v_lines||jsonb_build_array(jsonb_build_object('itemId',i.id,'productId',i.product_id,'description',i.description,'quantity',v_quantity,'amount',v_line_amount,'amountNio',v_line_nio,'costNio',v_line_cost,'restock',v_restock,'taxNio',v_line_tax));
 end loop;
 if d.payment_method='pending' then
  select coalesce(sum(round(amount*exchange_rate,2)),0) into v_paid from public.finance_entries where document_id=d.id and voided_at is null;
  select coalesce(sum(credit_reduction_nio),0) into v_already from public.sales_returns where document_id=d.id;
  v_owed:=greatest(0,private.credit_invoice_amount(d.id)-v_paid-v_already);
  v_reduce:=least(v_owed,v_nio);
 end if;
 v_refund:=v_nio-v_reduce;
 if v_refund>0 then
  if p_input->>'refundMethod' is null or p_input->>'refundMethod' not in ('cash','bac_nio','bac_usd','lafise_nio','lafise_usd','ficohsa_nio','ficohsa_usd') then raise exception 'Selecciona de dónde se devuelve el dinero cobrado.'; end if;
  v_account:=private.sale_ledger_account(p_input->>'refundMethod',d.currency);
  if (v_account in ('1120-001','1120-003','1120-005') and d.currency<>'NIO') or (v_account in ('1120-002','1120-004','1120-006') and d.currency<>'USD') then raise exception 'Selecciona una cuenta en la moneda de la factura.'; end if;
 end if;
 -- Las notas de crédito no se pueden borrar ni anular como ajustes manuales.
 insert into public.journal_entries(id,occurred_on,kind,description,reference,currency,exchange_rate,request_id,request_payload,created_by)
 values(v_journal,v_day,'adjustment','Devolución de '||d.number,d.number,d.currency,v_rate,v_request,p_input,auth.uid());
 insert into public.sales_returns(id,document_id,occurred_on,request_id,request_payload,reason,currency,exchange_rate,amount,amount_nio,credit_reduction_nio,refund_nio,refund_account,journal_entry_id,created_by)
 values(v_id,d.id,v_day,v_request,p_input,v_reason,d.currency,v_rate,v_amount,v_nio,v_reduce,v_refund,v_account,v_journal,auth.uid()) returning number into v_number;
 update public.journal_entries set reference='NC-'||lpad(v_number::text,6,'0')||' / '||d.number where id=v_journal;
 for v_line in select value from jsonb_array_elements(v_lines) loop
  insert into public.sales_return_lines values(v_id,(v_line->>'itemId')::uuid,(v_line->>'productId')::uuid,(v_line->>'quantity')::integer,v_line->>'description',(v_line->>'amount')::numeric,(v_line->>'amountNio')::numeric,(v_line->>'costNio')::numeric,(v_line->>'restock')::boolean,(v_line->>'taxNio')::numeric);
 end loop;
 -- NIO conserva la venta y costo históricos. La moneda original se muestra en
 -- el comprobante; su centavo de conversión se asigna al primer débito nominal.
 v_lines:=jsonb_build_array(jsonb_build_object('account','4110','debit',v_nio-v_tax,'credit',0));
 if v_tax>0 then v_lines:=v_lines||jsonb_build_array(jsonb_build_object('account','2116','debit',v_tax,'credit',0)); end if;
 if v_reduce>0 then v_lines:=v_lines||jsonb_build_array(jsonb_build_object('account','1140','debit',0,'credit',v_reduce)); end if;
 if v_refund>0 then v_lines:=v_lines||jsonb_build_array(jsonb_build_object('account',v_account,'debit',0,'credit',v_refund)); end if;
 for i in select case when restock then '1130' else '5150' end account,sum(cost_nio) amount from public.sales_return_lines where return_id=v_id group by restock loop
  if i.amount>0 then v_lines:=v_lines||jsonb_build_array(jsonb_build_object('account',i.account,'debit',i.amount,'credit',0)); end if;
 end loop;
 if v_cost>0 then v_lines:=v_lines||jsonb_build_array(jsonb_build_object('account','5120','debit',0,'credit',v_cost)); end if;
 for v_line in select value from jsonb_array_elements(v_lines) loop
  v_index:=v_index+1;
  insert into public.journal_lines values(v_journal,v_index,v_line->>'account',round((v_line->>'debit')::numeric/v_rate,2),round((v_line->>'credit')::numeric/v_rate,2),(v_line->>'debit')::numeric,(v_line->>'credit')::numeric);
 end loop;
 select sum(debit),sum(credit) into v_native_debit,v_native_credit from public.journal_lines where entry_id=v_journal;
 update public.journal_lines set debit=debit+v_native_credit-v_native_debit where entry_id=v_journal and line_no=1;
 if (select sum(debit_nio-credit_nio) from public.journal_lines where entry_id=v_journal)<>0 then raise exception 'La devolución no cuadra en contabilidad.'; end if;
 return jsonb_build_object('id',v_id,'number','NC-'||lpad(v_number::text,6,'0'),'amount',v_amount,'refundNio',v_refund,'creditReductionNio',v_reduce);
end $$;
create function public.record_sales_return(p_input jsonb) returns jsonb language sql security invoker set search_path='' as $$select private.record_sales_return(p_input)$$;
revoke all on function private.invoice_return_detail(uuid),public.invoice_return_detail(uuid),private.record_sales_return(jsonb),public.record_sales_return(jsonb) from public,anon;
grant execute on function private.invoice_return_detail(uuid),public.invoice_return_detail(uuid),private.record_sales_return(jsonb),public.record_sales_return(jsonb) to authenticated;

-- Las reducciones de una factura no pertenecen al saldo inicial sin asignar.
do $migration$
declare s text;
begin
 s:=pg_get_functiondef('private.credit_opening(date)'::regprocedure);
 s:=replace(s,'left join public.journal_lines l on l.entry_id=e.id','left join public.journal_lines l on l.entry_id=e.id and not exists(select 1 from public.sales_returns r where r.journal_entry_id=e.id)');
 execute s;
 s:=pg_get_functiondef('private.check_credit_pool()'::regprocedure);
 s:=replace(s,'where e.voided_at is null and e.occurred_on>=v_start and l.account', 'where e.voided_at is null and not exists(select 1 from public.sales_returns r where r.journal_entry_id=e.id) and e.occurred_on>=v_start and l.account');
 execute s;
 s:=pg_get_functiondef('private.credit_accounts(date)'::regprocedure);
 s:=replace(s,'private.credit_invoice_amount(d.id) as original','private.credit_invoice_amount(d.id)-(select coalesce(sum(r.credit_reduction_nio),0) from public.sales_returns r where r.document_id=d.id and r.occurred_on<=p_at) as original');
 execute s;
 s:=pg_get_functiondef('private.record_finance_entry(jsonb)'::regprocedure);
 s:=replace(s,'v_original:=private.credit_invoice_amount(v_document);','v_original:=private.credit_invoice_amount(v_document)-(select coalesce(sum(credit_reduction_nio),0) from public.sales_returns where document_id=v_document);');
 execute s;
 s:=pg_get_functiondef('private.void_journal_entry(uuid,text)'::regprocedure);
 s:=replace(s,'begin','begin'||chr(10)||' if exists(select 1 from public.sales_returns where journal_entry_id=p_id) then raise exception ''Las notas de crédito conservan su historial; no se anulan como un ajuste manual.''; end if;');
 execute s;
end $migration$;
create function private.guard_returned_invoice() returns trigger language plpgsql security definer set search_path='' as $$
declare v_document uuid:=case when tg_table_name='document_items' then (to_jsonb(old)->>'document_id')::uuid else (to_jsonb(old)->>'id')::uuid end;
begin
 if exists(select 1 from public.sales_returns where document_id=v_document) or exists(select 1 from public.invoice_payments where document_id=v_document) then
  raise exception 'La factura conserva pagos o notas de crédito. Utiliza Devolución.';
 end if;
 return old;
end $$;
revoke all on function private.guard_returned_invoice() from public,anon,authenticated;
create trigger preserve_returned_invoice before delete on public.documents for each row execute function private.guard_returned_invoice();
create trigger preserve_returned_invoice_item before delete on public.document_items for each row execute function private.guard_returned_invoice();
alter function private.business_day_operational_report(date) rename to business_day_operational_report_before_returns;
create function private.business_day_operational_report(p_day date) returns jsonb
language sql stable security definer set search_path='' as $$
 select private.business_day_operational_report_before_returns(p_day)||jsonb_build_object(
  'returnsCount',(select count(*) from public.sales_returns where occurred_on=p_day),
  'returnedUnits',(select coalesce(sum(l.quantity),0) from public.sales_return_lines l join public.sales_returns r on r.id=l.return_id where r.occurred_on=p_day),
  'returnedNio',(select coalesce(sum(amount_nio),0) from public.sales_returns where occurred_on=p_day),
  'netSalesNio',(select coalesce(sum(private.credit_invoice_amount(id)),0) from public.documents where kind='invoice' and (created_at at time zone 'America/Managua')::date=p_day)
   -(select coalesce(sum(amount_nio),0) from public.sales_returns where occurred_on=p_day));
$$;
revoke all on function private.business_day_operational_report(date),private.business_day_operational_report_before_returns(date) from public,anon,authenticated;
-- Reportes: las NC son eventos negativos en su fecha; no cuentan como nuevas
-- facturas ni visitas. El costo del estado de resultados es el mismo del mayor.
do $migration$
declare s text; a text; b text;
begin
 s:=replace(pg_get_functiondef('public.report_digest(date,date)'::regprocedure),chr(13),'');
 s:=replace(s,'d.created_at >= v_from as in_period','d.created_at >= v_from as in_period, false as is_return');
 a:='where d.created_at >= v_window and d.created_at < v_until';
 b:=a||'
    union all select r.id,''invoice'',d.currency,-r.amount,d.tier_code,''credit_note'',d.customer_id,d.customer_name,r.created_at,r.occurred_on,r.created_at>=v_from,true
    from public.sales_returns r join public.documents d on d.id=r.document_id where r.created_at>=v_window and r.created_at<v_until';
 s:=replace(s,a,b);
 a:='inv as (select * from docs where kind = ''invoice''),';
 b:=a||'
  payment_events as (
   select d.id,d.currency,d.in_period,d.is_return,d.payment_method,d.total from inv d where d.is_return or not exists(select 1 from public.invoice_payments ip where ip.document_id=d.id)
   union all select d.id,d.currency,d.in_period,false,ip.method,ip.amount_document from inv d join public.invoice_payments ip on ip.document_id=d.id
  ),';
 if position(a in s)=0 then raise exception 'No se encontró el resumen de ventas esperado.'; end if;
 s:=replace(s,a,b);
 a:='from inv d join public.document_items i on i.document_id = d.id';
 b:=a||'
    union all select r.id,l.product_id,l.description,-l.quantity,-l.amount,d.currency,r.created_at>=v_from,r.created_at
    from public.sales_return_lines l join public.sales_returns r on r.id=l.return_id join public.documents d on d.id=r.document_id where r.created_at>=v_window and r.created_at<v_until';
 s:=replace(s,a,b);
 s:=replace(s,'count(*) as count','count(*) filter(where not is_return) as count');
 s:=replace(s,'count(distinct d.customer_id) as customers','count(distinct d.customer_id) filter(where not d.is_return) as customers');
 s:=replace(s,'count(*) as orders','count(*) filter(where not is_return) as orders');
 s:=replace(s,'max(d.local_day) as last_purchase','max(d.local_day) filter(where not d.is_return) as last_purchase');
 s:=replace(s,'group by d.currency, d.customer_id','group by d.currency, d.customer_id having count(*) filter(where not d.is_return)>0');
 s:=replace(s,'from inv d
    group by d.currency, d.customer_id','from inv d where not d.is_return
    group by d.currency, d.customer_id');
 s:=replace(s,'from inv where in_period group by currency, customer_id','from inv where in_period and not is_return group by currency, customer_id');
 a:='select coalesce(payment_method, ''pending'') as key, round(sum(total), 2) as value, count(*) filter(where not is_return) as count
            from inv where in_period and currency = c.code group by 1';
 b:='select coalesce(payment_method, ''pending'') as key, round(sum(total), 2) as value, count(distinct id) filter(where not is_return) as count
            from payment_events where in_period and currency = c.code group by 1';
 if position(a in s)=0 then raise exception 'No se encontró el desglose de pagos esperado.'; end if;
 s:=replace(s,a,b);
 -- Se añaden después de validar los renglones originales: un importe negativo
 -- de NC conocido no se debe clasificar como costo/ingreso desconocido.
 s:=replace(s,'flagged as (','original_flagged as (');
 a:=chr(10)||'    writeoffs as (';
 b:=chr(10)||'    flagged as (
     select * from original_flagged
     union all select r.document_id,''NC-''||lpad(r.number::text,6,''0''),r.created_at,d.tier_code,r.occurred_on,l.product_id,l.description,-l.quantity,0::numeric,-l.cost_nio,-(l.amount_nio-l.tax_nio),-l.tax_nio,true,true,true,-l.cost_nio
     from public.sales_return_lines l join public.sales_returns r on r.id=l.return_id join public.documents d on d.id=r.document_id where r.created_at>=v_from and r.created_at<v_until
    ), writeoffs as (
     select r.occurred_on local_day,l.cost_nio cost,0::numeric missing from public.sales_return_lines l join public.sales_returns r on r.id=l.return_id where not l.restock and r.created_at>=v_from and r.created_at<v_until
     union all ';
 if position(a in s)=0 then raise exception 'No se encontró el costo de ventas esperado.'; end if;
 s:=replace(s,a,b);
 a:='select document_id, number, created_at, product_id, description, quantity,
             net_revenue_nio as net, cost, cost - net_revenue_nio as loss
      from flagged
      where cost is not null and net_revenue_nio is not null and net_revenue_nio >= 0
        and cost > net_revenue_nio';
 b:='select document_id,(array_agg(number order by created_at,number))[1] number,min(created_at) created_at,product_id,
             (array_agg(description order by created_at,number))[1] description,sum(quantity) quantity,
             sum(net_revenue_nio) net,sum(cost) cost,sum(cost-net_revenue_nio) loss
      from flagged group by document_id,product_id
      having bool_and(cost_known and revenue_known) and sum(quantity)>0 and sum(net_revenue_nio)>=0 and sum(cost)>sum(net_revenue_nio)';
 if position(a in s)=0 then raise exception 'No se encontró el análisis de ventas bajo costo esperado.'; end if;
 s:=replace(s,a,b);
 execute s;
end $migration$;
notify pgrst,'reload schema';
