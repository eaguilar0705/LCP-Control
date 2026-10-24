-- Caja solo registra ventas. La autorización vive también en PostgreSQL:
-- ocultar pantallas no debe dejar disponibles los mismos cambios por RPC.
do $$
declare v_source text; v_guard text;
begin
 select pg_get_functiondef('private.create_document(jsonb)'::regprocedure) into v_source;
 v_guard:='if v_uid is null or v_role is null or v_role not in (''admin'',''operator'') then raise insufficient_privilege; end if;';
 if strpos(v_source,v_guard)=0 then raise exception 'No se encontró el control de permisos de documentos.'; end if;
 execute replace(v_source,v_guard,
  'if v_uid is null or v_role is null or v_role not in (''admin'',''operator'') or (v_role=''operator'' and v_kind is distinct from ''invoice'') then raise insufficient_privilege; end if;');

 select pg_get_functiondef('private.record_inventory_movement(jsonb)'::regprocedure) into v_source;
 v_guard:='if v_uid is null or v_role is null or v_role not in (''admin'',''operator'',''warehouse'') then raise insufficient_privilege; end if;';
 if strpos(v_source,v_guard)=0 then raise exception 'No se encontró el control de permisos de inventario.'; end if;
 execute replace(v_source,v_guard,
  'if v_uid is null or v_role is null or v_role not in (''admin'',''warehouse'') then raise insufficient_privilege; end if;');

 -- Los clientes nuevos de Caja se registran al emitir la factura. La edición
 -- del directorio, sus listas y estados corresponde a administración.
 select pg_get_functiondef('public.save_customer(jsonb)'::regprocedure) into v_source;
 v_guard:='if v_role is null or v_role not in (''admin'',''operator'') then raise insufficient_privilege; end if;';
 if strpos(v_source,v_guard)=0 then raise exception 'No se encontró el control de permisos de clientes.'; end if;
 execute replace(v_source,v_guard,
  'if v_role is distinct from ''admin'' then raise insufficient_privilege; end if;');
end $$;

alter policy role_scoped_read on public.documents using (
 (select private.staff_role())='admin'
 or ((select private.staff_role())='operator' and kind='invoice' and created_by=(select auth.uid()))
);
alter policy role_scoped_read on public.document_items using (
 (select private.staff_role())='admin'
 or ((select private.staff_role())='operator' and exists(
  select 1 from public.documents d where d.id=document_items.document_id
   and d.kind='invoice' and d.created_by=(select auth.uid())))
);
alter policy role_scoped_read on public.inventory_movements using (
 (select private.staff_role())='admin'
 or ((select private.staff_role())='warehouse' and actor_id=(select auth.uid()))
);
alter policy staff_read on public.customers using (
 (select private.staff_role())='admin'
 or ((select private.staff_role())='operator' and active)
);

-- Se conservan las lecturas de productos, precios y disponibilidad necesarias
-- para elegir productos en la factura. Los costos siguen protegidos por RLS.
