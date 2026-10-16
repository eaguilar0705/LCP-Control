import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const amount = /^(?:0|[1-9][0-9]{0,17})(?:\.[0-9]{1,6})?$/
const usd = /^(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,2})?$/
const sku = /^LCP-[0-9]{4,}$/

function validate(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest))
    throw new Error('El manifiesto debe ser un objeto.')
  if (
    !manifest.source ||
    typeof manifest.source.filename !== 'string' ||
    !manifest.source.filename.trim() ||
    manifest.source.filename.length > 600 ||
    !/^[0-9a-f]{64}$/i.test(manifest.source.sha256 ?? '')
  )
    throw new Error('Indica el archivo fuente y su SHA-256 completo.')
  if (!uuid.test(manifest.actorId ?? ''))
    throw new Error('Indica el UUID del administrador responsable.')
  if (!['initial-cost', 'purchase-reference'].includes(manifest.mode))
    throw new Error('El modo debe ser initial-cost o purchase-reference.')
  if (
    !Array.isArray(manifest.rows) ||
    !manifest.rows.length ||
    manifest.rows.length > 2000
  )
    throw new Error('Incluye entre 1 y 2000 productos.')
  const ids = new Set()
  const skus = new Set()
  for (const row of manifest.rows) {
    if (
      !row ||
      !uuid.test(row.productId ?? '') ||
      !sku.test(row.sku ?? '') ||
      !Number.isSafeInteger(row.expectedRevision) ||
      row.expectedRevision < 1
    )
      throw new Error('Revisa el SKU LCP, UUID y revisión de cada perfume.')
    if (ids.has(row.productId.toLowerCase()) || skus.has(row.sku))
      throw new Error('Un producto o SKU aparece duplicado en el manifiesto.')
    ids.add(row.productId.toLowerCase())
    skus.add(row.sku)
    if (
      typeof row.costNio !== 'string' ||
      !amount.test(row.costNio) ||
      !/[1-9]/.test(row.costNio) ||
      typeof row.costUSD !== 'string' ||
      !usd.test(row.costUSD) ||
      !/[1-9]/.test(row.costUSD)
    )
      throw new Error(
        'Los costos deben ser cadenas decimales positivas: NIO hasta seis decimales y USD hasta dos.',
      )
    if (
      !Number.isSafeInteger(row.sourcePage) ||
      row.sourcePage < 1 ||
      !Number.isSafeInteger(row.sourceRow) ||
      row.sourceRow < 1
    )
      throw new Error('Indica la página y fila originales de cada costo.')
    if (
      row.sizeOz !== undefined &&
      (typeof row.sizeOz !== 'number' ||
        !Number.isFinite(row.sizeOz) ||
        row.sizeOz <= 0 ||
        row.sizeOz > 99999 ||
        Math.abs(row.sizeOz * 1000 - Math.round(row.sizeOz * 1000)) > 1e-7)
    )
      throw new Error(
        'El tamaño opcional debe ser positivo y tener hasta tres decimales.',
      )
  }
}

/**
 * Genera SQL para revisión; nunca se conecta a la base. Por defecto termina en
 * ROLLBACK. initial-cost solo completa promedios desconocidos; purchase-reference
 * conserva los costos en la auditoría. Ambos modos permiten completar una talla
 * desconocida respaldada por la fuente. Ningún modo recalcula precios.
 *
 * source: { filename, sha256 }; actorId: administrador activo;
 * rows: [{ sku, productId, expectedRevision, costNio, costUSD,
 *          sourcePage, sourceRow, sizeOz? }].
 */
