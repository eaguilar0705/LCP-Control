-- Tasas confirmadas por el dueño: catálogo 36.6243, contabilidad 37.
-- Cada operación conserva su conversión histórica; sólo se proponen tasas
-- independientes para operaciones nuevas y la consulta de estados en USD.
alter table public.exchange_rates
 add column accounting_usd_to_nio numeric(14,6) not null default 37
  check(accounting_usd_to_nio>0 and accounting_usd_to_nio<=1000000),
 add column accounting_updated_at timestamptz not null default now(),
 add column accounting_updated_by uuid references auth.users(id) on delete set null;

create function public.set_accounting_exchange_rate(p_rate numeric) returns void
language plpgsql security definer set search_path='' as $$
begin
 if auth.uid() is null or private.staff_role() is distinct from 'admin' then raise insufficient_privilege; end if;
 if p_rate is null or p_rate<=0 or p_rate>1000000 or p_rate<>round(p_rate,6) then
  raise exception 'Indica un tipo de cambio contable válido en córdobas por dólar.';
 end if;
 perform private.limit_catalog_writes();
 update public.exchange_rates set accounting_usd_to_nio=p_rate,
  accounting_updated_at=now(),accounting_updated_by=auth.uid() where id;
 if not found then raise exception 'Registra primero el tipo de cambio de inventario en Negocio.'; end if;
end $$;
revoke all on function public.set_accounting_exchange_rate(numeric) from public,anon,authenticated;
grant execute on function public.set_accounting_exchange_rate(numeric) to authenticated;

-- Recalcular el catálogo con la tasa comercial en la misma transacción.
-- No modifica costos promedio, existencias, compras ni documentos emitidos.
do $$ begin
 perform pg_advisory_xact_lock(hashtextextended('lcp-business-day',0));
 insert into public.exchange_rates(id,usd_to_nio,accounting_usd_to_nio)
 values(true,36.6243,37)
 on conflict(id) do update set usd_to_nio=excluded.usd_to_nio,updated_at=now();
 perform private.reprice_catalog(36.6243);
end $$;
notify pgrst,'reload schema';
