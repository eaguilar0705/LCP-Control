-- Confirmación del propietario el 16/10/2026: C$1,900 por unidad en
-- FAC-000075 y FAC-000076, emitidas antes de cargar el costo del LCP-0183.
-- Sólo se completan esos dos snapshots; no se cambian precios ni existencias.
do $$
declare
 v_actor uuid:='375a183f-cd63-46a9-9e85-c76c1494b8b9';
 v_product uuid:='e98a3acd-87dd-5b08-80b6-10fc58b07857';
 v_matches integer; v_target record; v_cost public.document_item_costs%rowtype;
 v_before jsonb; v_after jsonb; v_audited boolean;
begin
 select count(*) into v_matches from public.documents
 where id in ('8949daf5-3864-4c2e-ac22-924ee97ba680','121c06ee-e95e-4950-80a0-1f477bd1b493');
 -- Instalaciones nuevas y bases de prueba no contienen estas facturas reales.
 if v_matches=0 then return; end if;
 if v_matches<>2 then raise exception 'Falta una de las facturas de la conciliación. No se modificó ningún costo.'; end if;
 if not exists(select 1 from public.staff_members where user_id=v_actor and active and role in ('admin','superadmin')) then
  raise exception 'No está disponible la cuenta que confirmó los costos históricos.';
 end if;
 perform pg_advisory_xact_lock(hashtextextended('lcp-business-day',0));
 perform 1 from public.documents
 where id in ('8949daf5-3864-4c2e-ac22-924ee97ba680','121c06ee-e95e-4950-80a0-1f477bd1b493') order by id for update;
 if exists(select 1 from public.business_days where day='2026-10-13' and closed_at is not null) then
  raise exception 'La jornada ya fue cerrada. Revisa la conciliación antes de modificar sus costos históricos.';
 end if;
 for v_target in
  select * from (values
   ('f3223c3c-a7bc-47a2-b82e-4e1c3c1c624d'::uuid,'8949daf5-3864-4c2e-ac22-924ee97ba680'::uuid,'FAC-000075'),
   ('c59f5fad-1dbc-4f1a-afee-159cdbdab8f8'::uuid,'121c06ee-e95e-4950-80a0-1f477bd1b493'::uuid,'FAC-000076')
  ) as t(item_id,document_id,number) order by document_id
 loop
  select c.* into v_cost from public.document_item_costs c
  join public.documents d on d.id=c.document_id
  join public.document_items i on i.id=c.document_item_id
  join public.products p on p.id=c.product_id
  where c.document_item_id=v_target.item_id and c.document_id=v_target.document_id
   and d.number=v_target.number and d.kind='invoice'
   and (d.created_at at time zone 'America/Managua')::date='2026-10-13'
   and c.product_id=v_product and p.sku='LCP-0183' and c.quantity=1
   and i.document_id=d.id and i.product_id=p.id and i.quantity=c.quantity
  for update of c;
  if not found then raise exception 'Cambió el detalle de %. No se modificó ningún costo.',v_target.number; end if;
  select exists(select 1 from private.catalog_changes
   where product_id=v_product and action='historical_cost_reconciliation'
    and after_data->'historicalCostReconciliation'->>'documentItemId'=v_target.item_id::text)
   into v_audited;
  if v_cost.unit_cost_nio=1900 and v_audited then continue; end if;
  if v_cost.unit_cost_nio is not null or v_audited then
   raise exception 'El costo de % ya cambió. Se cancela la conciliación para conservarlo.',v_target.number;
  end if;
  v_before:=to_jsonb(v_cost);
  update public.document_item_costs set unit_cost_nio=1900 where document_item_id=v_target.item_id
   returning to_jsonb(document_item_costs.*) into v_after;
  insert into private.catalog_changes(product_id,actor_id,action,before_data,after_data)
   values(v_product,v_actor,'historical_cost_reconciliation',v_before,
    v_after||jsonb_build_object('historicalCostReconciliation',jsonb_build_object(
     'documentItemId',v_target.item_id,'documentId',v_target.document_id,
     'documentNumber',v_target.number,'unitCostNio',1900,'confirmedOn','2026-10-16',
     'source','Confirmación expresa del propietario; costo de cada unidad vendida el 13/10/2026.')));
 end loop;
end $$;
