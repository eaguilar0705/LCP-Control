-- El primer intento de costos se aplicó como cuatro migraciones sueltas y luego
-- se reescribió el registro a mano: quedaron dos filas que ya no describen nada
-- del proyecto. «product_costs» (20260914120000) no guardó sus sentencias y su
-- tabla la retiró 20260914051000; además ordena después de las migraciones
-- nuevas, así que cualquier revisión posterior las leería fuera de secuencia.
-- Se retiran las dos filas: lo que de verdad ocurrió queda contado en el
-- comentario de 20260914051000, con el SQL que lo deshace a la vista.
-- El registro sólo existe en un proyecto de Supabase; en las pruebas locales
-- este bloque no encuentra la tabla y no hace nada.
do $$
begin
  if to_regclass('supabase_migrations.schema_migrations') is not null then
    delete from supabase_migrations.schema_migrations
    where version in ('20260914040519', '20260914120000');
  end if;
end $$;
