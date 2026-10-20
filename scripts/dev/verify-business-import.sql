-- One read-only result for Supabase CLI db query. No import is invoked and
-- no business records are read. Only the new private registry is counted.
select jsonb_build_object(
  'routines', (
    select jsonb_agg(jsonb_build_object(
      'routine', n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
      'security_definer', p.prosecdef,
      'default_arguments', p.pronargdefaults,
      'configuration', p.proconfig,
      'anon_execute', has_function_privilege('anon', p.oid, 'EXECUTE'),
      'staff_execute', has_function_privilege('authenticated', p.oid, 'EXECUTE')
    ) order by n.nspname, p.proname)
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where (n.nspname, p.proname) in (
      ('public', 'import_business_excel'),
      ('private', 'import_business_excel'),
      ('public', 'save_catalog_product'),
      ('private', 'save_catalog_product_before_excel_import')
    )
  ),
  'registry', (
    select jsonb_build_object(
      'schema_name', n.nspname,
      'table_name', c.relname,
      'rls_enabled', c.relrowsecurity,
      'anon_read', has_table_privilege('anon', c.oid, 'SELECT'),
      'staff_read', has_table_privilege('authenticated', c.oid, 'SELECT'),
      'staff_insert', has_table_privilege('authenticated', c.oid, 'INSERT'),
      'staff_update', has_table_privilege('authenticated', c.oid, 'UPDATE'),
      'staff_delete', has_table_privilege('authenticated', c.oid, 'DELETE')
    )
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'private' and c.relname = 'business_excel_imports'
  ),
  'guards', jsonb_build_object(
    'import_checks_admin', position(
      'private.staff_role() is distinct from ''admin'''
      in pg_get_functiondef('private.import_business_excel(jsonb,boolean)'::regprocedure)
    ) > 0,
    'import_checks_identity', position(
      'v_uid is null'
      in pg_get_functiondef('private.import_business_excel(jsonb,boolean)'::regprocedure)
    ) > 0,
    'saver_checks_admin', position(
      'private.staff_role() is distinct from ''admin'''
      in pg_get_functiondef('public.save_catalog_product(jsonb)'::regprocedure)
    ) > 0,
    'saver_uses_preserved_helper', position(
      'private.save_catalog_product_before_excel_import'
      in pg_get_functiondef('public.save_catalog_product(jsonb)'::regprocedure)
    ) > 0,
    'superadmin_normalized', position(
      'when role=''superadmin'' then ''admin'''
      in pg_get_functiondef('private.staff_role()'::regprocedure)
    ) > 0
  ),
  'migration', (
    select jsonb_build_object(
      'version', version,
      'name', name,
      'matches_expected', name = 'importar_negocio_desde_excel'
    )
    from supabase_migrations.schema_migrations
    where version = '20261019234034'
  ),
  'import_registry_count', (select count(*) from private.business_excel_imports)
) as verification;
