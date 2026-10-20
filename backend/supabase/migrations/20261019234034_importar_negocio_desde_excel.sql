-- Initial business adoption is one transaction, including inventory valuation
-- and the opening voucher. The source registry makes retries harmless.
create table private.business_excel_imports (
 source_hash text primary key check(source_hash ~ '^[a-f0-9]{64}$'),
 request_id uuid not null unique,
 filename text not null,
 semantic_data jsonb not null,
 result jsonb not null,
 actor_id uuid not null references private.business_actors(id),
 created_at timestamptz not null default now()
);
alter table private.business_excel_imports enable row level security;
revoke all on private.business_excel_imports from public,anon,authenticated;

-- Preserve the catalogue implementation while serializing generated SKUs with
-- legacy LCP codes adopted by the import. The helper is no longer an API entry.
alter function public.save_catalog_product(jsonb) rename to save_catalog_product_before_excel_import;
alter function public.save_catalog_product_before_excel_import(jsonb) set schema private;
revoke all on function private.save_catalog_product_before_excel_import(jsonb) from public,anon,authenticated;
create function public.save_catalog_product(p_payload jsonb) returns uuid
language plpgsql security definer set search_path='' as $$
begin
 if auth.uid() is null or private.staff_role() is distinct from 'admin' then raise insufficient_privilege; end if;
 perform pg_advisory_xact_lock(hashtextextended('lcp-business-day',0));
 perform pg_advisory_xact_lock(hashtextextended('lcp-product-sku',0));
 return private.save_catalog_product_before_excel_import(p_payload);
end $$;
revoke all on function public.save_catalog_product(jsonb) from public,anon;
grant execute on function public.save_catalog_product(jsonb) to authenticated;

create function private.import_business_excel(p_input jsonb,p_preview boolean default true)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
 v_uid uuid:=auth.uid(); v_request uuid; v_hash text; v_data jsonb; v_prior private.business_excel_imports%rowtype;
 v_result jsonb; v_row jsonb; v_key text; v_index integer; v_label text;
 v_day date; v_time timestamptz; v_rate numeric; v_id uuid; v_brand uuid; v_amount numeric; v_qty integer;
 v_before integer; v_total integer; v_cost numeric; v_existing_cost numeric; v_opening_inventory numeric;
 v_product public.products%rowtype; v_account public.ledger_accounts%rowtype;
 v_customer public.customers%rowtype; v_supplier public.suppliers%rowtype;
 v_tier text; v_location text; v_phone text; v_name text; v_journal uuid; v_field text; v_has_opening boolean; v_max_sku bigint;
