-- Reportes calculados en la base de datos.
--
-- Antes el navegador descargaba cada factura del periodo y del periodo anterior
-- (para comparar), con sus renglones, sus costos congelados y los movimientos
-- de inventario, y lo sumaba todo allí. Con un año de ventas eran decenas de
-- miles de filas y la lectura se cortaba en 20 000. `report_digest` devuelve lo
-- mismo ya sumado. Su tamaño depende de cuántos productos y clientes distintos
-- aparecen (las listas de clientes llegan a 200 por moneda), no de cuántas
-- facturas tenga el periodo.
--
-- * SECURITY INVOKER: corre con los permisos de quien consulta, así que RLS
--   decide qué ve cada rol, igual que al leer las tablas (ventas sólo ve sus
--   documentos; el libro contable sólo lo recibe administración).
-- * Días de Managua: UTC-6 fijo, sin horario de verano, como en la aplicación.
-- * El cálculo de referencia vive en src/features/reports/digest.ts y
--   accounting.ts. tests/unit/database/reportDigest.test.ts carga estas mismas
--   migraciones en un PostgreSQL desechable y comprueba, con datos aleatorios,
--   que la base y la aplicación den las mismas cifras.

create index if not exists documents_created_idx on public.documents(created_at);
create index if not exists inventory_movements_created_idx on public.inventory_movements(created_at);

create or replace function public.report_digest(p_from date, p_to date)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_role text := private.staff_role();
  v_days integer;
  v_window timestamptz;
  v_from timestamptz;
  v_until timestamptz;
  v_sales jsonb;
  v_movements jsonb;
  v_ledger jsonb;
