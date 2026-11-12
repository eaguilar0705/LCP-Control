-- Aclaración del dueño: la venta se convierte a 37; 36.6243 corresponde a los
-- costos del inventario. La tasa contable continúa siendo independiente.
alter table public.exchange_rates
 add column inventory_usd_to_nio numeric(14,6) not null default 36.6243
  check(inventory_usd_to_nio>0 and inventory_usd_to_nio<=1000000),
 add column inventory_updated_at timestamptz not null default now(),
 add column inventory_updated_by uuid references auth.users(id) on delete set null;

create function public.set_inventory_exchange_rate(p_rate numeric) returns void
language plpgsql security definer set search_path='' as $$
begin
 if auth.uid() is null or private.staff_role() is distinct from 'admin' then raise insufficient_privilege; end if;
 if p_rate is null or p_rate<=0 or p_rate>1000000 or p_rate<>round(p_rate,6) then
  raise exception 'Indica un tipo de cambio de costos de inventario válido en córdobas por dólar.';
 end if;
 perform private.limit_catalog_writes();
 update public.exchange_rates set inventory_usd_to_nio=p_rate,
  inventory_updated_at=now(),inventory_updated_by=auth.uid() where id;
 if not found then raise exception 'Registra primero el tipo de cambio de precios de venta en Negocio.'; end if;
end $$;
revoke all on function public.set_inventory_exchange_rate(numeric) from public,anon,authenticated;
grant execute on function public.set_inventory_exchange_rate(numeric) to authenticated;

-- Solo actualiza la configuración y los precios actuales del catálogo. Cada
-- compra, recepción, costo y documento emitido conserva su conversión histórica.
do $$ begin
 perform pg_advisory_xact_lock(hashtextextended('lcp-business-day',0));
 insert into public.exchange_rates(id,usd_to_nio,inventory_usd_to_nio)
 values(true,37,36.6243)
 on conflict(id) do update set usd_to_nio=37,updated_at=now();
 perform private.reprice_catalog(37);
end $$;
notify pgrst,'reload schema';
