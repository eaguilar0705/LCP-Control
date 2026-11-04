import assert from 'node:assert/strict'
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
const db = await database()
let checks = 0
const eq = (a, b, msg) => {
  assert.deepEqual(a, b, msg)
  checks++
}
const rejected = async (p, pattern) => {
  await assert.rejects(p, pattern)
  checks++
}
const get = async (sql, args = []) => (await db.query(sql, args)).rows[0]
const list = async () => (await get('select public.ledger_accounts_list() r')).r
const account = async (code) => (await list()).find((a) => a.code === code)
const change = (input) =>
  rpc(db, 'change_ledger_account', { requestId: crypto.randomUUID(), ...input })
const setState = async (code, active) => {
  const a = await account(code)
  return change({
    action: active ? 'activate' : 'deactivate',
    code,
    expectedRevision: a.revision,
  })
}
const ledger = async () =>
  (await get("select public.ledger_report('2026-11-03','2026-11-03') r")).r
try {
  await db.exec(
    "create or replace function pg_catalog.now() returns timestamptz language sql stable as $$select '2026-11-03T18:00:00Z'::timestamptz$$",
  )
  await db.query(
    "insert into public.staff_members(user_id,display_name,role) values($1,'Administrador','admin'),($2,'Caja','operator'),($3,'Bodega','warehouse'),($4,'Consulta','viewer'),($5,'Propietario','superadmin')",
    [admin, operator, warehouse, viewer, outsider],
  )
  await identity(db, admin)
  eq((await account('4120')).active, false)
  eq(
    (await account('2117')).restriction,
    'Cuenta necesaria para las operaciones del sistema.',
  )
  let a = await change({
    action: 'create',
    code: '5130-900',
    name: 'Gasto propio',
    parent: '5130',
  })
  eq([a.bucket, a.nature, a.active, a.revision], ['expense', 'debit', true, 0])
  await rejected(
    change({
      action: 'create',
      code: a.code,
      name: 'Duplicada',
      parent: '5130',
    }),
    /ya está registrado/,
  )
  for (const input of [
    { code: 'abc', name: 'Cuenta', parent: '5130' },
    { code: '2222', name: 'Cuenta', parent: '5130' },
    { code: '5130-901', name: ' ', parent: '5130' },
    { code: '5130-901', name: 'a'.repeat(161), parent: '5130' },
  ])
    await rejected(
      change({ action: 'create', ...input }),
      /Revisa|mismo tipo|nombre/,
    )
  const rename = {
    requestId: crypto.randomUUID(),
    action: 'rename',
    code: a.code,
    name: 'Nombre corregido',
    expectedRevision: 0,
  }
  a = await rpc(db, 'change_ledger_account', rename)
  eq(a.revision, 1)
  eq(
    await rpc(db, 'change_ledger_account', rename),
    a,
    'reintento devuelve la edición original',
  )
  await rejected(
    rpc(db, 'change_ledger_account', { ...rename, name: 'Datos cambiados' }),
    /solicitud.*cambió/,
  )
  await rejected(
    change({
      action: 'rename',
      code: a.code,
      name: 'Otra ventana',
      expectedRevision: 0,
    }),
    /cuenta cambió/,
  )
  eq(
    (
      await get('select public.get_operation_confirmation($1,$2) r', [
        'ledger-account-change',
        rename.requestId,
      ])
    ).r.status,
    'confirmed',
  )
  const retired = {
    requestId: crypto.randomUUID(),
    action: 'rename',
    code: a.code,
    name: 'No guardar',
    expectedRevision: 1,
  }
  eq(
    (
      await get('select public.retire_unconfirmed_operation($1,$2) r', [
        'ledger-account-change',
        retired.requestId,
      ])
    ).r.status,
    'retired',
  )
  await rejected(rpc(db, 'change_ledger_account', retired), /descartada/)
  eq(
    (await account(a.code)).revision,
    1,
    'descartar un guardado revierte el cambio tardío',
  )
  await rpc(db, 'save_ledger_account', {
    code: a.code,
    name: 'Importación compatible',
    parent: '5130',
  })
  eq(
    (await account(a.code)).revision,
    2,
    'la importación previa también incrementa la revisión',
  )
  await rejected(
    change({
      action: 'rename',
      code: a.code,
      name: 'No pisar importación',
      expectedRevision: 1,
    }),
    /cuenta cambió/,
  )
  const child = await change({
    action: 'create',
    code: '5130-900-001',
    name: 'Subcuenta',
    parent: a.code,
  })
  await rejected(setState(a.code, false), /subcuentas activas/)
  await setState(child.code, false)
  await setState(a.code, false)
  await rejected(setState(child.code, true), /cuenta mayor/)
  await rejected(
    change({
      action: 'create',
      code: '5130-900-002',
      name: 'Otra subcuenta',
      parent: a.code,
    }),
    /cuenta mayor activa/,
  )
  await rejected(
    rpc(db, 'save_ledger_account', {
      code: '5130-902',
      name: 'Importación bajo cuenta inactiva',
      parent: a.code,
    }),
    /mayor válida/,
  )
  await setState(a.code, true)
  await setState(child.code, true)
  eq((await account(child.code)).active, true)
  const management = await change({
    action: 'create',
    code: '4190-002',
    name: 'Gestión adicional',
    parent: '4190',
  })
  eq(
    [management.bucket, management.nature, management.parent],
    ['revenue', 'credit', '4190'],
  )
  for (const code of [
    '1110-001',
    '1120-001',
    '1130',
    '1140',
    '1142',
    '2111',
    '2112',
    '2117',
    '4110',
    '4190',
    '5120',
    '5130-011',
    '6000',
    '1000',
    '2100',
    '5130',
  ])
    await rejected(setState(code, false), /necesaria/)
  await rejected(setState('4120', true), /Cuenta retirada/)
  for (const uid of [operator, warehouse, viewer]) {
    await identity(db, uid)
    await rejected(list(), /permission|insufficient/i)
    await rejected(
      change({
        action: 'create',
        code: '5130-990',
        name: 'Sin permiso',
        parent: '5130',
      }),
      /permission|insufficient/i,
    )
  }
  await identity(db, '', 'anon')
  await rejected(list(), /permission/)
  await identity(db, outsider)
  const used = await change({
    action: 'create',
    code: '5130-901',
    name: 'Cuenta con movimientos',
    parent: '5130',
  })
  await rpc(db, 'record_journal_entry', {
    requestId: crypto.randomUUID(),
    kind: 'opening',
    occurredOn: '2026-11-03',
    description: 'Apertura aislada',
    currency: 'NIO',
    exchangeRate: 1,
    lines: [
      { account: '1110-001', debit: 5000, credit: 0 },
      { account: '3110-001', debit: 0, credit: 5000 },
    ],
  })
  await rpc(db, 'open_business_day', {
    requestId: crypto.randomUUID(),
    openingNio: 5000,
    openingUsd: 0,
  })
  const journal = {
    requestId: crypto.randomUUID(),
    kind: 'expense',
    occurredOn: '2026-11-03',
    description: 'Gasto aislado',
    currency: 'NIO',
    exchangeRate: 1,
    lines: [
      { account: used.code, debit: 200, credit: 0 },
      { account: '1110-001', debit: 0, credit: 200 },
    ],
  }
  const id = await rpc(db, 'record_journal_entry', journal)
  const before = await ledger()
  await setState(used.code, false)
  const after = await ledger()
  eq(
    after.accounts.find((r) => r.code === used.code).closing,
    200,
    'los estados conservan el saldo de una cuenta desactivada',
  )
  eq(after.accounts.find((r) => r.code === used.code).active, false)
  eq(
    after.accounts
      .filter((r) => r.postable)
      .reduce((sum, r) => sum + r.debit - r.credit, 0),
    0,
  )
  eq(
    after.accounts.find((r) => r.code === '1110-001').closing,
    before.accounts.find((r) => r.code === '1110-001').closing,
    'desactivar no cambia dinero',
  )
  eq(
    (await get('select public.get_journal_entry($1) r', [id])).r.lines.some(
      (l) => l.account === used.code,
    ),
    true,
    'el comprobante conserva su cuenta',
  )
  await rejected(
    rpc(db, 'record_journal_entry', {
      ...journal,
      requestId: crypto.randomUUID(),
    }),
    /Cuenta no disponible/,
  )
  await rejected(
    db.query('update public.ledger_accounts set active=true where code=$1', [
      used.code,
    ]),
    /permission/,
  )
  await rejected(
    db.query('delete from public.ledger_accounts where code=$1', [used.code]),
    /permission/,
  )
  await rejected(
    db.query('select * from private.ledger_account_changes'),
    /permission/,
  )
  const day = (await get('select public.get_business_day(null) r')).r
  const closed = await rpc(db, 'close_business_day', {
    requestId: crypto.randomUUID(),
    day: day.day,
    expectedRevision: day.revision,
    expectedStateToken: day.stateToken,
    countedNio: 4800,
    countedUsd: 0,
    note: '',
  })
  await setState(used.code, true)
  eq(
    (await get('select public.get_business_day(null) r')).r.report,
    closed.report,
    'la gestión de cuentas no cambia el cierre',
  )
  await db.exec('reset role')
  const history = (
    await db.query(
      'select action,actor_name,before_snapshot,after_snapshot from private.ledger_account_changes where account_code=$1 order by created_at,id',
      [used.code],
    )
  ).rows
  eq(history.length, 3)
  eq(
    history.every(
      (h) =>
        h.after_snapshot.code === used.code && h.actor_name === 'Propietario',
    ),
    true,
  )
  console.log(
    `PASS administración de cuentas: ${checks} comprobaciones de permisos, alta, nombre, retiro, reactivación, protección, concurrencia, recuperación y conservación de saldos e historial.`,
  )
} finally {
  await db.close()
}