begin
 if v_uid is null or private.staff_role() is distinct from 'admin' then raise insufficient_privilege; end if;
 if p_preview is null or jsonb_typeof(p_input) is distinct from 'object' or octet_length(p_input::text)>12582912
  or p_input->'version' is distinct from '1'::jsonb then raise exception 'Formato de importación inválido.'; end if;
 v_request:=(p_input->>'requestId')::uuid; v_hash:=p_input->>'sourceHash'; v_day:=(p_input->>'occurredOn')::date;
 if v_request is null or v_hash is null or v_hash !~ '^[a-f0-9]{64}$' then raise exception 'Falta la identificación del archivo o de la solicitud.'; end if;
 if length(btrim(coalesce(p_input->>'filename',''))) not between 1 and 240 then raise exception 'Nombre de archivo inválido.'; end if;
 if v_day is null or v_day>(now() at time zone 'America/Managua')::date then raise exception 'La fecha de migración no puede ser futura.'; end if;
 foreach v_key in array array['products','stocks','accounts','openingBalances','customers','suppliers'] loop
  if jsonb_typeof(p_input->v_key) is distinct from 'array' then raise exception 'La sección % debe ser una lista.',v_key; end if;
  if jsonb_array_length(p_input->v_key)>(case when v_key='openingBalances' then 100 else 10000 end) then
   raise exception 'La sección % excede el límite de filas.',v_key;
  end if;
  if exists(select 1 from jsonb_array_elements(p_input->v_key) x where jsonb_typeof(x)<>'object') then
   raise exception 'La sección % contiene una fila inválida.',v_key;
  end if;
 end loop;
 if jsonb_typeof(p_input->'business') not in ('object','null') or not(p_input ? 'business') then raise exception 'Datos del negocio inválidos.'; end if;
 if not exists(select 1 from unnest(array['products','stocks','accounts','openingBalances','customers','suppliers']) k where jsonb_array_length(p_input->k)>0)
  and p_input->'business'='null'::jsonb then raise exception 'El archivo no contiene datos para importar.'; end if;
 v_data:=p_input-'requestId'-'filename'-'sourceHash';
 -- Same ordering as invoice issuing and closing prevents partial adoption while
 -- the shop is selling or a second administrator is importing.
 perform pg_advisory_xact_lock(hashtextextended('lcp-business-day',0));
 perform pg_advisory_xact_lock(hashtextextended('lcp-business-excel-import',0));
 perform pg_advisory_xact_lock(hashtextextended('lcp-product-sku',0));
 if exists(select 1 from private.business_excel_imports where request_id=v_request and (semantic_data<>v_data or source_hash<>v_hash)) then
  raise exception 'El archivo o la solicitud ya se usó con otros datos.';
 end if;
 select * into v_prior from private.business_excel_imports where source_hash=v_hash;
 if found then
  if v_prior.semantic_data<>v_data or v_prior.source_hash<>v_hash then raise exception 'El archivo o la solicitud ya se usó con otros datos.'; end if;
  return v_prior.result||jsonb_build_object('preview',p_preview,'alreadyImported',true);
 end if;
 select usd_to_nio into v_rate from public.exchange_rates where id;
 select exists(select 1 from public.journal_entries where kind='opening' and voided_at is null) into v_has_opening;
 v_time:=(v_day::timestamp+interval '12 hours') at time zone 'America/Managua';
 v_result:=jsonb_build_object('preview',p_preview,'alreadyImported',false,
  'products',jsonb_array_length(p_input->'products'),'stocks',jsonb_array_length(p_input->'stocks'),
  'accounts',jsonb_array_length(p_input->'accounts'),'openingBalances',jsonb_array_length(p_input->'openingBalances'),
  'customers',jsonb_array_length(p_input->'customers'),'suppliers',jsonb_array_length(p_input->'suppliers'),
  'business',p_input->'business'<>'null'::jsonb);
 -- A real rehearsal: all constraints and accounting triggers execute. The
 -- deliberately raised exception rolls back this subtransaction for previews.
 begin
  if not p_preview then perform private.limit_catalog_writes(); end if;
  foreach v_key in array array['products','stocks','accounts','openingBalances'] loop
   v_label:=case v_key when 'accounts' then 'code' when 'openingBalances' then 'account' else 'sku' end;
   if exists(select 1 from jsonb_array_elements(p_input->v_key) x group by x->>v_label having count(*)>1) then
    raise exception 'La sección % tiene códigos repetidos.',v_key;
   end if;
  end loop;
  -- Do not accept JSON objects or numbers disguised by the ->> text operator.
  foreach v_key in array array['products','stocks','accounts','openingBalances','customers','suppliers'] loop
   for v_row,v_index in select value,ordinality::integer from jsonb_array_elements(p_input->v_key) with ordinality loop
    foreach v_field in array (case v_key
     when 'products' then array['sku','name','brand','unit'] when 'stocks' then array['sku']
     when 'accounts' then array['code','name'] when 'openingBalances' then array['account']
     else array['name','email','address','taxId','priceTier'] end) loop
     if jsonb_typeof(v_row->v_field) is distinct from 'string' then raise exception 'Sección %, fila %: el campo % debe ser texto.',v_key,v_index+1,v_field; end if;
    end loop;
    foreach v_field in array (case v_key when 'products' then array['barcode','category','gender']
     when 'accounts' then array['parent'] when 'customers' then array['phone'] when 'suppliers' then array['phone'] else array[]::text[] end) loop
     if jsonb_typeof(v_row->v_field) not in ('string','null') then raise exception 'Sección %, fila %: el campo % debe ser texto o vacío.',v_key,v_index+1,v_field; end if;
    end loop;
   end loop;
  end loop;
  if p_input->'business'<>'null'::jsonb then
   foreach v_field in array array['name','legalName','taxId','address','phone','email','branch','billingDetails'] loop
    if jsonb_typeof(p_input->'business'->v_field) is distinct from 'string' then raise exception 'Negocio: el campo % debe ser texto.',v_field; end if;
   end loop;
  end if;

  for v_row,v_index in select value,ordinality::integer from jsonb_array_elements(p_input->'products') with ordinality order by value->>'sku' loop
   v_label:=format('Productos, fila %s (%s)',v_index+1,coalesce(v_row->>'sku','sin código'));
   begin
    v_key:=btrim(coalesce(v_row->>'sku',''));
    if length(v_key) not between 1 and 100 or v_key<>v_row->>'sku' then raise exception 'Código inválido.'; end if;
    if length(btrim(coalesce(v_row->>'name',''))) not between 1 and 200 or length(btrim(coalesce(v_row->>'brand',''))) not between 1 and 100 then raise exception 'Nombre o marca inválidos.'; end if;
    if coalesce(v_row->>'unit','') not in ('oz','ml') or (v_row->>'category' is not null and v_row->>'category' not in ('arabian','designer','niche'))
     or (v_row->>'gender' is not null and v_row->>'gender' not in ('male','female','unisex')) then raise exception 'Unidad, categoría o género inválidos.'; end if;
    if v_row->>'size' is not null then
     v_amount:=private.accounting_number(v_row,'size',99999,3);
     if v_amount<=0 then raise exception 'Tamaño inválido.'; end if;
    end if;
    v_qty:=private.accounting_number(v_row,'minimumStock',1000000,0);
    if nullif(v_row->>'barcode','') is not null and v_row->>'barcode' !~ '^[0-9]{8}$|^[0-9]{12,14}$' then raise exception 'Código de fabricante inválido.'; end if;
    if jsonb_typeof(v_row->'pricesUSD') is distinct from 'object' then raise exception 'Listas de precios inválidas.'; end if;
    select * into v_product from public.products where sku=v_key for update;
    if found then
     if not v_product.active or v_product.name<>btrim(v_row->>'name') or (select name from public.brands where id=v_product.brand_id)<>btrim(v_row->>'brand')
      or v_product.size is distinct from (v_row->>'size')::numeric or v_product.unit<>v_row->>'unit'
      or v_product.category is distinct from v_row->>'category' or v_product.gender is distinct from v_row->>'gender'
      or v_product.barcode is distinct from nullif(v_row->>'barcode','') or v_product.minimum_stock<>v_qty then
      raise exception 'El código ya pertenece a un producto con otros datos. No se sobrescribe el catálogo.';
     end if;
     v_id:=v_product.id;
    else
     insert into public.brands(name) values(btrim(v_row->>'brand')) on conflict(name) do update set name=excluded.name returning id into v_brand;
     insert into public.products(sku,import_key,name,brand_id,size,unit,category,gender,barcode,minimum_stock,size_needs_review)
     values(v_key,'excel:'||v_key,btrim(v_row->>'name'),v_brand,(v_row->>'size')::numeric,v_row->>'unit',v_row->>'category',v_row->>'gender',nullif(v_row->>'barcode',''),v_qty,v_row->>'size' is null) returning id into v_id;
     insert into public.inventory_balances(product_id,location,quantity) values(v_id,'warehouse',null),(v_id,'store',null);
     insert into private.catalog_changes(product_id,actor_id,action,after_data) values(v_id,v_uid,'business_import',v_row||jsonb_build_object('sourceHash',v_hash));
    end if;
    foreach v_tier in array array['emprendedor','vip','premium'] loop
     if not(v_row->'pricesUSD' ? v_tier) then raise exception 'Falta la lista %; usa una celda vacía si no existe.',v_tier; end if;
     if v_row->'pricesUSD'->>v_tier is not null then
      v_amount:=private.accounting_number(v_row->'pricesUSD',v_tier,10000000,2);
      if v_amount<=0 or v_rate is null then raise exception 'El precio debe ser positivo y debe existir una tasa en Negocio.'; end if;
      if exists(select 1 from public.product_prices where product_id=v_id and tier_code=v_tier and
       ((currency='USD' and amount<>v_amount) or (currency='NIO' and amount<>greatest(round(v_amount*v_rate,2),0.01)))) then
       raise exception 'La lista % ya tiene otro precio; no se sobrescribe.',v_tier;
      end if;
      insert into public.product_prices(product_id,tier_code,currency,amount) values(v_id,v_tier,'USD',v_amount),(v_id,v_tier,'NIO',greatest(round(v_amount*v_rate,2),0.01)) on conflict do nothing;
     end if;
    end loop;
   exception when others then raise exception '%: %',v_label,sqlerrm; end;
  end loop;

  -- Lock every target before balances, matching the established stock RPCs.
  perform 1 from public.products p where sku in (select x->>'sku' from jsonb_array_elements(p_input->'stocks') x) order by id for update;
  for v_row,v_index in select value,ordinality::integer from jsonb_array_elements(p_input->'stocks') with ordinality order by value->>'sku' loop
   v_label:=format('Existencias, fila %s (%s)',v_index+1,coalesce(v_row->>'sku','sin código'));
   begin
    select * into v_product from public.products where sku=v_row->>'sku' and active;
    if not found then raise exception 'No existe un producto activo con ese código.'; end if;
    v_id:=v_product.id;
    perform 1 from public.inventory_balances where product_id=v_id order by location for update;
    if exists(select 1 from public.inventory_movements where product_id=v_id and
      (type<>'ADJUSTMENT' or before_quantity is not null)) and
      (exists(select 1 from public.inventory_balances b where b.product_id=v_id and b.quantity is null and v_row->>b.location is not null)
       or (v_row->>'unitCostNio' is not null and not exists(select 1 from public.product_costs where product_id=v_id and average_cost_nio is not null))) then
     raise exception 'El producto ya tiene operaciones de inventario. Usa los movimientos y costos del sistema para corregirlo.';
    end if;
    foreach v_location in array array['warehouse','store'] loop
     if not(v_row ? v_location) then raise exception 'Falta una ubicación; usa una celda vacía si no fue contada.'; end if;
     if v_row->>v_location is not null then
      v_qty:=private.accounting_number(v_row,v_location,1000000,0);
      select quantity into v_before from public.inventory_balances where product_id=v_id and location=v_location;
      if not found then
       insert into public.inventory_balances(product_id,location,quantity) values(v_id,v_location,null);
       v_before:=null;
      end if;
      if v_before is not null and v_before<>v_qty then raise exception 'Ya existe un conteo en %. Usa el ajuste de inventario para corregirlo.',case v_location when 'warehouse' then 'bodega' else 'tienda' end; end if;
      if v_before is null then
       if v_has_opening then raise exception 'La apertura contable ya está registrada. Registra las nuevas existencias mediante los movimientos del sistema.'; end if;
       update public.inventory_balances set quantity=v_qty,updated_at=now() where product_id=v_id and location=v_location;
       insert into public.inventory_movements(product_id,location,type,quantity,before_quantity,after_quantity,actor_id,reference,note,created_at)
       values(v_id,v_location,'ADJUSTMENT',v_qty,null,v_qty,v_uid,left(p_input->>'filename',200),'Conteo inicial importado desde Excel',v_time);
      end if;
     end if;
    end loop;
    if v_row->>'unitCostNio' is not null then
     v_cost:=private.accounting_number(v_row,'unitCostNio',1000000000,6);
     select average_cost_nio into v_existing_cost from public.product_costs where product_id=v_id for update;
     if v_existing_cost is not null and v_existing_cost<>v_cost then raise exception 'El costo promedio ya está registrado; no se sobrescribe.'; end if;
     if v_existing_cost is null then
      if v_has_opening then raise exception 'La apertura contable ya está registrada. Registra las nuevas existencias y costos mediante las compras del sistema.'; end if;
      select sum(quantity) into v_total from public.inventory_balances where product_id=v_id having count(quantity)=2;
      if v_total is null or v_total<=0 then raise exception 'El costo inicial requiere conteo en bodega y tienda y existencias positivas.'; end if;
      insert into public.opening_cost_records(request_id,request_payload,product_id,quantity,unit_cost,currency,exchange_rate,unit_cost_nio,note,created_by,created_at)
      values(gen_random_uuid(),v_row,v_id,v_total,v_cost,'NIO',1,v_cost,'Costo inicial importado desde Excel: '||left(p_input->>'filename',240),v_uid,v_time);
      insert into public.product_costs(product_id,average_cost_nio) values(v_id,v_cost)
      on conflict(product_id) do update set average_cost_nio=excluded.average_cost_nio,updated_at=now();
     end if;
    end if;
   exception when others then raise exception '%: %',v_label,sqlerrm; end;
  end loop;

  -- Explicit workbook prices remain the final published prices, including
  -- after stock and valuation triggers. Reject rather than silently replace a
  -- value if a configured pricing rule recalculates it during the transaction.
  for v_row,v_index in select value,ordinality::integer from jsonb_array_elements(p_input->'products') with ordinality loop
   foreach v_tier in array array['emprendedor','vip','premium'] loop
    if v_row->'pricesUSD'->>v_tier is not null then
     v_amount:=(v_row->'pricesUSD'->>v_tier)::numeric;
     if not exists(select 1 from public.product_prices pp join public.products p on p.id=pp.product_id
       where p.sku=v_row->>'sku' and pp.tier_code=v_tier and pp.currency='USD' and pp.amount=v_amount)
      or not exists(select 1 from public.product_prices pp join public.products p on p.id=pp.product_id
       where p.sku=v_row->>'sku' and pp.tier_code=v_tier and pp.currency='NIO' and pp.amount=greatest(round(v_amount*v_rate,2),0.01)) then
      raise exception 'Productos, fila % (%): la lista % fue recalculada por una regla de precios y no coincide con Excel. Revisa la configuración antes de importar.',v_index+1,v_row->>'sku',v_tier;
     end if;
    end if;
   end loop;
  end loop;

  for v_row,v_index in select value,ordinality::integer from jsonb_array_elements(p_input->'accounts') with ordinality loop
   v_label:=format('Cuentas, fila %s (%s)',v_index+1,coalesce(v_row->>'code','sin código'));
   begin
    if coalesce(v_row->>'code','') !~ '^[1-6][0-9]{3}(-[0-9]{3}){0,3}$' or length(btrim(coalesce(v_row->>'name',''))) not between 1 and 160 then raise exception 'Código o nombre de cuenta inválido.'; end if;
    select * into v_account from public.ledger_accounts where code=v_row->>'code' for update;
    if found then
     if not v_account.active or v_account.name<>btrim(v_row->>'name') or v_account.parent is distinct from v_row->>'parent' then
      raise exception 'La cuenta ya existe con otros datos; no se reemplaza.';
     end if;
    else
     perform private.save_ledger_account(v_row);
    end if;
   exception when others then raise exception '%: %',v_label,sqlerrm; end;
  end loop;

  foreach v_key in array array['customers','suppliers'] loop
   if exists(select 1 from jsonb_array_elements(p_input->v_key) x group by lower(btrim(x->>'name')) having count(*)>1) then raise exception 'La sección % tiene nombres repetidos.',v_key; end if;
   for v_row,v_index in select value,ordinality::integer from jsonb_array_elements(p_input->v_key) with ordinality loop
    v_label:=format('%s, fila %s (%s)',case v_key when 'customers' then 'Clientes' else 'Proveedores' end,v_index+1,coalesce(v_row->>'name','sin nombre'));
    begin
     v_name:=btrim(coalesce(v_row->>'name','')); v_phone:=nullif(btrim(v_row->>'phone'),'');
     if length(v_name) not between 1 and 160 or length(coalesce(v_row->>'email',''))>254 or length(coalesce(v_row->>'address',''))>600
      or length(coalesce(v_row->>'taxId',''))>80 or coalesce(v_row->>'priceTier','') not in ('emprendedor','vip','premium') then raise exception 'Datos del contacto inválidos.'; end if;
     if coalesce(v_row->>'email','')<>'' and v_row->>'email' !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$' then raise exception 'Correo inválido.'; end if;
     if v_key='customers' then
      if v_phone is not null and v_phone !~ '^[1-9][0-9]{7,14}$' then raise exception 'Teléfono inválido; incluye solamente dígitos y el prefijo del país cuando corresponda.'; end if;
      if (select count(*) from public.customers where lower(name)=lower(v_name) or (v_phone is not null and phone=v_phone))>1 then raise exception 'El nombre o teléfono identifica varios clientes.'; end if;
      select * into v_customer from public.customers where lower(name)=lower(v_name) or (v_phone is not null and phone=v_phone) for update;
      if found then
       if not v_customer.active or v_customer.name<>v_name or v_customer.phone is distinct from v_phone or v_customer.email<>coalesce(v_row->>'email','')
        or v_customer.address<>coalesce(v_row->>'address','') or v_customer.tax_id<>coalesce(v_row->>'taxId','') or v_customer.price_tier<>v_row->>'priceTier' then raise exception 'Ya existe un cliente con otros datos; no se reemplaza.'; end if;
      else
       insert into public.customers(name,phone,email,address,tax_id,price_tier) values(v_name,v_phone,coalesce(v_row->>'email',''),coalesce(v_row->>'address',''),coalesce(v_row->>'taxId',''),v_row->>'priceTier');
      end if;
     else
      if length(coalesce(v_phone,''))>60 then raise exception 'Teléfono demasiado largo.'; end if;
      if (select count(*) from public.suppliers where lower(name)=lower(v_name) or (v_phone is not null and phone=v_phone))>1 then raise exception 'El nombre o teléfono identifica varios proveedores.'; end if;
      select * into v_supplier from public.suppliers where lower(name)=lower(v_name) or (v_phone is not null and phone=v_phone) for update;
      if found then
       if not v_supplier.active or v_supplier.name<>v_name or v_supplier.phone<>coalesce(v_phone,'') or v_supplier.email<>coalesce(v_row->>'email','')
        or v_supplier.address<>coalesce(v_row->>'address','') or v_supplier.tax_id<>coalesce(v_row->>'taxId','') then raise exception 'Ya existe un proveedor con otros datos; no se reemplaza.'; end if;
      else
       insert into public.suppliers(name,phone,email,address,tax_id,updated_by) values(v_name,coalesce(v_phone,''),coalesce(v_row->>'email',''),coalesce(v_row->>'address',''),coalesce(v_row->>'taxId',''),v_uid);
      end if;
     end if;
    exception when others then raise exception '%: %',v_label,sqlerrm; end;
   end loop;
  end loop;

  if p_input->'business'<>'null'::jsonb then perform private.save_business_profile(p_input->'business'); end if;
  if jsonb_array_length(p_input->'openingBalances')>0 then
   if exists(select 1 from public.inventory_balances b join public.product_costs c on c.product_id=b.product_id where b.quantity>0 and c.average_cost_nio>0)
    and not exists(select 1 from jsonb_array_elements(p_input->'openingBalances') x where x->>'account'='1130') then
    raise exception 'Incluye la cuenta 1130 con el valor de las existencias en los saldos iniciales.';
   end if;
   for v_row,v_index in select value,ordinality::integer from jsonb_array_elements(p_input->'openingBalances') with ordinality loop
    v_label:=format('Saldos iniciales, fila %s (%s)',v_index+1,coalesce(v_row->>'account','sin cuenta'));
    begin
     v_amount:=private.accounting_number(v_row,'debit',100000000,2); v_cost:=private.accounting_number(v_row,'credit',100000000,2);
     if not ((v_amount>0 and v_cost=0) or (v_cost>0 and v_amount=0)) then raise exception 'Indica un importe positivo en debe o haber, solamente en uno.'; end if;
     if not exists(select 1 from public.ledger_accounts where code=v_row->>'account' and active and postable and bucket in ('asset','liability','equity')) then raise exception 'Cuenta no disponible para saldos iniciales.'; end if;
    exception when others then raise exception '%: %',v_label,sqlerrm; end;
   end loop;
   -- Keep the opening ledger inventory consistent with the counted subledger.
   if exists(select 1 from jsonb_array_elements(p_input->'openingBalances') x where x->>'account'='1130') then
    if exists(select 1 from public.inventory_balances b left join public.product_costs c on c.product_id=b.product_id where b.quantity is null or (b.quantity>0 and c.average_cost_nio is null)) then
     raise exception 'El saldo inicial de inventario requiere todos los conteos y costos.';
    end if;
    select coalesce(sum(round(b.quantity*c.average_cost_nio,2)),0) into v_opening_inventory
    from (select product_id,sum(quantity) quantity from public.inventory_balances group by product_id) b
    left join public.product_costs c on c.product_id=b.product_id;
    if (select sum((x->>'debit')::numeric-(x->>'credit')::numeric) from jsonb_array_elements(p_input->'openingBalances') x where x->>'account'='1130')<>v_opening_inventory then
     raise exception 'El saldo inicial de inventario (1130) debe coincidir con las existencias valoradas: C$ %.',v_opening_inventory;
    end if;
   end if;
   v_journal:=private.record_journal_entry(jsonb_build_object('requestId',v_request,'occurredOn',v_day,'kind','opening',
    'description','Saldos iniciales importados desde Excel','reference',left(p_input->>'filename',200),'currency','NIO','exchangeRate',1,'lines',p_input->'openingBalances'));
  end if;
  insert into private.business_excel_imports(source_hash,request_id,filename,semantic_data,result,actor_id)
  values(v_hash,v_request,p_input->>'filename',v_data,v_result-'preview',v_uid);
  if p_preview then raise exception using errcode='P7001',message='rollback business Excel preview'; end if;
  -- Only canonical generated codes can collide with the sequence. This runs
  -- after validation and never during previews; the catalogue shares the lock.
  with candidates as materialized (
   select sku,substring(sku from 5)::bigint n from public.products where sku ~ '^LCP-[0-9]{1,18}$'
  ) select max(n) into v_max_sku from candidates where sku='LCP-'||lpad(n::text,greatest(4,length(n::text)),'0');
  if v_max_sku is not null then
   perform setval('private.product_sku_sequence',greatest(v_max_sku,(select last_value from private.product_sku_sequence)),true);
  end if;
 exception when sqlstate 'P7001' then null;
 end;
 return v_result;
end $$;

create function public.import_business_excel(p_input jsonb,p_preview boolean default true)
returns jsonb language sql security invoker set search_path='' as $$ select private.import_business_excel(p_input,p_preview); $$;
revoke all on function private.import_business_excel(jsonb,boolean),public.import_business_excel(jsonb,boolean) from public,anon;
grant execute on function private.import_business_excel(jsonb,boolean),public.import_business_excel(jsonb,boolean) to authenticated;
