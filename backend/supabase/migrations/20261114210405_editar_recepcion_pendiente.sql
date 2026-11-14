-- La edición reutiliza la validación y el registro de solicitudes de recepción.
-- La solicitud original y los datos de cada revisión quedan en el historial.
do $migration$
declare
 definition text:=pg_get_functiondef('private.record_inventory_receipt(jsonb)'::regprocedure);
 declarations text:='v_units integer:=0;v_goods numeric:=0;v_index integer:=0;v_key text;';
 insert_marker text:=' insert into private.inventory_receipts(created_by,';
 end_marker text:=' returning id into v_id;';
begin
 if position(declarations in definition)=0 or position(insert_marker in definition)=0 or position(end_marker in definition)=0 then
  raise exception 'Revisa la función vigente de registro de recepciones.';
 end if;
 definition:=replace(definition,declarations,declarations||$declare$
 v_edit boolean:=p_input ? 'receiptId'; v_receipt private.inventory_receipts%rowtype;
$declare$);
 definition:=replace(definition,insert_marker,$edit$
 if v_edit then
  if not private.is_superadmin() then raise insufficient_privilege; end if;
  select * into v_receipt from private.inventory_receipts where id=(p_input->>'receiptId')::uuid for update;
  if not found or v_receipt.status<>'pending' then
   raise exception 'Solo se puede editar una recepción pendiente. Actualiza la lista.';
  end if;
  if not (p_input ? 'expectedRevision') or
   private.accounting_number(p_input,'expectedRevision',2147483647,0)<>v_receipt.revision then
   raise exception 'La recepción cambió. Actualiza la lista antes de editar.';
  end if;
  v_id:=v_receipt.id;
  update private.inventory_receipts set
   incurred_on=v_date,supplier=btrim(p_input->>'supplier'),
   agency=btrim(p_input->>'agency'),reference=btrim(p_input->>'reference'),
   note=btrim(p_input->>'note'),currency=p_input->>'currency',
   exchange_rate=v_rate,shipping_amount=v_shipping,units=v_units,revision=revision+1
  where id=v_id;
  delete from private.inventory_receipt_lines where receipt_id=v_id;
 else
$edit$||insert_marker);
 definition:=replace(definition,end_marker,end_marker||' end if;');
 execute definition;
end $migration$;

create function public.edit_inventory_receipt(p_input jsonb) returns uuid
language plpgsql security definer set search_path='' as $$
begin
 if auth.uid() is null or not private.is_superadmin() then raise insufficient_privilege; end if;
 if p_input->>'receiptId' is null then raise exception 'Selecciona una recepción pendiente.'; end if;
 return private.record_inventory_receipt(p_input);
end $$;
revoke all on function public.edit_inventory_receipt(jsonb) from public,anon;
grant execute on function public.edit_inventory_receipt(jsonb) to authenticated;
notify pgrst,'reload schema';