export function buildCostImportSql(manifest, { commit = false } = {}) {
  validate(manifest)
  if (typeof commit !== 'boolean') throw new Error('commit debe ser booleano.')
  const payload = JSON.stringify({
    ...manifest,
    source: {
      ...manifest.source,
      sha256: manifest.source.sha256.toLowerCase(),
    },
    actorId: manifest.actorId.toLowerCase(),
    rows: manifest.rows.map((row) => ({
      ...row,
      productId: row.productId.toLowerCase(),
    })),
  })
  let index = 0
  while (
    payload.includes(`$lcp_cost_import_${index}$`) ||
    payload.includes(`$lcp_manifest_${index}$`)
  )
    index++
  const block = `$lcp_cost_import_${index}$`
  const literal = `$lcp_manifest_${index}$`
  return `-- Importación de costos. Revisar el manifiesto antes de ejecutar.
-- El actor queda registrado explícitamente; no se suplanta una sesión de Auth.
-- ${commit ? 'CONFIRMAR: termina en COMMIT.' : 'ENSAYO: termina en ROLLBACK y no conserva los cambios.'}
begin;
set local lock_timeout = '10s';
set local statement_timeout = '120s';
do ${block}
declare
 v_manifest jsonb := ${literal}${payload}${literal}::jsonb;
 v_row jsonb; v_saved jsonb; v_before jsonb; v_after jsonb;
 v_product public.products%rowtype;
 v_average numeric; v_changed boolean; v_outcome text;
 v_actor uuid := (v_manifest->>'actorId')::uuid;
 v_hash text := v_manifest->'source'->>'sha256';
 v_mode text := v_manifest->>'mode';
begin
 if not exists(select 1 from pg_roles where rolname=current_user and (rolsuper or rolbypassrls)) then
  raise insufficient_privilege using message='La importación requiere el ejecutor administrativo de la base.';
 end if;
 if v_mode not in ('initial-cost','purchase-reference')
 or coalesce(v_hash,'') !~ '^[0-9a-f]{64}$'
 or nullif(trim(v_manifest->'source'->>'filename'),'') is null
 or jsonb_typeof(v_manifest->'rows') is distinct from 'array'
 or jsonb_array_length(v_manifest->'rows') not between 1 and 2000 then
  raise exception 'Manifiesto de costos inválido.';
 end if;
 if exists(select 1 from jsonb_array_elements(v_manifest->'rows') x
  where jsonb_typeof(x) is distinct from 'object'
   or coalesce(x->>'sku','') !~ '^LCP-[0-9]{4,}$'
   or coalesce(x->>'productId','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   or jsonb_typeof(x->'expectedRevision') is distinct from 'number'
   or coalesce(x->>'expectedRevision','') !~ '^[1-9][0-9]*$'
   or jsonb_typeof(x->'costNio') is distinct from 'string'
   or coalesce(x->>'costNio','') !~ '^(0|[1-9][0-9]{0,17})([.][0-9]{1,6})?$'
   or jsonb_typeof(x->'costUSD') is distinct from 'string'
   or coalesce(x->>'costUSD','') !~ '^(0|[1-9][0-9]{0,11})([.][0-9]{1,2})?$'
   or jsonb_typeof(x->'sourcePage') is distinct from 'number'
   or coalesce(x->>'sourcePage','') !~ '^[1-9][0-9]*$'
   or jsonb_typeof(x->'sourceRow') is distinct from 'number'
   or coalesce(x->>'sourceRow','') !~ '^[1-9][0-9]*$') then
  raise exception 'Hay filas inválidas en el manifiesto de costos.';
 end if;
 if (select count(distinct x->>'productId') from jsonb_array_elements(v_manifest->'rows') x)<>jsonb_array_length(v_manifest->'rows')
 or (select count(distinct x->>'sku') from jsonb_array_elements(v_manifest->'rows') x)<>jsonb_array_length(v_manifest->'rows') then
  raise exception 'Un producto o SKU aparece duplicado en el manifiesto.';
 end if;
 if exists(select 1 from jsonb_array_elements(v_manifest->'rows') x where (x->>'costNio')::numeric<=0 or (x->>'costUSD')::numeric<=0) then
  raise exception 'Los costos deben ser positivos.';
 end if;

 -- Mismo orden que las operaciones de la tienda; todos los bloqueos preceden
 -- la validación y ninguna fila se escribe hasta validar el lote completo.
 perform pg_advisory_xact_lock(hashtextextended('lcp-business-day',0));
 perform pg_advisory_xact_lock(hashtextextended('staff-administration',0));
 perform 1 from public.staff_members s join private.business_actors a on a.id=s.user_id
  where s.user_id=v_actor and s.active and s.role in ('admin','superadmin') and a.deleted_at is null
  for share of s,a;
 if not found then raise insufficient_privilege using message='El responsable debe ser admin o superadmin activo.'; end if;
 for v_row in select x from jsonb_array_elements(v_manifest->'rows') x order by x->>'productId' loop
  perform pg_advisory_xact_lock(hashtextextended('catalog:'||(v_row->>'productId'),0));
 end loop;
 perform 1 from public.products p where p.id in (select (x->>'productId')::uuid from jsonb_array_elements(v_manifest->'rows') x) order by p.id for update;
 perform 1 from public.product_costs c where c.product_id in (select (x->>'productId')::uuid from jsonb_array_elements(v_manifest->'rows') x) order by c.product_id for update;

 for v_row in select x from jsonb_array_elements(v_manifest->'rows') x order by x->>'productId' loop
  select * into v_product from public.products where id=(v_row->>'productId')::uuid and sku=v_row->>'sku';
  if not found then raise exception 'El UUID no corresponde al SKU %.',v_row->>'sku'; end if;
  select c.after_data->'costImport' into v_saved from private.catalog_changes c
   where c.product_id=v_product.id and c.action='cost_import' and c.after_data->'costImport'->'source'->>'sha256'=v_hash;
  if found then
   if v_saved->>'mode' is distinct from v_mode or ((v_saved->'row')-'expectedRevision') is distinct from (v_row-'expectedRevision') then
    raise exception 'El mismo archivo ya se registró para % con otro modo o contenido.',v_product.sku;
   end if;
   continue;
  end if;
  if v_product.revision is distinct from (v_row->>'expectedRevision')::integer then
   raise exception 'Otro usuario cambió %. Actualiza su revisión antes de importar.',v_product.sku;
  end if;
  if v_row ? 'sizeOz' then
   if jsonb_typeof(v_row->'sizeOz') is distinct from 'number'
    or (v_row->>'sizeOz')::numeric not between 0.001 and 99999
    or (v_row->>'sizeOz')::numeric<>round((v_row->>'sizeOz')::numeric,3)
    or v_product.unit<>'oz'
    or (v_product.size is not null and v_product.size is distinct from (v_row->>'sizeOz')::numeric) then
    raise exception 'El tamaño de % solo puede completar un valor desconocido en oz.',v_product.sku;
   end if;
  end if;
 end loop;

 for v_row in select x from jsonb_array_elements(v_manifest->'rows') x order by x->>'productId' loop
  if exists(select 1 from private.catalog_changes c where c.product_id=(v_row->>'productId')::uuid
   and c.action='cost_import' and c.after_data->'costImport'->'source'->>'sha256'=v_hash) then continue; end if;
  select * into v_product from public.products where id=(v_row->>'productId')::uuid;
  select average_cost_nio into v_average from public.product_costs where product_id=v_product.id;
  v_before:=to_jsonb(v_product)||jsonb_build_object('averageCostNio',v_average,
   'pricing',(select to_jsonb(p) from public.product_pricing p where product_id=v_product.id),
   'prices',private.product_price_rows(v_product.id));
  v_changed:=false;
  v_outcome:=case when v_mode='purchase-reference' then 'reference-only' else 'kept-existing-average' end;
  if v_mode='initial-cost' and v_average is null then
   insert into public.product_costs(product_id,average_cost_nio)
    values(v_product.id,round((v_row->>'costNio')::numeric,6))
    on conflict(product_id) do update set average_cost_nio=excluded.average_cost_nio,updated_at=now()
     where product_costs.average_cost_nio is null;
   v_changed:=true; v_outcome:='initialized-average';
  end if;
  if v_row ? 'sizeOz' and v_product.size is null then
   update public.products set size=(v_row->>'sizeOz')::numeric,
    size_source=(v_manifest->'source'->>'filename')||' p.'||(v_row->>'sourcePage')||' fila '||(v_row->>'sourceRow'),
    size_needs_review=false where id=v_product.id;
   v_changed:=true;
  end if;
  if v_changed then update public.products set revision=revision+1 where id=v_product.id; end if;
  select to_jsonb(p)||jsonb_build_object('averageCostNio',(select c.average_cost_nio from public.product_costs c where c.product_id=p.id),
   'pricing',(select to_jsonb(r) from public.product_pricing r where r.product_id=p.id),
   'prices',private.product_price_rows(p.id)) into v_after from public.products p where p.id=v_product.id;
  if v_after->'prices' is distinct from v_before->'prices' or v_after->'pricing' is distinct from v_before->'pricing' then
   raise exception 'Se detectó un cambio de precios en %. Se cancela toda la importación.',v_product.sku;
  end if;
  insert into private.catalog_changes(product_id,actor_id,action,before_data,after_data)
   values(v_product.id,v_actor,'cost_import',v_before,v_after||jsonb_build_object('costImport',
    jsonb_build_object('source',v_manifest->'source','mode',v_mode,'row',v_row,'outcome',v_outcome)));
 end loop;
end ${block};
${commit ? 'commit;' : 'rollback;'}
`
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const args = process.argv.slice(2)
    const path = args.shift()
    if (!path || path.startsWith('--'))
      throw new Error(
        'Uso: node scripts/import/costos-iniciales.mjs manifiesto.json [--commit] [--output archivo.sql]',
      )
    let output
    let commit = false
    while (args.length) {
      const arg = args.shift()
      if (arg === '--commit') commit = true
      else if (arg === '--output' && args[0]) output = args.shift()
      else throw new Error('Opción desconocida: ' + arg)
    }
    const manifest = JSON.parse(
      (await readFile(path, 'utf8')).replace(/^\uFEFF/, ''),
    )
    const sql = buildCostImportSql(manifest, { commit })
    if (output) await writeFile(output, sql, 'utf8')
    else process.stdout.write(sql)
  } catch (error) {
    process.stderr.write(error.message + '\n')
    process.exitCode = 1
  }
}
