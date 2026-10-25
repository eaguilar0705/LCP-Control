import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import {
  database,
  identity,
  rpc,
  admin,
  operator,
  warehouse,
  viewer,
  outsider,
} from './database-fixture.mjs'

// Sin red: migraciones reales y reloj controlado solo en esta base desechable.
const db = await database()
const day = '2026-10-25'
const normalAdmin = '66666666-6666-4666-8666-666666666666'
const product = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001'
const uncosted = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000002'
const other = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000003'
const scenarios = []
let checks = 0
let minute = 0
const equal = (actual, expected, reason) => {
  assert.deepEqual(actual, expected, reason)
  checks++
}
const one = async (sql, parameters = []) =>
  (await db.query(sql, parameters)).rows[0]
const rows = async (sql, parameters = []) =>
  (await db.query(sql, parameters)).rows
const call = (name, input) => rpc(db, name, input)
const owner = async (sql, parameters = []) => {
  const previous = (await one('select current_user as role')).role
  assert.match(previous, /^[a-z_]+$/)
  await db.exec('reset role')
  try {
    return await rows(sql, parameters)
  } finally {
    await db.exec('set role ' + previous)
  }
}
const clock = (date = day, offset = 0) =>
  db.query(
    "select set_config('lcp.test_now',$1,false)",
    [new Date(`${date}T13:00:00Z`).getTime() + offset * 60000].map((value) =>
      new Date(value).toISOString(),
    ),
  )
const tick = () => clock(day, minute++)
const transfer = (changes = {}) => ({
  requestId: crypto.randomUUID(),
  productId: product,
  fromLocation: 'warehouse',
  toLocation: 'store',
  quantity: 3,
  note: 'Reposición de Tienda',
  ...changes,
})
const stock = (id = product) =>
  rows(
    'select location,quantity from public.inventory_balances where product_id=$1 order by location',
    [id],
  )
const countTransfers = async () =>
  (await one('select count(*)::int n from public.inventory_transfers')).n
const ledger = async () =>
  (await one('select public.ledger_report($1,$1) r', [day])).r
