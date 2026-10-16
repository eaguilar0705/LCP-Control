-- El catálogo sigue siendo la fuente del precio. Si cambió desde que se armó
-- el documento, no se emite por un importe distinto al que confirmó el usuario.
-- Los campos son opcionales para conservar las sesiones y solicitudes antiguas.
create function private.guard_confirmed_document_prices() returns trigger
language plpgsql security invoker set search_path='' as $$
declare v_expected numeric; v_line jsonb; v_price numeric;
begin
 if new.request_payload ? 'expectedTotal' then
  v_expected:=private.accounting_number(new.request_payload,'expectedTotal',100000000000000,2);
  if v_expected<>new.total then
   raise exception using errcode='P1001',message='Los precios cambiaron. Actualiza los precios de los productos y revisa el total antes de emitir.';
  end if;
 end if;
 -- Comparar también cada renglón: dos cambios opuestos pueden conservar el
 -- total y, aun así, alterar los importes que se le mostraron al cliente.
 for v_line in select value from jsonb_array_elements(new.request_payload->'items') loop
  if v_line ? 'expectedUnitPrice' then
   v_expected:=private.accounting_number(v_line,'expectedUnitPrice',10000000,2);
   select p.amount into v_price from public.product_prices p
    where p.product_id=(v_line->>'productId')::uuid
     and p.tier_code=new.tier_code and p.currency=new.currency;
   if v_price is distinct from v_expected then
    raise exception using errcode='P1001',message='Los precios cambiaron. Actualiza los precios de los productos y revisa el total antes de emitir.';
   end if;
  end if;
 end loop;
 return new;
end $$;
revoke all on function private.guard_confirmed_document_prices() from public,anon,authenticated;
create trigger documents_confirmed_prices before insert on public.documents
 for each row execute function private.guard_confirmed_document_prices();

-- La comprobación ocurre al insertar, dentro de la transacción existente y
-- después de bloquear los precios vigentes. Un rechazo revierte también el
-- cliente, el contador y el inventario. Recuperar una solicitud ya emitida no
-- inserta otra fila: conserva su resultado original aunque cambie el catálogo.
