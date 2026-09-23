"""Prepare reviewable, repeatable SQL from the three original price lists. No remote writes."""
import json, hashlib, uuid, sys
from zipfile import ZipFile
import xml.etree.ElementTree as ET
from pathlib import Path
from import_catalog import read, key, FILES

root = Path(__file__).resolve().parents[2]
source = Path(sys.argv[1])
out = root / 'private-data' / 'database-import'
out.mkdir(parents=True, exist_ok=True)
lists = {tier: read(source / filename) for tier, filename in FILES.items()}
indexes = {tier: {key(p): p for p in rows} for tier, rows in lists.items()}
assert all(len(v) == 260 and set(v) == set(indexes['emprendedor']) for v in indexes.values())
arabian = {'Rasasi','Armaf','Lataffa','Afnan','Emper','Al haramain','Dumont','French avenue','Rayhaan','Tubees'}
products=[]
for i,p in enumerate(lists['emprendedor'],1):
    identity=hashlib.sha256('|'.join(key(p)).encode()).hexdigest()
    try: size=float(p['rawSize']); size=size if 0<size<100 else None
    except ValueError: size=None
    products.append(dict(id=str(uuid.uuid5(uuid.NAMESPACE_URL,'lcdp:catalog:'+identity)),import_key=identity,sku=f'LCP-{i:04}',name=p['name'],brand=p['brand'],size=size,size_source=p['rawSize'],category='niche' if p['brand']=='Xerjoff' else 'arabian' if p['brand'] in arabian else None,image_reference=p['imageSource'],catalog_availability='sold_out' if p['availability'].lower()=='agotado' else 'unspecified',row=p['row'],prices={tier:{c:indexes[tier][key(p)][c] for c in ['NIO','USD']} for tier in FILES}))
sqls=[]
for start in range(0,len(products),20):
    payload=json.dumps(products[start:start+20],ensure_ascii=False)
    assert '$catalog$' not in payload, 'Unexpected SQL delimiter in source data'
    sql="""begin;
create temporary table catalog_input on commit drop as select * from jsonb_to_recordset($catalog$"""+payload+"""$catalog$::jsonb) as p(id uuid,import_key text,sku text,name text,brand text,size numeric,size_source text,category text,image_reference text,catalog_availability text,row integer,prices jsonb);
insert into public.brands(name) select distinct brand from catalog_input on conflict(name) do nothing;
insert into public.products(id,import_key,sku,name,brand_id,size,size_source,size_needs_review,category,image_reference,catalog_availability)
select p.id,p.import_key,p.sku,p.name,b.id,p.size,p.size_source,p.size is null,p.category,p.image_reference,p.catalog_availability from catalog_input p join public.brands b on b.name=p.brand on conflict(import_key) do nothing;
insert into public.product_prices(product_id,tier_code,currency,amount)
select target.id,t.key,c.key,c.value::numeric from catalog_input p join public.products target on target.import_key=p.import_key cross join lateral jsonb_each(p.prices) t cross join lateral jsonb_each_text(t.value) c on conflict do nothing;
insert into public.inventory_balances(product_id,location,quantity) select target.id,l.location,null from catalog_input p join public.products target on target.import_key=p.import_key cross join (values('warehouse'),('store')) l(location) on conflict do nothing;
commit;"""
    sqls.append(sql)
sqls.append("insert into public.business_settings(id,name) values(true,'La Casa del Perfume') on conflict(id) do nothing; select setval('private.product_sku_sequence',greatest(1,(select max(substring(sku from '^LCP-([0-9]+)$')::bigint) from public.products)),true);")
(out/'queries.json').write_text(json.dumps(sqls,ensure_ascii=False),encoding='utf8')
(out/'products.json').write_text(json.dumps(products,ensure_ascii=False),encoding='utf8')
provenance=[]
for tier,filename in FILES.items():
    path=source/filename
    with ZipFile(path) as archive:
        sheet=ET.fromstring(archive.read('xl/workbook.xml')).find('{*}sheets/{*}sheet').get('name')
    provenance.append(dict(filename=filename,sha256=hashlib.sha256(path.read_bytes()).hexdigest(),sheet_name=sheet,row_count=len(lists[tier]),rows=[dict(row_number=p['row'],import_key=hashlib.sha256('|'.join(key(p)).encode()).hexdigest(),raw_values=p) for p in lists[tier]]))
(out/'provenance.json').write_text(json.dumps(provenance,ensure_ascii=False),encoding='utf8')
print(json.dumps({'products':len(products),'prices':len(products)*6,'queries':len(sqls)}))