const accounts = async () => (await ledger()).accounts
const auxiliary = async () => ({
  credits: (await one('select public.credit_accounts($1) r', [day])).r,
  cashflow: (await one('select public.finance_cashflow($1,$1) r', [day])).r,
  automatic: (await one('select public.sales_journal_entries($1,$1) r', [day]))
    .r,
  daily: (await one('select public.get_business_day(null) r')).r.report,
})
const unchangedTables = [
  'public.products',
  'public.product_costs',
  'public.product_pricing',
  'public.product_prices',
  'public.documents',
  'public.document_items',
  'public.document_item_costs',
  'public.inventory_movements',
  'public.inventory_movement_costs',
  'public.purchase_shipments',
  'public.purchase_shipment_lines',
  'public.finance_entries',
  'public.expense_records',
  'public.journal_entries',
  'public.journal_lines',
  'private.inventory_count_gains',
  'private.catalog_changes',
  'private.business_day_events',
]
async function snapshot(tables = unchangedTables) {
  return (
    await owner(
      `select jsonb_build_object(${tables
        .map(
          (table) =>
            `'${table}',(select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]'::jsonb) from ${table} t)`,
        )
        .join(',')}) r`,
    )
  )[0].r
}
async function rejected(name, work, pattern) {
  const tables = [
    ...unchangedTables,
    'public.inventory_transfers',
    'public.inventory_balances',
    'public.business_days',
    'private.rate_limits',
    'private.document_counters',
  ]
  const before = await snapshot(tables)
  await db.exec('savepoint invalid_transfer')
  try {
    await assert.rejects(work, pattern, name)
    checks++
  } finally {
    await db.exec(
      'rollback to savepoint invalid_transfer; release savepoint invalid_transfer',
    )
  }
  equal(await snapshot(tables), before, name + ': ninguna escritura parcial')
}
async function scenario(name, work) {
  await db.exec('begin')
  try {
    await clock()
    await identity(db, admin)
    await work()
    scenarios.push(name)
    console.log('PASS ' + name)
  } finally {
    await db.exec('rollback')
    await identity(db, admin)
  }
}
async function open() {
  return call('open_business_day', {
    requestId: crypto.randomUUID(),
    expectedDay: day,
    openingNio: 1000,
    openingUsd: 0,
  })
}
async function close() {
  const state = (await one('select public.get_business_day(null) r')).r
  return call('close_business_day', {
    requestId: crypto.randomUUID(),
    day,
    expectedRevision: state.revision,
    expectedStateToken: state.stateToken,
    countedNio: state.report.expectedNio,
    countedUsd: state.report.expectedUsd,
    note: '',
  })
}
try {
  await db.exec(
    "create or replace function pg_catalog.now() returns timestamptz language sql stable as $$select current_setting('lcp.test_now')::timestamptz$$",
  )
  await clock()
  await db.query(
    "insert into private.pending_staff(email,display_name,role,active) values($1,'Administración aislada','admin',true)",
    ['administracion@example.invalid'],
  )
  await db.query('insert into auth.users(id,email) values($1,$2)', [
    normalAdmin,
    'administracion@example.invalid',
  ])
  await db.query('update auth.users set email=$1 where id=$2', [
    'bodega@example.invalid',
    warehouse,
  ])
  await db.query(
    "insert into public.staff_members(user_id,display_name,role) values($1,'Propietario aislado','superadmin'),($2,'Caja aislada','operator'),($3,'Bodega aislada','warehouse'),($4,'Consulta aislada','viewer')",
    [admin, operator, warehouse, viewer],
  )
  await db.exec(
    "insert into public.business_settings(name) values('Prueba aislada de traslados'); insert into public.brands(name) values('Marca QA'); update public.exchange_rates set usd_to_nio=36.6",
  )
  for (const [id, sku, cost] of [
    [product, 'QA-TRANSFER', 123.456789],
    [uncosted, 'QA-SIN-COSTO', null],
    [other, 'QA-OTRO', 100],
  ]) {
    await db.query(
      "insert into public.products(id,sku,name,brand_id,size,unit) values($1,$2,$3,(select id from public.brands limit 1),100,'ml')",
      [id, sku, `Perfume ${sku}`],
    )
    await db.query(
      "insert into public.inventory_balances(product_id,location,quantity) values($1,'warehouse',200),($1,'store',20)",
      [id],
    )
    if (cost !== null)
      await db.query(
        'insert into public.product_costs(product_id,average_cost_nio) values($1,$2)',
        [id, cost],
      )
    await db.query(
      "insert into public.product_prices(product_id,tier_code,currency,amount) select $1,t,c,case when c='USD' then 20 else 732 end from unnest(array['emprendedor','vip','premium']) t cross join unnest(array['NIO','USD']) c",
      [id],
    )
  }
  await identity(db, admin)
  await call('record_journal_entry', {
    requestId: crypto.randomUUID(),
    kind: 'opening',
    occurredOn: day,
    description: 'Saldos iniciales aislados',
    reference: 'QA-TRANSFER',
    currency: 'NIO',
    exchangeRate: 1,
    lines: [
      { account: '1110-001', debit: 1000, credit: 0 },
      { account: '1130', debit: 49160.49, credit: 0 },
      { account: '3110-001', debit: 0, credit: 50160.49 },
    ],
  })

  await scenario('Esquema, RLS y separación del historial', async () => {
    const metadata = (
      await owner(
        "select relrowsecurity,relforcerowsecurity from pg_class where oid='public.inventory_transfers'::regclass",
      )
    )[0]
    equal(metadata.relrowsecurity, true)
    equal(
      (
        await owner(
          "select confrelid::regclass::text target from pg_constraint where conrelid='public.inventory_transfers'::regclass and contype='f' and conname='inventory_transfers_actor_id_fkey'",
        )
      )[0].target,
      'private.business_actors',
    )
    equal(
      (
        await owner(
          "select has_table_privilege('authenticated','public.inventory_transfers','SELECT') r",
        )
      )[0].r,
      true,
    )
    for (const permission of ['INSERT', 'UPDATE', 'DELETE'])
      equal(
        (
          await owner('select has_table_privilege($1,$2,$3) r', [
            'authenticated',
            'public.inventory_transfers',
            permission,
          ])
        )[0].r,
        false,
      )
    equal(
      (
        await owner(
          "select has_function_privilege('anon','public.transfer_inventory(jsonb)','EXECUTE') r",
        )
      )[0].r,
      false,
    )
    equal(
      (
        await owner(
          "select has_function_privilege('anon','private.transfer_inventory(jsonb)','EXECUTE') r",
        )
      )[0].r,
      false,
    )
    await rejected(
      'Tienda todavía sin abrir',
      () => call('transfer_inventory', transfer()),
      /tienda está cerrada/i,
    )
  })

  await scenario(
    'SuperAdmin, Admin y Bodega trasladan; Caja, Consulta y anónimo no escriben',
    async () => {
      await open()
      for (const actor of [admin, normalAdmin, warehouse]) {
        await identity(db, actor)
        const input = transfer({ quantity: 1 })
        const id = await call('transfer_inventory', input)
        const saved = await one(
          'select * from public.inventory_transfers where id=$1',
          [id],
        )
        equal(saved.actor_id, actor)
        equal(saved.request_payload, input)
        equal(saved.from_before - saved.from_after, 1)
        equal(saved.to_after - saved.to_before, 1)
        equal(saved.product_sku, 'QA-TRANSFER')
        equal(saved.product_name, 'Perfume QA-TRANSFER')
      }
      equal(await countTransfers(), 3)
      for (const [actor, readable] of [
        [admin, 3],
        [normalAdmin, 3],
        [warehouse, 3],
        [viewer, 3],
        [operator, 0],
        [outsider, 0],
      ]) {
        await identity(db, actor)
        equal(await countTransfers(), readable)
        if ([viewer, operator, outsider].includes(actor))
          await rejected(
            'Sin permiso de traslado ' + actor,
            () => call('transfer_inventory', transfer()),
            /permission denied|insufficient_privilege|Acceso no autorizado/i,
          )
        await rejected(
          'No se inserta directamente ' + actor,
          () =>
            db.query(
              "insert into public.inventory_transfers(request_payload) values('{}')",
            ),
          /permission denied/,
        )
        await rejected(
          'No se modifica directamente ' + actor,
          () => db.query('update public.inventory_transfers set quantity=1'),
          /permission denied/,
        )
        await rejected(
          'No se elimina directamente ' + actor,
          () => db.query('delete from public.inventory_transfers'),
          /permission denied/,
        )
      }
      await identity(db, outsider, 'anon')
      await rejected(
        'RPC anónima',
        () => call('transfer_inventory', transfer()),
        /permission denied/,
      )
      await rejected(
        'Historial anónimo',
        () => db.query('select * from public.inventory_transfers'),
        /permission denied/,
      )
      await identity(db, '')
      await rejected(
        'Sesión sin identidad',
        () => call('transfer_inventory', transfer()),
        /permission denied|insufficient_privilege/i,
      )
    },
  )

  await scenario(
    'Cantidades, ubicaciones, motivos y productos inválidos se rechazan completos',
    async () => {
      await open()
      const cases = [
        ['Sin solicitud', { requestId: null }, /Selecciona un perfume/],
        ['Sin perfume', { productId: null }, /Selecciona un perfume/],
        [
          'Perfume desconocido',
          { productId: crypto.randomUUID() },
          /ya no está disponible/,
        ],
        ['Mismo origen y destino', { toLocation: 'warehouse' }, /diferentes/],
        ['Origen incorrecto', { fromLocation: 'otra' }, /diferentes/],
        ['Destino incorrecto', { toLocation: 'otra' }, /diferentes/],
        ['Origen vacío', { fromLocation: null }, /diferentes/],
        ['Destino vacío', { toLocation: null }, /diferentes/],
        ['Cantidad cero', { quantity: 0 }, /cantidad.*entera/i],
        ['Cantidad negativa', { quantity: -1 }, /cantidad.*entera/i],
        ['Cantidad fraccionaria', { quantity: 1.5 }, /cantidad.*entera/i],
        ['Cantidad como texto', { quantity: '2' }, /cantidad.*entera/i],
        ['Cantidad vacía', { quantity: null }, /cantidad.*entera/i],
        ['Cantidad excesiva', { quantity: 1000001 }, /cantidad.*entera/i],
        [
          'Existencias insuficientes',
          { quantity: 201 },
          /Solo hay 200 unidades/,
        ],
        ['Sin motivo', { note: '   ' }, /motivo/],
        ['Motivo demasiado largo', { note: 'x'.repeat(2001) }, /motivo/],
      ]
      for (const [name, changes, pattern] of cases)
        await rejected(
          name,
          () => call('transfer_inventory', transfer(changes)),
          pattern,
        )
      await owner('update public.products set active=false where id=$1', [
        product,
      ])
      await rejected(
        'Perfume inactivo',
        () => call('transfer_inventory', transfer()),
        /ya no está disponible/,
      )
      await owner('update public.products set active=true where id=$1', [
        product,
      ])
      for (const location of ['warehouse', 'store']) {
        await owner(
          'update public.inventory_balances set quantity=null where product_id=$1 and location=$2',
          [product, location],
        )
        await rejected(
          'Falta conteo ' + location,
          () => call('transfer_inventory', transfer()),
          /conteo inicial.*Bodega y Tienda/,
        )
        await owner(
          "update public.inventory_balances set quantity=case location when 'warehouse' then 200 else 20 end where product_id=$1",
          [product],
        )
        await owner(
          'delete from public.inventory_balances where product_id=$1 and location=$2',
          [product, location],
        )
        await rejected(
          'Falta ubicación ' + location,
          () => call('transfer_inventory', transfer()),
          /conteo inicial.*Bodega y Tienda/,
        )
        await owner(
          'insert into public.inventory_balances(product_id,location,quantity) values($1,$2,$3)',
          [product, location, location === 'warehouse' ? 200 : 20],
        )
      }
      await owner(
        "update public.inventory_balances set quantity=1000000 where product_id=$1 and location='store'",
        [product],
      )
      await rejected(
        'Destino sobre capacidad',
        () => call('transfer_inventory', transfer({ quantity: 1 })),
        /destino superaría 1000000/,
      )
      await owner(
        "update public.inventory_balances set quantity=999999 where product_id=$1 and location='store'",
        [product],
      )
      await call('transfer_inventory', transfer({ quantity: 1 }))
      equal(
        (await stock())[0].quantity,
        1000000,
        'El límite exacto sí permite el traslado',
      )
    },
  )

  await scenario(
    'Traslado máximo e inventario contado sin costo conservan propiedad y valor',
    async () => {
      await open()
      await owner(
        "update public.inventory_balances set quantity=case location when 'warehouse' then 1000000 else 0 end where product_id=$1",
        [product],
      )
      const before = await snapshot()
      const beforeAccounts = await accounts()
      const input = transfer({ quantity: 1000000 })
      await call('transfer_inventory', input)
      equal(await stock(), [
        { location: 'store', quantity: 1000000 },
        { location: 'warehouse', quantity: 0 },
      ])
      await call(
        'transfer_inventory',
        transfer({
          fromLocation: 'store',
          toLocation: 'warehouse',
          quantity: 1000000,
        }),
      )
      equal(await stock(), [
        { location: 'store', quantity: 0 },
        { location: 'warehouse', quantity: 1000000 },
      ])
      await call(
        'transfer_inventory',
        transfer({ productId: uncosted, quantity: 2 }),
      )
      equal(
        (
          await one(
            'select (select average_cost_nio from public.product_costs where product_id=$1) average_cost_nio',
            [uncosted],
          )
        ).average_cost_nio,
        null,
      )
      equal(await snapshot(), before)
      equal(
        await accounts(),
        beforeAccounts,
        'El traslado no crea costo pendiente ni ingreso o pérdida',
      )
    },
  )

  await scenario(
    'Solicitud idempotente no duplica; otros datos no sustituyen el traslado original',
    async () => {
      await open()
      const input = transfer({ note: '  Reposición verificada  ' })
      const id = await call('transfer_inventory', input)
      const state = await snapshot([
        ...unchangedTables,
        'public.inventory_transfers',
        'public.inventory_balances',
        'private.rate_limits',
      ])
      for (let retry = 0; retry < 20; retry++)
        equal(await call('transfer_inventory', input), id)
      equal(
        await snapshot([
          ...unchangedTables,
          'public.inventory_transfers',
          'public.inventory_balances',
          'private.rate_limits',
        ]),
        state,
        'Reintentar no altera registros ni consume límites',
      )
      for (const changes of [
        { quantity: 4 },
        { note: 'Otro motivo' },
        { productId: other },
        { fromLocation: 'store', toLocation: 'warehouse' },
      ])
        await rejected(
          'UUID ya guardado con otros datos',
          () => call('transfer_inventory', { ...input, ...changes }),
          /otros datos/,
        )
      await owner(
        "update public.products set active=false,name='Perfume renombrado',sku='QA-CAMBIADO' where id=$1",
        [product],
      )
      equal(
        await call('transfer_inventory', input),
        id,
        'Un cambio posterior del catálogo no impide confirmar el original',
      )
      const saved = await one(
        'select product_sku,product_name,note from public.inventory_transfers where id=$1',
        [id],
      )
      equal(saved, {
        product_sku: 'QA-TRANSFER',
        product_name: 'Perfume QA-TRANSFER',
        note: 'Reposición verificada',
      })
    },
  )

  await scenario(
    'Jornada cerrada y cambio de fecha bloquean nuevos traslados pero permiten confirmar el guardado',
    async () => {
      await open()
      const input = transfer()
      const id = await call('transfer_inventory', input)
      await clock('2026-10-26')
      equal(await call('transfer_inventory', input), id)
      await rejected(
        'La jornada anterior sigue abierta pero no es la fecha actual',
        () => call('transfer_inventory', transfer()),
        /tienda está cerrada/,
      )
      await clock(day, 1)
      const closed = await close()
      equal(closed.status, 'closed')
      const state = await snapshot([
        ...unchangedTables,
        'public.inventory_transfers',
        'public.inventory_balances',
        'public.business_days',
        'private.rate_limits',
      ])
      equal(await call('transfer_inventory', input), id)
      equal(
        await snapshot([
          ...unchangedTables,
          'public.inventory_transfers',
          'public.inventory_balances',
          'public.business_days',
          'private.rate_limits',
        ]),
        state,
      )
      await rejected(
        'Traslado nuevo con día cerrado',
        () => call('transfer_inventory', transfer()),
        /tienda está cerrada/,
      )
      await rejected(
        'Cambiar UUID o fecha no elude cierre',
        () =>
          call(
            'transfer_inventory',
            transfer({ createdAt: day + 'T12:00:00Z' }),
          ),
        /tienda está cerrada/,
      )
      await clock('2026-10-26')
      equal(
        await call('transfer_inventory', input),
        id,
        'También se confirma después de medianoche',
      )
      await rejected(
        'Nueva fecha todavía sin abrir',
        () => call('transfer_inventory', transfer()),
        /tienda está cerrada/,
      )
    },
  )

  await scenario(
    'La cuota de uso no duplica ni impide confirmar traslados ya guardados',
    async () => {
      await open()
      let first
      let firstId
      for (let index = 0; index < 60; index++) {
        const input = transfer({
          quantity: 1,
          note: `Reposición rápida ${index + 1}`,
        })
        const id = await call('transfer_inventory', input)
        if (index === 0) {
          first = input
          firstId = id
        }
      }
      equal(await countTransfers(), 60)
      await rejected(
        'Traslado 61 en el mismo minuto',
        () => call('transfer_inventory', transfer({ quantity: 1 })),
        /Demasiadas operaciones seguidas/,
      )
      equal(await call('transfer_inventory', first), firstId)
      equal(await countTransfers(), 60)
      equal(await stock(), [
        { location: 'store', quantity: 80 },
        { location: 'warehouse', quantity: 140 },
      ])
      await clock(day, 1)
      await call('transfer_inventory', transfer({ quantity: 1 }))
      equal(await countTransfers(), 61)
      equal(await stock(), [
        { location: 'store', quantity: 81 },
        { location: 'warehouse', quantity: 139 },
      ])
    },
  )

  await scenario(
    'Fallo después de insertar historial y al actualizar existencias revierte todo',
    async () => {
      await open()
      await db.exec('reset role')
      await db.exec(`create function private.qa_fail_transfer_log() returns trigger language plpgsql as $$begin raise exception 'QA fallo tras insertar historial'; end$$;
      create trigger qa_transfer_log after insert on public.inventory_transfers for each row execute function private.qa_fail_transfer_log();`)
      await db.exec('set role authenticated')
      await rejected(
        'Fallo entre historial y existencias',
        () => call('transfer_inventory', transfer()),
        /QA fallo tras insertar historial/,
      )
      await db.exec('reset role')
      await db.exec(`drop trigger qa_transfer_log on public.inventory_transfers; drop function private.qa_fail_transfer_log();
      create function private.qa_fail_transfer_balance() returns trigger language plpgsql as $$begin
        if new.product_id='${product}' and new.location='store' then
          if not exists(select 1 from public.inventory_transfers where product_id=new.product_id) then raise exception 'QA no llegó al historial'; end if;
          raise exception 'QA fallo al actualizar existencias después del historial';
        end if; return new; end$$;
      create trigger qa_transfer_balance after update on public.inventory_balances for each row execute function private.qa_fail_transfer_balance();`)
      await db.exec('set role authenticated')
      await rejected(
        'Fallo en actualización de ubicación',
        () => call('transfer_inventory', transfer()),
        /QA fallo al actualizar existencias después del historial/,
      )
      equal(await countTransfers(), 0)
      equal(await stock(), [
        { location: 'store', quantity: 20 },
        { location: 'warehouse', quantity: 200 },
      ])
      await db.exec('reset role')
      await db.exec(
        'drop trigger qa_transfer_balance on public.inventory_balances; drop function private.qa_fail_transfer_balance()',
      )
      await db.exec('set role authenticated')
      await call('transfer_inventory', transfer())
      equal(
        await countTransfers(),
        1,
        'Al resolver el fallo puede registrarse normalmente',
      )
    },
  )

  await scenario(
    'Eliminar la cuenta conserva autoría e historial del traslado',
    async () => {
      await open()
      await identity(db, warehouse)
      const id = await call('transfer_inventory', transfer())
      await identity(db, admin)
      const before = await one(
        'select * from public.inventory_transfers where id=$1',
        [id],
      )
      await db.query('select public.delete_staff_account($1,$2,$3)', [
        'bodega@example.invalid',
        warehouse,
        'warehouse',
      ])
      equal(
        (
          await owner('select count(*)::int n from auth.users where id=$1', [
            warehouse,
          ])
        )[0].n,
        0,
      )
      equal(
        await one('select * from public.inventory_transfers where id=$1', [id]),
        before,
      )
      equal(
        (
          await owner(
            'select deleted_at is not null deleted from private.business_actors where id=$1',
            [warehouse],
          )
        )[0].deleted,
        true,
      )
    },
  )

  await scenario(
    '500 traslados conservan unidades, costos, precios, snapshots, mayor y auxiliares',
    async () => {
      minute = 0
      await open()
      const invoice = (quantity) =>
        call('create_document', {
          requestId: crypto.randomUUID(),
          kind: 'invoice',
          customerName: 'Cliente de traslados aislados',
          tier: 'emprendedor',
          currency: 'NIO',
          exchangeRate: 1,
          location: 'store',
          paymentMethod: 'cash',
          notes: '',
          items: [{ productId: product, quantity, expectedUnitPrice: 732 }],
        })
      await invoice(2)
      const before = await snapshot()
      const beforeAccounts = await accounts()
      const beforeAuxiliary = await auxiliary()
      const beforeStock = await stock()
      const initialSnapshot = await rows(
        'select * from public.document_item_costs order by document_item_id',
      )
      const expected = { warehouse: 200, store: 18 }
      for (let index = 0; index < 500; index++) {
        await tick()
        const actor = [admin, normalAdmin, warehouse][index % 3]
        await identity(db, actor)
        const from = index % 2 === 0 ? 'warehouse' : 'store'
        const to = from === 'warehouse' ? 'store' : 'warehouse'
        const quantity = 1 + (Math.floor(index / 2) % 15)
        const input = transfer({
          fromLocation: from,
          toLocation: to,
          quantity,
          note: `Reposición operativa ${index + 1}`,
        })
        const originalFrom = expected[from]
        const originalTo = expected[to]
        expected[from] -= quantity
        expected[to] += quantity
        const id = await call('transfer_inventory', input)
        const saved = await one(
          'select * from public.inventory_transfers where id=$1',
          [id],
        )
        equal(saved.actor_id, actor)
        equal(saved.request_payload, input)
        equal(saved.from_before, originalFrom)
        equal(saved.from_after, expected[from])
        equal(saved.to_before, originalTo)
        equal(saved.to_after, expected[to])
        equal(saved.quantity, quantity)
        equal(saved.note, input.note)
        equal(saved.product_sku, 'QA-TRANSFER')
        equal(saved.product_name, 'Perfume QA-TRANSFER')
        equal(await stock(), [
          { location: 'store', quantity: expected.store },
          { location: 'warehouse', quantity: expected.warehouse },
        ])
        equal(expected.store + expected.warehouse, 218)
        if (index % 25 === 0) {
          equal(await call('transfer_inventory', input), id)
          await identity(db, admin)
          equal(await accounts(), beforeAccounts)
          equal(await auxiliary(), beforeAuxiliary)
          equal(
            await rows(
              'select * from public.document_item_costs order by document_item_id',
            ),
            initialSnapshot,
          )
        }
      }
      await identity(db, admin)
      equal(await countTransfers(), 500)
      equal(await stock(), beforeStock)
      equal(await snapshot(), before)
      equal(await accounts(), beforeAccounts)
      equal(await auxiliary(), beforeAuxiliary)
      equal(
        (await one('select count(*)::int n from public.inventory_movements')).n,
        1,
        'Los traslados no usan ENTRY, EXIT ni DAMAGED',
      )
      equal(
        (
          await one(
            'select count(*)::int n from public.inventory_movement_costs',
          )
        ).n,
        0,
      )

      await tick()
      await call(
        'transfer_inventory',
        transfer({ quantity: 37, note: 'Reposición antes de facturar' }),
      )
      equal(await stock(), [
        { location: 'store', quantity: 55 },
        { location: 'warehouse', quantity: 163 },
      ])
      equal(await accounts(), beforeAccounts)
      const document = await invoice(3)
      equal(document.items.length, 1)
      equal(document.total, 2196)
      equal(await stock(), [
        { location: 'store', quantity: 52 },
        { location: 'warehouse', quantity: 163 },
      ])
      equal(
        (
          await one(
            'select average_cost_nio from public.product_costs where product_id=$1',
            [product],
          )
        ).average_cost_nio,
        '123.456789',
      )
      const saleCost = await one(
        'select quantity,unit_cost_nio,net_revenue_nio from public.document_item_costs where document_id=$1',
        [document.id],
      )
      equal(saleCost, {
        quantity: 3,
        unit_cost_nio: '123.456789',
        net_revenue_nio: '2196.00',
      })
      const afterAccounts = await accounts()
      const amount = (list, code, field) =>
        Number(list.find((a) => a.code === code)[field])
      equal(
        Math.round(
          (amount(beforeAccounts, '1130', 'closing') -
            amount(afterAccounts, '1130', 'closing')) *
            100,
        ),
        37037,
      )
      equal(
        Math.round(
          (amount(afterAccounts, '5120', 'debit') -
            amount(beforeAccounts, '5120', 'debit')) *
            100,
        ),
        37037,
      )
      equal((await ledger()).missingCosts, 0)
      equal((await ledger()).missingSales, 0)
      equal(
        Math.round(
          afterAccounts.reduce(
            (sum, a) => sum + Number(a.debit) - Number(a.credit),
            0,
          ) * 100,
        ),
        0,
      )
      equal(
        await rows(
          'select * from public.document_item_costs where document_id<>$1 order by document_item_id',
          [document.id],
        ),
        initialSnapshot,
      )
    },
  )
  const output = 'output/inventory-transfers'
  await mkdir(output, { recursive: true })
  await writeFile(
    `${output}/resultados.json`,
    JSON.stringify(
      { checks, scenarios, transfers: 500, productionWrites: false },
      null,
      2,
    ),
  )
  console.log(
    `OK: ${checks} comprobaciones, ${scenarios.length} escenarios y 500 traslados reales aislados`,
  )
} finally {
  await db.close()
}
