import { admin, identity } from './database-fixture.mjs'

// Sólo datos de lectura para probar páginas: no representa una simulación de
// ventas históricas. Los RPC de escritura se prueban por separado.
export async function seedJournalPages(fixture, manualCount = 600, days = 365) {
  const { db, today } = fixture
  await db.exec('reset role')
  const from = (
    await db.query('select ($1::date-($2::int-1))::text d', [today, days])
  ).rows[0].d
  await db.query(
    "update public.journal_entries set occurred_on=$1 where kind='opening'",
    [from],
  )
  await db.query(
    `insert into public.journal_entries(occurred_on,kind,description,reference,currency,exchange_rate,request_id,request_payload,created_by)
    select $1::date,'adjustment','Comprobante de paginación '||i,'PAG-'||i,'NIO',1,gen_random_uuid(),'{}'::jsonb,$2::uuid
    from generate_series(1,$3::int) i`,
    [today, admin, manualCount],
  )
  await db.exec(`insert into public.journal_lines(entry_id,line_no,account,debit,credit,debit_nio,credit_nio)
    select e.id,v.line_no,v.account,v.debit,v.credit,v.debit,v.credit from public.journal_entries e
    cross join (values (1,'1110-001',1,0),(2,'4110',0,1)) v(line_no,account,debit,credit)
    where e.reference like 'PAG-%'`)
  // El guard exige una jornada abierta para emitir; esta fixture de cabeceras
  // se inserta con rol propietario y desactiva únicamente ese guard local.
  await db.exec(
    'alter table public.documents disable trigger business_day_guard',
  )
  try {
    await db.query(
      `insert into public.documents(kind,number,request_id,request_payload,customer_id,customer_name,issuer,tier_code,currency,total,location,payment_method,created_by,created_at)
      select 'invoice','FAC-PAG-'||i,gen_random_uuid(),'{}'::jsonb,(select id from public.customers limit 1),'Cliente de páginas','{}'::jsonb,
       'emprendedor','NIO',366,'store','cash',$2::uuid,($1::date-i)::timestamp at time zone 'America/Managua'
      from generate_series(0,$3::int-1) i`,
      [today, admin, days],
    )
  } finally {
    await db.exec(
      'alter table public.documents enable trigger business_day_guard',
    )
  }
  // Estos renglones históricos sólo sirven para paginar. No consumen el valor
  // de las existencias actuales ni prueban los triggers de emisión financiera.
  await db.exec(
    'alter table public.document_items disable trigger user; alter table public.document_item_costs disable trigger user',
  )
  try {
    await db.exec(`insert into public.document_items(document_id,product_id,description,quantity,unit_price)
    select d.id,p.id,p.name,1,366 from public.documents d cross join (select id,name from public.products order by sku limit 1) p where d.number like 'FAC-PAG-%';
    insert into public.document_item_costs(document_item_id,document_id,product_id,quantity,unit_cost_nio,total_cost_nio,exchange_rate,tax_rate,net_revenue_nio,tax_nio)
    select i.id,i.document_id,i.product_id,1,100,100,1,0,366,0 from public.document_items i join public.documents d on d.id=i.document_id where d.number like 'FAC-PAG-%';`)
  } finally {
    await db.exec(
      'alter table public.document_items enable trigger user; alter table public.document_item_costs enable trigger user',
    )
  }
  await identity(db, admin)
  return { from, to: today, total: manualCount + 1 + days * 2 }
}
