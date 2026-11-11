-- Consulta comercial por perfume. No modifica cantidades, costos ni asientos.
-- Las facturas corregidas se presentan una sola vez, con su versión vigente;
-- sus líneas retiradas y las facturas anuladas conservan el snapshot original.
create index document_deletions_product_history on private.document_deletions
 using gin ((snapshot->'items') jsonb_path_ops) where kind='invoice';
create index document_deletions_document_history on private.document_deletions
 (document_id,deleted_at desc,id desc) where kind='invoice';
create index invoice_corrections_product_history on private.invoice_corrections
 using gin ((before_snapshot->'items') jsonb_path_ops);

create function private.product_sales_history(
 p_product uuid,p_offset integer default 0,p_limit integer default 20,p_as_of timestamptz default null,
 p_expected_total bigint default null
) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare cutoff timestamptz:=coalesce(p_as_of,now()); result jsonb;
begin
 if auth.uid() is null or private.staff_role() is distinct from 'admin' then raise insufficient_privilege; end if;
 if p_product is null or not exists(select 1 from public.products where id=p_product) then
  raise exception 'No se encontró el perfume para consultar sus ventas.' using errcode='22023';
 end if;
 if p_offset is null or p_offset<0 or p_offset>1000000 or p_limit is null or p_limit<1 or p_limit>50 then
  raise exception 'Revisa la página del historial: el límite debe estar entre 1 y 50.' using errcode='22023';
 end if;
 if not isfinite(cutoff) or cutoff>now() then
  raise exception 'La fecha de corte del historial no puede ser futura ni infinita.' using errcode='22023';
 end if;
 if p_expected_total is not null and p_expected_total<0 then
  raise exception 'El total esperado del historial no puede ser negativo.' using errcode='22023';
 end if;
 -- El corte fija la fecha máxima de emisión durante la paginación. Las
 -- correcciones, devoluciones y anulaciones siguen mostrando su estado actual.
 -- Si una corrección incorpora este perfume a una factura ya emitida, el total
 -- esperado obliga a actualizar antes de continuar y desplazar páginas OFFSET.
 with live as (
  select d.id document_id,d.number,d.created_at,d.customer_id,d.customer_name,d.currency,d.location,
   i.quantity,round(i.line_total/i.quantity,6) unit_price,i.line_total,
   coalesce(i.original_unit_price,i.unit_price) original_unit_price,i.invoice_discount,d.revision,
   null::timestamptz cancelled_at,null::timestamptz removed_at,1 priority,false cancelled,false removed
  from public.document_items i join public.documents d on d.id=i.document_id
  where i.product_id=p_product and d.kind='invoice' and d.created_at<=cutoff
 ), cancelled_lines as (
  select x.document_id,x.number,(x.snapshot->>'created_at')::timestamptz created_at,
   (x.snapshot->>'customer_id')::uuid customer_id,x.snapshot->>'customer_name' customer_name,
   x.snapshot->>'currency' currency,x.snapshot->>'location' location,
   (i->>'quantity')::integer quantity,
   round((i->>'line_total')::numeric/(i->>'quantity')::integer,6) unit_price,
   (i->>'line_total')::numeric line_total,
   coalesce((i->>'original_unit_price')::numeric,(i->>'unit_price')::numeric) original_unit_price,
   coalesce((i->>'invoice_discount')::numeric,0) invoice_discount,
   coalesce((x.snapshot->>'revision')::integer,0) revision,
   x.deleted_at cancelled_at,null::timestamptz removed_at,2 priority,true cancelled,false removed
  from private.document_deletions x
  cross join lateral jsonb_array_elements(x.snapshot->'items') i
  where x.kind='invoice'
   and x.snapshot->'items' @> jsonb_build_array(jsonb_build_object('product_id',p_product))
   and i->>'product_id'=p_product::text and (x.snapshot->>'created_at')::timestamptz<=cutoff
   and not exists(select 1 from public.documents d where d.id=x.document_id)
 ), correction_versions as (
  select distinct on (c.document_id) c.document_id,c.before_snapshot snapshot,c.created_at removed_at
  from private.invoice_corrections c
  where c.before_snapshot->'items' @> jsonb_build_array(jsonb_build_object('product_id',p_product))
  order by c.document_id,c.revision desc,c.id desc
 ), last_removed as (
  select c.*,x.deleted_at cancelled_at from correction_versions c left join lateral (
   select x.deleted_at from private.document_deletions x
   where x.document_id=c.document_id and x.kind='invoice'
   order by x.deleted_at desc,x.id desc limit 1
  )x on true
  where exists(select 1 from public.documents d where d.id=c.document_id and d.kind='invoice')
   or x.deleted_at is not null
 ), removed_lines as (
  select x.document_id,x.snapshot->>'number' number,(x.snapshot->>'created_at')::timestamptz created_at,
   (x.snapshot->>'customer_id')::uuid customer_id,x.snapshot->>'customer_name' customer_name,
   x.snapshot->>'currency' currency,x.snapshot->>'location' location,
   (i->>'quantity')::integer quantity,
   round((i->>'line_total')::numeric/(i->>'quantity')::integer,6) unit_price,
   (i->>'line_total')::numeric line_total,
   coalesce((i->>'original_unit_price')::numeric,(i->>'unit_price')::numeric) original_unit_price,
   coalesce((i->>'invoice_discount')::numeric,0) invoice_discount,
   coalesce((x.snapshot->>'revision')::integer,0) revision,
   x.cancelled_at,x.removed_at,3 priority,false cancelled,true removed
  from last_removed x cross join lateral jsonb_array_elements(x.snapshot->'items') i
  where i->>'product_id'=p_product::text and (x.snapshot->>'created_at')::timestamptz<=cutoff
 ), candidates as (
  select * from live union all select * from cancelled_lines union all select * from removed_lines
 ), chosen as (
  select distinct on (document_id) * from candidates
  order by document_id,priority,cancelled_at desc nulls last
 ), history as materialized (
  select c.*,coalesce(r.quantity,0) returned_quantity,coalesce(r.amount,0) returned_amount,
   case when c.cancelled then 'cancelled' when c.removed then 'removed'
    when coalesce(r.quantity,0)>=c.quantity then 'returned'
    when coalesce(r.quantity,0)>0 then 'partially_returned' else 'issued' end status
  from chosen c left join lateral (
   select sum(l.quantity)::integer quantity,sum(l.amount) amount
   from public.sales_return_lines l join public.sales_returns r on r.id=l.return_id
   where l.product_id=p_product and r.document_id=c.document_id
  )r on true
 ), page as (
  select * from history order by created_at desc,document_id desc offset p_offset limit p_limit
 )
 select jsonb_build_object('productId',p_product,'asOf',cutoff,'offset',p_offset,'limit',p_limit,
  'total',(select count(*) from history),
  'rows',coalesce((select jsonb_agg(jsonb_build_object(
   'documentId',document_id,'number',number,'createdAt',created_at,'customerId',customer_id,
   'customerName',customer_name,'currency',currency,'location',location,'quantity',quantity,
   'unitPrice',unit_price,'lineTotal',line_total,'originalUnitPrice',original_unit_price,
   'invoiceDiscount',invoice_discount,'returnedQuantity',returned_quantity,'returnedAmount',returned_amount,
   'status',status,'revision',revision,'cancelledAt',cancelled_at,'removedAt',removed_at)
   order by created_at desc,document_id desc) from page),'[]'::jsonb)) into result;
 if p_expected_total is not null and p_expected_total<>(result->>'total')::bigint then
  raise exception 'El historial cambió mientras lo consultabas. Pulsa Actualizar ventas para volver al inicio.';
 end if;
 return result;
end $$;
revoke all on function private.product_sales_history(uuid,integer,integer,timestamptz,bigint) from public,anon,authenticated;
grant execute on function private.product_sales_history(uuid,integer,integer,timestamptz,bigint) to authenticated;

create function public.product_sales_history(
 p_product uuid,p_offset integer default 0,p_limit integer default 20,p_as_of timestamptz default null,
 p_expected_total bigint default null
) returns jsonb language sql stable security invoker set search_path='' as $$
 select private.product_sales_history(p_product,p_offset,p_limit,p_as_of,p_expected_total);
$$;
revoke all on function public.product_sales_history(uuid,integer,integer,timestamptz,bigint) from public,anon,authenticated;
grant execute on function public.product_sales_history(uuid,integer,integer,timestamptz,bigint) to authenticated;

notify pgrst,'reload schema';