begin
  if v_role is null then
    raise exception 'Tu cuenta no tiene permiso para consultar los reportes.' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_from > p_to then
    raise exception 'Revisa las fechas: «Desde» no puede quedar después de «Hasta».';
  end if;
  v_days := p_to - p_from + 1;
  if v_days > 3660 then
    raise exception 'Elige un período de diez años o menos.';
  end if;
  -- Medianoche de Managua = 06:00 UTC. La ventana empieza en el periodo
  -- anterior, de la misma duración, para comparar y seguir a los clientes.
  v_window := ((p_from - v_days)::timestamp + interval '6 hours') at time zone 'UTC';
  v_from := (p_from::timestamp + interval '6 hours') at time zone 'UTC';
  v_until := ((p_to + 1)::timestamp + interval '6 hours') at time zone 'UTC';

  -- ── Ventas, por moneda ──────────────────────────────────────────────────
  with docs as (
    select d.id, d.kind, d.currency, d.total, d.tier_code, d.payment_method,
           d.customer_id, d.customer_name, d.created_at,
           ((d.created_at at time zone 'UTC') - interval '6 hours')::date as local_day,
           d.created_at >= v_from as in_period
    from public.documents d
    where d.created_at >= v_window and d.created_at < v_until
  ),
  inv as (select * from docs where kind = 'invoice'),
  items as (
    select i.document_id, i.product_id, i.description, i.quantity, i.line_total,
           d.currency, d.in_period, d.created_at
    from inv d join public.document_items i on i.document_id = d.id
  ),
  units as (
    select document_id, sum(quantity) as units from items group by document_id
  ),
  totals as (
    select d.currency, d.in_period, round(sum(d.total), 2) as revenue, count(*) as count,
           coalesce(sum(u.units), 0) as units, count(distinct d.customer_id) as customers
    from inv d left join units u on u.document_id = d.id
    group by d.currency, d.in_period
  ),
  buyers as (
    select d.currency, d.customer_id,
           (array_agg(d.customer_name order by d.created_at, d.id))[1] as name,
           round(sum(d.total), 2) as revenue, count(*) as count,
           exists(
             select 1 from public.customers c
             where c.id = d.customer_id
               and ((c.created_at at time zone 'UTC') - interval '6 hours')::date between p_from and p_to
           ) as is_new
    from inv d where d.in_period
    group by d.currency, d.customer_id
  ),
  -- Compraron en el periodo anterior y no en éste (anti-join contra `buyers`,
  -- que ya tiene un renglón por cliente: sin comparar factura contra factura).
  lapsed as (
    select d.currency, d.customer_id,
           (array_agg(d.customer_name order by d.created_at, d.id))[1] as name,
           max(d.local_day) as last_purchase, round(sum(d.total), 2) as previous_revenue,
           count(*) as orders
    from inv d
    left join buyers b on b.currency = d.currency and b.customer_id = d.customer_id
    where not d.in_period and b.customer_id is null
    group by d.currency, d.customer_id
  ),
  visits as (
    select d.currency, d.customer_id,
           (array_agg(d.customer_name order by d.created_at, d.id))[1] as name,
           count(*) as orders, min(d.local_day) as first_day, max(d.local_day) as last_day,
           count(distinct d.local_day) as distinct_days
    from inv d
    group by d.currency, d.customer_id
  ),
  products as (
    select currency, product_id,
           (array_agg(description order by created_at, document_id))[1] as description,
           sum(quantity) as quantity, round(sum(line_total), 2) as revenue
    from items where in_period
    group by currency, product_id
  ),
  -- Una proforma «terminó en factura» si ese cliente recibió una factura en la
  -- misma moneda después de ella: basta con comparar contra su última factura.
  last_sale as (
    select currency, customer_id, max(created_at) as at
    from inv where in_period group by currency, customer_id
  ),
  quotes as (
    select q.currency, count(*) as proformas,
           count(*) filter (where s.at >= q.created_at) as converted
    from docs q
    left join last_sale s on s.currency = q.currency and s.customer_id = q.customer_id
    where q.kind = 'proforma' and q.in_period
    group by q.currency
  )
  select jsonb_object_agg(c.code, jsonb_build_object(
    'current', coalesce(
      (select jsonb_build_object('revenue', t.revenue, 'count', t.count, 'units', t.units, 'customers', t.customers)
       from totals t where t.currency = c.code and t.in_period),
      '{"revenue":0,"count":0,"units":0,"customers":0}'::jsonb),
    'previous', coalesce(
      (select jsonb_build_object('revenue', t.revenue, 'count', t.count, 'units', t.units, 'customers', t.customers)
       from totals t where t.currency = c.code and not t.in_period),
      '{"revenue":0,"count":0,"units":0,"customers":0}'::jsonb),
    'proformas', coalesce((select q.proformas from quotes q where q.currency = c.code), 0),
    'converted', coalesce((select q.converted from quotes q where q.currency = c.code), 0),
    'days', coalesce((
      select jsonb_agg(jsonb_build_object('day', x.local_day, 'revenue', x.revenue, 'count', x.count) order by x.local_day)
      from (select local_day, round(sum(total), 2) as revenue, count(*) as count
            from inv where in_period and currency = c.code group by local_day) x), '[]'::jsonb),
    'weekdays', coalesce((
      select jsonb_agg(jsonb_build_object('weekday', x.weekday, 'revenue', x.revenue, 'count', x.count) order by x.weekday)
      from (select extract(dow from local_day)::integer as weekday, round(sum(total), 2) as revenue, count(*) as count
            from inv where in_period and currency = c.code group by 1) x), '[]'::jsonb),
    'payments', coalesce((
      select jsonb_agg(jsonb_build_object('key', x.key, 'value', x.value, 'count', x.count) order by x.key)
      from (select coalesce(payment_method, 'pending') as key, round(sum(total), 2) as value, count(*) as count
            from inv where in_period and currency = c.code group by 1) x), '[]'::jsonb),
    'tiers', coalesce((
      select jsonb_agg(jsonb_build_object('key', x.key, 'value', x.value, 'count', x.count) order by x.key)
      from (select tier_code as key, round(sum(total), 2) as value, count(*) as count
            from inv where in_period and currency = c.code group by 1) x), '[]'::jsonb),
    'products', coalesce((
      select jsonb_agg(jsonb_build_object('productId', p.product_id, 'description', p.description,
                                          'quantity', p.quantity, 'revenue', p.revenue)
                       order by p.revenue desc, p.quantity desc, p.product_id)
      from products p where p.currency = c.code), '[]'::jsonb),
    'newCustomers', (select count(*) from buyers b where b.currency = c.code and b.is_new),
    'returning', (select count(*) from buyers b where b.currency = c.code and not b.is_new),
    'topCustomers', coalesce((
      select jsonb_agg(jsonb_build_object('id', x.customer_id, 'name', x.name, 'revenue', x.revenue, 'count', x.count)
                       order by x.revenue desc, x.customer_id)
      from (select * from buyers b where b.currency = c.code
            order by b.revenue desc, b.customer_id limit 200) x), '[]'::jsonb),
    'lapsed', coalesce((
      select jsonb_agg(jsonb_build_object('id', x.customer_id, 'name', x.name, 'lastPurchase', x.last_purchase,
                                          'previousRevenue', x.previous_revenue, 'orders', x.orders)
                       order by x.previous_revenue desc, x.customer_id)
      from (select * from lapsed l where l.currency = c.code
            order by l.previous_revenue desc, l.customer_id limit 200) x), '[]'::jsonb),
    'visits', coalesce((
      select jsonb_agg(jsonb_build_object('id', x.customer_id, 'name', x.name, 'orders', x.orders,
                                          'firstDay', x.first_day, 'lastDay', x.last_day,
                                          'distinctDays', x.distinct_days)
                       order by x.orders desc, x.customer_id)
      from (select * from visits v where v.currency = c.code
            order by v.orders desc, v.customer_id limit 200) x), '[]'::jsonb)
  ))
  into v_sales
  from (values ('NIO'), ('USD')) c(code);

  -- ── Movimientos de inventario del periodo ──────────────────────────────
  select jsonb_build_object(
    'entries', coalesce(sum(abs(m.quantity)) filter (where m.type = 'ENTRY'), 0),
    'exits', coalesce(sum(abs(m.quantity)) filter (where m.type = 'EXIT'), 0),
    'damaged', coalesce(sum(abs(m.quantity)) filter (where m.type = 'DAMAGED'), 0),
    'adjustments', count(*) filter (where m.type = 'ADJUSTMENT'),
    'sales', coalesce(sum(abs(m.quantity)) filter (where m.type = 'SALE'), 0),
    'damagedByProduct', coalesce((
      select jsonb_agg(jsonb_build_object('productId', x.product_id, 'units', x.units) order by x.product_id)
      from (select d.product_id, sum(abs(d.quantity)) as units
            from public.inventory_movements d
            where d.type = 'DAMAGED' and d.created_at >= v_from and d.created_at < v_until
            group by d.product_id) x), '[]'::jsonb)
  )
  into v_movements
  from public.inventory_movements m
  where m.created_at >= v_from and m.created_at < v_until;

  -- ── Libro contable: sólo administración ────────────────────────────────
  if v_role = 'admin' then
    with lines as (
      select d.id as document_id, d.number, d.created_at, d.tier_code,
             ((d.created_at at time zone 'UTC') - interval '6 hours')::date as local_day,
             i.product_id, i.description, i.quantity,
             s.unit_cost_nio, s.net_revenue_nio, s.tax_nio,
             -- Un costo congelado sólo vale si es el único de su renglón y su
             -- cantidad coincide con la facturada; si no, cuenta como faltante.
             coalesce(
               s.document_id = i.document_id and s.product_id = i.product_id
               and s.quantity = i.quantity
               and not exists (
                 select 1 from public.document_item_costs x
                 where x.document_id = i.document_id and x.product_id = i.product_id
                   and x.document_item_id <> i.id
               ),
               false) as trusted
      from public.documents d
      join public.document_items i on i.document_id = d.id
      left join public.document_item_costs s on s.document_item_id = i.id
      where d.kind = 'invoice' and d.created_at >= v_from and d.created_at < v_until
    ),
    flagged as (
      select l.*,
             l.trusted and l.unit_cost_nio is not null and l.unit_cost_nio >= 0 as cost_known,
             l.trusted and l.net_revenue_nio is not null and l.net_revenue_nio >= 0
               and l.tax_nio is not null and l.tax_nio >= 0 as revenue_known,
             case when l.trusted and l.unit_cost_nio is not null and l.unit_cost_nio >= 0
                  then round(l.unit_cost_nio * l.quantity, 2) end as cost
      from lines l
    ),
    writeoffs as (
      -- Salidas con costo registrado…
      select ((c.created_at at time zone 'UTC') - interval '6 hours')::date as local_day,
             case when c.unit_cost_nio is not null and c.unit_cost_nio >= 0
                  then round(c.quantity * c.unit_cost_nio, 2) else 0 end as cost,
             case when c.unit_cost_nio is null or c.unit_cost_nio < 0 then c.quantity else 0 end as missing
      from public.inventory_movement_costs c
      where c.created_at >= v_from and c.created_at < v_until
      union all
      -- …y las que nunca lo tuvieron: dañados, salidas y ajustes a la baja.
      select ((m.created_at at time zone 'UTC') - interval '6 hours')::date, 0,
             case when m.type in ('DAMAGED', 'EXIT') then abs(m.quantity)
                  else greatest(0, m.before_quantity - m.after_quantity) end
      from public.inventory_movements m
      where m.created_at >= v_from and m.created_at < v_until
        and (m.type in ('DAMAGED', 'EXIT')
             or (m.type = 'ADJUSTMENT' and m.before_quantity is not null and m.after_quantity is not null
                 and m.before_quantity > m.after_quantity))
        and not exists (select 1 from public.inventory_movement_costs c where c.movement_id = m.id)
    ),
    month_lines as (
      select to_char(local_day, 'YYYY-MM') as month,
             coalesce(round(sum(net_revenue_nio) filter (where revenue_known), 2), 0) as revenue,
             coalesce(round(sum(tax_nio) filter (where revenue_known), 2), 0) as tax,
             coalesce(round(sum(cost), 2), 0) as cost,
             coalesce(sum(quantity) filter (where not cost_known), 0) as missing_cost,
             count(*) filter (where not revenue_known) as missing_revenue,
             sum(quantity) as sold
      from flagged group by 1
    ),
    month_writeoffs as (
      select to_char(local_day, 'YYYY-MM') as month, round(sum(cost), 2) as cost, sum(missing) as missing
      from writeoffs group by 1
    ),
    losses as (
      select document_id, number, created_at, product_id, description, quantity,
             net_revenue_nio as net, cost, cost - net_revenue_nio as loss
      from flagged
      where cost is not null and net_revenue_nio is not null and net_revenue_nio >= 0
        and cost > net_revenue_nio
    )
    select jsonb_build_object(
      'revenueNio', coalesce(round(sum(f.net_revenue_nio) filter (where f.revenue_known), 2), 0),
      'salesTaxNio', coalesce(round(sum(f.tax_nio) filter (where f.revenue_known), 2), 0),
      'costOfSalesNio', coalesce(round(sum(f.cost), 2), 0),
      'missingCostUnits', coalesce(sum(f.quantity) filter (where not f.cost_known), 0),
      'missingRevenueLines', count(*) filter (where not f.revenue_known),
      'soldUnits', coalesce(sum(f.quantity), 0),
      'inventoryWriteOffNio', (select coalesce(round(sum(w.cost), 2), 0) from writeoffs w),
      'missingWriteOffUnits', (select coalesce(sum(w.missing), 0) from writeoffs w),
      'products', coalesce((
        select jsonb_agg(jsonb_build_object('productId', x.product_id, 'description', x.description,
                                            'quantity', x.quantity, 'netRevenueNio', x.net,
                                            'costNio', x.cost, 'missingUnits', x.missing)
                         order by x.first_sale, x.product_id)
        from (select product_id,
                     (array_agg(description order by created_at, document_id))[1] as description,
                     sum(quantity) as quantity,
                     coalesce(round(sum(net_revenue_nio) filter (where revenue_known), 2), 0) as net,
                     coalesce(round(sum(cost), 2), 0) as cost,
                     coalesce(sum(quantity) filter (where not cost_known or not revenue_known), 0) as missing,
                     min(created_at) as first_sale
              from flagged group by product_id) x), '[]'::jsonb),
      'tiers', coalesce((
        select jsonb_agg(jsonb_build_object('tier', x.tier_code, 'netRevenueNio', x.net,
                                            'costNio', x.cost, 'missingUnits', x.missing)
                         order by x.first_sale, x.tier_code)
        from (select tier_code,
                     coalesce(round(sum(net_revenue_nio) filter (where revenue_known), 2), 0) as net,
                     coalesce(round(sum(cost), 2), 0) as cost,
                     coalesce(sum(quantity) filter (where not cost_known or not revenue_known), 0) as missing,
                     min(created_at) as first_sale
              from flagged group by tier_code) x), '[]'::jsonb),
      'months', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'month', coalesce(l.month, w.month),
                 'revenueNio', coalesce(l.revenue, 0), 'salesTaxNio', coalesce(l.tax, 0),
                 'costOfSalesNio', coalesce(l.cost, 0), 'missingCostUnits', coalesce(l.missing_cost, 0),
                 'missingRevenueLines', coalesce(l.missing_revenue, 0), 'soldUnits', coalesce(l.sold, 0),
                 'inventoryWriteOffNio', coalesce(w.cost, 0), 'missingWriteOffUnits', coalesce(w.missing, 0))
               order by coalesce(l.month, w.month))
        from month_lines l full join month_writeoffs w on w.month = l.month), '[]'::jsonb),
      'belowCost', jsonb_build_object(
        'count', (select count(*) from losses),
        'lossNio', (select coalesce(round(sum(loss), 2), 0) from losses),
        'rows', coalesce((
          select jsonb_agg(jsonb_build_object('documentId', x.document_id, 'number', x.number,
                                              'createdAt', x.created_at, 'productId', x.product_id,
                                              'description', x.description, 'quantity', x.quantity,
                                              'netRevenueNio', x.net, 'costNio', x.cost, 'lossNio', x.loss)
                           order by x.loss desc, x.created_at, x.document_id, x.product_id)
          from (select * from losses order by loss desc, created_at, document_id, product_id limit 500) x),
          '[]'::jsonb))
    )
    into v_ledger
    from flagged f;
  end if;

  return jsonb_build_object(
    'version', 1,
    'sales', v_sales,
    'movements', v_movements,
    'ledger', v_ledger
  );
end;
$$;

comment on function public.report_digest(date, date) is
  'Resumen de ventas, movimientos y libro contable de un periodo en días de Managua. Ver src/features/reports/digest.ts.';

revoke all on function public.report_digest(date, date) from public, anon;
grant execute on function public.report_digest(date, date) to authenticated;
