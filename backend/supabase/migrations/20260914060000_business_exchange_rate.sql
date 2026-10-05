-- La tasa vigente del dólar vive en su propia tabla y no en business_settings:
-- create_document congela esa fila entera como emisor de cada documento, y una
-- tasa que se mueve cada semana no pertenece al membrete de una factura ya
-- emitida. Aquí sólo se guarda la tasa propuesta; cada operación sigue
-- guardando la suya, que es la que vale para su contabilidad.
create table public.exchange_rates (
 id boolean primary key default true check(id),
 usd_to_nio numeric(14,6) not null check(usd_to_nio>0 and usd_to_nio<=1000000),
 updated_at timestamptz not null default now(),
 updated_by uuid references auth.users(id)
);
create index exchange_rates_updated_by_idx on public.exchange_rates(updated_by);

alter table public.exchange_rates enable row level security;
revoke all on public.exchange_rates from public,anon,authenticated;
grant select on public.exchange_rates to authenticated;
-- La lee cualquier cuenta activa del personal: facturar en dólares la necesita.
-- Cambiarla es administración, igual que el resto de los datos del negocio.
create policy staff_exchange_rate_read on public.exchange_rates for select to authenticated
 using ((select private.staff_role()) is not null);

create function public.set_exchange_rate(p_rate numeric) returns void language plpgsql security definer set search_path='' as $$
begin
 if auth.uid() is null or private.staff_role() is distinct from 'admin' then raise insufficient_privilege; end if;
 if p_rate is null or p_rate<=0 or p_rate>1000000 or p_rate<>round(p_rate,6) then
  raise exception 'Indica un tipo de cambio válido en córdobas por dólar.';
 end if;
 perform private.limit_catalog_writes();
 insert into public.exchange_rates(id,usd_to_nio,updated_by) values(true,p_rate,auth.uid())
 on conflict(id) do update set usd_to_nio=excluded.usd_to_nio,updated_at=now(),updated_by=excluded.updated_by;
end $$;
revoke all on function public.set_exchange_rate(numeric) from public,anon,authenticated;
grant execute on function public.set_exchange_rate(numeric) to authenticated;
