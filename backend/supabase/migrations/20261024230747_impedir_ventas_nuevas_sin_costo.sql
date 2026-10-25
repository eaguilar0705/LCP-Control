-- Sólo las ventas nuevas requieren un costo conocido. Los documentos ya
-- emitidos conservan sus snapshots históricos y siguen siendo recuperables
-- por su requestId; las proformas no registran costo ni descuentan unidades.
-- Cero es un costo conocido y válido: nunca se sustituye NULL por cero.
create or replace function private.snapshot_sale_cost() returns trigger
language plpgsql security definer set search_path='' as $$
declare d public.documents%rowtype; v_rate numeric; v_average numeric;
 v_gross numeric; v_product text;
begin
 if auth.uid() is null or private.staff_role() is null then raise insufficient_privilege; end if;
 select * into d from public.documents where id=new.document_id;
 if d.kind<>'invoice' then return new; end if;
 if d.currency='NIO' and not (d.request_payload ? 'exchangeRate') then v_rate:=1;
 else v_rate:=private.accounting_rate(d.request_payload); end if;
 if d.request_payload ? 'taxRate' then perform private.accounting_number(d.request_payload,'taxRate',100,6); end if;
 select average_cost_nio into v_average from public.product_costs where product_id=new.product_id;
 if v_average is null then
  select left(p.sku||' · '||p.name,100) into v_product from public.products p where p.id=new.product_id;
  raise exception using errcode='P1002',
   message=format('Falta registrar el costo de «%s». Pide a un administrador completarlo en Inventario → Editar → Costo de inventario y vuelve a emitir.',v_product);
 end if;
 v_gross:=round(new.quantity*new.unit_price*v_rate,2);
 insert into public.document_item_costs(document_item_id,document_id,product_id,quantity,unit_cost_nio,exchange_rate,tax_rate,net_revenue_nio,tax_nio)
 values(new.id,new.document_id,new.product_id,new.quantity,v_average,v_rate,0,v_gross,0);
 return new;
end $$;
revoke all on function private.snapshot_sale_cost() from public,anon,authenticated;

-- Las salidas y mermas nuevas también necesitan conservar su costo histórico.
-- El conteo inicial y las entradas mantienen el flujo existente.
create or replace function private.account_inventory_movement() returns trigger
language plpgsql security definer set search_path='' as $$
declare v_average numeric; v_name text; v_product text;
begin
 if auth.uid() is null or private.staff_role() is null then raise insufficient_privilege; end if;
 select average_cost_nio into v_average from public.product_costs where product_id=new.product_id;
 if new.type in ('EXIT','DAMAGED','ADJUSTMENT') and new.before_quantity>new.after_quantity then
  if v_average is null then
   select left(p.sku||' · '||p.name,100) into v_product from public.products p where p.id=new.product_id;
   raise exception using errcode='P1002',
    message=format('Falta registrar el costo de «%s». Pide a un administrador completarlo en Inventario → Editar → Costo de inventario y vuelve a registrar el movimiento.',v_product);
  end if;
  insert into public.inventory_movement_costs(movement_id,product_id,type,quantity,unit_cost_nio,created_at)
  values(new.id,new.product_id,new.type,new.before_quantity-new.after_quantity,v_average,new.created_at);
 end if;
 if new.type='ADJUSTMENT' and new.before_quantity is not null and new.after_quantity>new.before_quantity and not new.is_invoice_reversal then
  if v_average is null then
   select left(p.sku||' · '||p.name,100) into v_product from public.products p where p.id=new.product_id;
   raise exception using errcode='P1002',
    message=format('Falta registrar el costo de «%s». Pide a un administrador completarlo en Inventario → Editar → Costo de inventario y vuelve a registrar el movimiento.',v_product);
  end if;
  insert into private.inventory_count_gains values(new.id,new.product_id,new.after_quantity-new.before_quantity,v_average,new.created_at);
 end if;
 if new.type='ENTRY' and new.after_quantity>coalesce(new.before_quantity,0) and v_average is not null
    and not exists(
     select 1 from public.purchase_shipment_lines l join public.purchase_shipments s on s.id=l.shipment_id
     where l.product_id=new.product_id and s.created_by=auth.uid() and s.created_at=now()) then
  select b.name||' '||p.name into v_name from public.products p join public.brands b on b.id=p.brand_id where p.id=new.product_id;
  raise exception '«%» ya tiene costo promedio. Registra esta mercadería como compra con su costo (Inventario → Registrar compra) para actualizar el promedio y los precios.',
   coalesce(v_name,'Este perfume');
 end if;
 return new;
end $$;
revoke all on function private.account_inventory_movement() from public,anon,authenticated;

notify pgrst,'reload schema';
