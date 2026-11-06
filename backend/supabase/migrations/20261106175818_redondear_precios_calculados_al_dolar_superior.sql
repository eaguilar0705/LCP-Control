-- Redondear la venta por porcentaje una sola vez y en USD; convertir a NIO
-- desde el dólar entero. No redondear el total ni tocar costos o documentos.
create function private.rounded_markup_prices(p_purchase numeric,p_currency text,p_percent numeric,p_rate numeric)
returns table(usd numeric,nio numeric) language sql immutable security invoker set search_path='' as $$
 with sale as (
  select ceil(case p_currency when 'USD' then p_purchase*(100+p_percent)/100
   when 'NIO' then p_purchase*(100+p_percent)/100/nullif(p_rate,0) end) price
  where p_purchase>0 and p_percent>=0 and p_rate>0 and p_currency in ('USD','NIO')
 ) select price,greatest(round(price*p_rate,2),0.01) from sale
$$;
revoke all on function private.rounded_markup_prices(numeric,text,numeric,numeric) from public,anon,authenticated;

create or replace function private.markup_prices(p_product uuid,p_rate numeric)
returns table(tier text,usd numeric,nio numeric) language sql stable security definer set search_path='' as $$
 select r.tier,m.usd,m.nio from private.markup_rules r
 cross join lateral private.rounded_markup_prices(r.purchase_price,r.purchase_currency,r.markup,p_rate)m
 where r.product_id=p_product
$$;
revoke all on function private.markup_prices(uuid,numeric) from public,anon,authenticated;

-- El cambio de tasa usa la misma regla que editar el perfume. Así no vuelve
-- a publicar centavos después de corregir los precios.
create or replace function private.reprice_catalog(p_rate numeric) returns integer
language plpgsql security definer set search_path='' as $$
declare v_markup integer; v_manual integer;
begin
 if p_rate is null or p_rate<=0 then raise exception 'Tipo de cambio inválido para repreciar.'; end if;
 with target as (
  select r.product_id,r.tier,c.currency,case c.currency when 'USD' then m.usd else m.nio end amount
  from private.markup_rules r
  cross join lateral private.rounded_markup_prices(r.purchase_price,r.purchase_currency,r.markup,p_rate)m
  cross join (values ('USD'),('NIO'))c(currency)
 )
 update public.product_prices pr set amount=target.amount from target
 where pr.product_id=target.product_id and pr.tier_code=target.tier and pr.currency=target.currency
  and pr.amount is distinct from target.amount;
 get diagnostics v_markup=row_count;
 update public.product_prices nio set amount=greatest(round(usd.amount*p_rate,2),0.01)
 from public.product_prices usd
 where usd.product_id=nio.product_id and usd.tier_code=nio.tier_code and usd.currency='USD' and nio.currency='NIO'
  and nio.amount is distinct from greatest(round(usd.amount*p_rate,2),0.01)
  and not exists(select 1 from private.markup_rules r where r.product_id=nio.product_id and r.tier=nio.tier_code);
 get diagnostics v_manual=row_count;
 return v_markup+v_manual;
end $$;
revoke all on function private.reprice_catalog(numeric) from public,anon,authenticated;

-- Actualizar sólo las listas calculadas existentes. Se conserva la compra y
-- cada porcentaje, se registra antes/después y se invalida la edición vieja.
do $normalize$ declare p record; v_rate numeric; v_before jsonb; v_changed integer;
begin
 perform pg_advisory_xact_lock(hashtextextended('lcp-business-day',0));
 select usd_to_nio into v_rate from public.exchange_rates where id for share;
 if exists(select 1 from private.markup_rules) and (v_rate is null or v_rate<=0) then
  raise exception 'Registra el tipo de cambio antes de normalizar los precios calculados.';
 end if;
 for p in select products.* from public.products join (select distinct product_id from private.markup_rules)r on r.product_id=products.id order by products.id for update of products loop
  v_before:=to_jsonb(p)||jsonb_build_object('prices',private.product_price_rows(p.id),
   'pricing',(select to_jsonb(r) from public.product_pricing r where r.product_id=p.id));
  with target as (
   select p.id product_id,m.tier,c.currency,case c.currency when 'USD' then m.usd else m.nio end amount
   from private.markup_prices(p.id,v_rate)m cross join (values ('USD'),('NIO'))c(currency)
  ) update public.product_prices pr set amount=t.amount from target t
   where pr.product_id=t.product_id and pr.tier_code=t.tier and pr.currency=t.currency and pr.amount is distinct from t.amount;
  get diagnostics v_changed=row_count;
  if v_changed>0 then
   update public.products set revision=revision+1 where id=p.id;
   insert into private.catalog_changes(product_id,actor_id,action,before_data,after_data)
   values(p.id,null,'cost_pricing',v_before,private.pricing_after_data(p.id,v_rate)||
    jsonb_build_object('cause',jsonb_build_object('kind','rounding','reference','Precio calculado redondeado al dólar entero superior')));
  end if;
 end loop;
end $normalize$;
notify pgrst,'reload schema';
