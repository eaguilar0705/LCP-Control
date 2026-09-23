-- Eliminación de facturas emitidas.
--
-- No modifica ni borra tablas existentes: agrega una bitácora privada y una
-- función. Sólo Administración puede eliminar, y la factura se deshace entera
-- en una sola transacción:
--
-- * Las unidades vuelven a la ubicación de la que salieron (tienda o bodega)
--   con un movimiento ADJUSTMENT que nombra la factura. El SALE original se
--   conserva en el historial de movimientos (pierde el enlace al documento,
--   no la nota con su número), así que el historial cuadra: salida + regreso.
-- * El costo promedio del perfume se recalcula con el costo que la venta había
--   congelado, como si esas unidades nunca hubieran salido. Si el perfume no
--   tiene promedio, o la venta no guardó costo, el promedio queda como estaba.
-- * Se borran los renglones, sus costos congelados y el documento: la venta
--   deja de contar en reportes y contabilidad.
-- * Antes de borrar se guarda la factura completa (JSON) en
--   `private.document_deletions`, con quién la eliminó, cuándo y el motivo.
--   El número no se reutiliza: el contador nunca retrocede.
--
-- Las proformas no mueven inventario ni contabilidad y no pasan por aquí.

create table private.document_deletions (
 id bigint generated always as identity primary key,
 document_id uuid not null,
 number text not null,
 kind text not null check(kind in ('invoice','proforma')),
 snapshot jsonb not null,
 reason text not null default '' check(length(reason)<=500),
 actor_id uuid not null references private.business_actors(id),
 deleted_at timestamptz not null default now()
);
create index document_deletions_actor_idx on private.document_deletions(actor_id);
alter table private.document_deletions enable row level security;
revoke all on private.document_deletions from public,anon,authenticated;

create function public.delete_invoice(p_id uuid,p_reason text default '') returns text
language plpgsql security definer set search_path='' as $$
declare
 v_uid uuid:=auth.uid(); v_doc public.documents%rowtype; v_item record;
 v_before integer; v_average numeric; v_reason text:=trim(coalesce(p_reason,''));
begin
 if v_uid is null or private.staff_role() is distinct from 'admin' then raise insufficient_privilege; end if;
 if p_id is null then raise exception 'Falta el identificador de la factura.'; end if;
 if length(v_reason)>500 then raise exception 'El motivo es demasiado largo.'; end if;
 perform pg_advisory_xact_lock(hashtextextended('document:'||p_id::text,0));
 select * into v_doc from public.documents where id=p_id for update;
 if v_doc.id is null then raise exception 'La factura ya no existe. Actualiza la lista.'; end if;
 if v_doc.kind<>'invoice' then raise exception 'Sólo se pueden eliminar facturas.'; end if;
 perform private.limit_catalog_writes();

 insert into private.document_deletions(document_id,number,kind,snapshot,reason,actor_id)
 values(v_doc.id,v_doc.number,v_doc.kind,
  to_jsonb(v_doc)||jsonb_build_object('items',
   (select coalesce(jsonb_agg(to_jsonb(i) order by i.description),'[]') from public.document_items i where i.document_id=v_doc.id),
   'costs',
   (select coalesce(jsonb_agg(to_jsonb(c)),'[]') from public.document_item_costs c where c.document_id=v_doc.id)),
  v_reason,v_uid);

 -- Mismo orden de bloqueo que create_document: producto y luego existencias.
 for v_item in
  select i.product_id,i.quantity,c.unit_cost_nio
  from public.document_items i left join public.document_item_costs c on c.document_item_id=i.id
  where i.document_id=v_doc.id order by i.product_id
 loop
  perform 1 from public.products where id=v_item.product_id for update;
  select quantity into v_before from public.inventory_balances
   where product_id=v_item.product_id and location=v_doc.location for update;
  if not found or v_before is null then
   raise exception 'No se puede devolver % al inventario: falta el conteo de %.',
    (select name from public.products where id=v_item.product_id),
    case v_doc.location when 'store' then 'Tienda' else 'Bodega' end;
  end if;
  select average_cost_nio into v_average from public.product_costs where product_id=v_item.product_id for update;
  if v_average is not null and v_item.unit_cost_nio is not null then
   update public.product_costs
    set average_cost_nio=round((v_average*v_before+v_item.unit_cost_nio*v_item.quantity)/(v_before+v_item.quantity),6),updated_at=now()
    where product_id=v_item.product_id;
  end if;
  update public.inventory_balances set quantity=v_before+v_item.quantity,updated_at=now()
   where product_id=v_item.product_id and location=v_doc.location;
  insert into public.inventory_movements(product_id,location,type,quantity,before_quantity,after_quantity,actor_id,reference,note)
  values(v_item.product_id,v_doc.location,'ADJUSTMENT',v_item.quantity,v_before,v_before+v_item.quantity,v_uid,v_doc.number,
   left('Factura '||v_doc.number||' eliminada'||case when v_reason<>'' then ': '||v_reason else '' end,2000));
 end loop;

 update public.inventory_movements set document_id=null where document_id=v_doc.id;
 delete from public.document_item_costs where document_id=v_doc.id;
 delete from public.document_items where document_id=v_doc.id;
 delete from public.documents where id=v_doc.id;
 return v_doc.number;
end $$;

revoke all on function public.delete_invoice(uuid,text) from public,anon,authenticated;
grant execute on function public.delete_invoice(uuid,text) to authenticated;
