"""Read the three source price lists without changing them. Python stdlib only.
Usage: python scripts/import_catalog.py SOURCE_DIRECTORY
"""
import hashlib
import json
import re
import sys
from collections import Counter
from pathlib import Path
from zipfile import ZipFile
import xml.etree.ElementTree as ET

NS = {'m': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
FILES = {'emprendedor': 'Lista Mayor EMPRENDEDOR 1.xlsx', 'vip': 'Lista Mayor VIP 2.xlsx', 'premium': 'Lista Mayor PREMIUM 3.xlsx'}
ROOT = Path(__file__).resolve().parents[2]

def read(path):
    with ZipFile(path) as archive:
        strings = [''.join(n.itertext()) for n in ET.fromstring(archive.read('xl/sharedStrings.xml')).findall('m:si', NS)]
        root = ET.fromstring(archive.read('xl/worksheets/sheet1.xml'))
        records = []
        brand = ''
        for row in root.findall('.//m:sheetData/m:row', NS):
            number = int(row.get('r'))
            if number < 9: continue
            values = {}; formulas = {}
            for cell in row:
                col = re.sub(r'\d', '', cell.get('r'))
                v = cell.find('m:v', NS)
                value = v.text if v is not None else ''
                if cell.get('t') == 's' and value: value = strings[int(value)]
                values[col] = value
                f = cell.find('m:f', NS)
                if f is not None and f.text: formulas[col] = f.text
            if not values.get('B') or not values.get('D'): continue
            brand = values.get('A') or brand
            name = ' '.join(values['B'].split())
            link = re.search(r'HYPERLINK\("(https://drive\.google\.com/file/d/[A-Za-z0-9_-]+/[^"\s]*)"', formulas.get('J', ''), re.I)
            records.append({'row': number, 'brand': brand.strip(), 'name': name, 'rawSize': values.get('C', ''), 'USD': float(values['D']), 'NIO': float(values['E']), 'availability': values.get('F', '').strip(), 'imageSource': link.group(1) if link else None})
        return records

def key(record): return (record['brand'], record['name'], record['rawSize'])

def build(source):
    lists = {tier: read(source / name) for tier, name in FILES.items()}
    indexes = {tier: {key(r): r for r in rows} for tier, rows in lists.items()}
    for tier, rows in lists.items():
        assert len(indexes[tier]) == len(rows), f'Duplicate product in {tier}'
        assert indexes[tier].keys() == indexes['emprendedor'].keys(), f'Catalog differs in {tier}'
    products = []; issues = []
    arabian = {'Rasasi', 'Armaf', 'Lataffa', 'Afnan', 'Emper', 'Al haramain', 'Dumont', 'French avenue', 'Rayhaan', 'Tubees', 'Maison Alhambra', 'Ahmed al maghribi', 'Zimaya', 'Al Wataniah'}
    for record in lists['emprendedor']:
        identity = '|'.join(key(record))
        sku = 'LCP-' + hashlib.sha256(identity.encode()).hexdigest()[:10].upper()
        raw = record['rawSize']
        size = float(raw) if re.fullmatch(r'\d+(\.\d+)?', raw) and 0 < float(raw) < 100 else None
        if size is None: issues.append(f"Fila {record['row']}: {record['name']}, tamaño original {raw!r}; pendiente de confirmar.")
        name = record['name']; lower = name.lower()
        gender = 'female' if re.search(r'\b(women|woman|femme|donna|girl)\b', lower) else 'male' if re.search(r'\b(men|man|him|homme|uomo)\b', lower) else 'unspecified'
        category = 'niche' if record['brand'] == 'Xerjoff' else 'arabian' if record['brand'] in arabian else 'unspecified' if record['brand'] in {'Bharara', 'Ariana grande'} else 'designer'
        image = record['imageSource']
        image_id = re.search(r'/d/([^/]+)', image).group(1) if image else None
        products.append({'id': sku.lower(), 'barcode': sku, 'barcodeKind': 'internal', 'manufacturerBarcode': None, 'name': name, 'brand': record['brand'], 'category': category, 'gender': gender, 'size': size, 'unit': 'oz', 'price': record['NIO'], 'currency': 'NIO', 'prices': {tier: {c: indexes[tier][key(record)][c] for c in ['NIO', 'USD']} for tier in FILES}, 'minimumStock': None, 'active': True, 'availabilityNote': 'Agotado en lista' if record['availability'].lower() == 'agotado' else 'Por confirmar', 'imageUrl': f'https://drive.google.com/thumbnail?id={image_id}&sz=w400' if image_id else None, 'imageSource': image, 'sourceRow': record['row'], 'sizeSource': raw})
    # Real price lists never go into src/ or Git: the app bundle and the public repository must not carry them.
    target = ROOT/'private-data/catalog.json'; target.parent.mkdir(exist_ok=True)
    target.write_text(json.dumps(products, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
    report = f'''# Catálogo de las listas mayoristas

Importación de {len(products)} referencias únicas presentes en los tres archivos: {', '.join(FILES.values())}. No se modificaron los originales ni se incluyeron en Git.

Cada referencia conserva marca, nombre y presentación de origen, fila, precios independientes NIO/USD para Emprendedor, VIP y Premium y enlace a la foto. La clave de unión es marca + nombre + tamaño, no el número de fila. Se verificó igualdad de referencias entre listas y ausencia de duplicados de esa clave.

Hay {sum(bool(p['imageUrl']) for p in products)} enlaces a fotos. Se presentan desde Google Drive con enlace al original y estado visible si no cargan. No se descargaron ni reemplazaron por fotos de otras presentaciones. {sum(not p['imageUrl'] for p in products)} referencias no incluyen enlace.

Los códigos LCP son identificadores internos deterministas; no son EAN/UPC del fabricante. manufacturerBarcode queda vacío. La API de UPCitemdb permite buscar productos y devuelve URLs de imágenes, pero requiere validar la coincidencia exacta antes de incorporar un GTIN: https://www.upcitemdb.com/wp/docs/main/development/responses/ . Las variaciones requieren GTIN distintos: https://support.gs1.org/support/solutions/articles/43000734071-how-many-gs1-gtins-do-i-need-for-my-products- .

No hay saldos por Bodega/Tienda ni mínimos. UNDS es un campo vacío para pedidos, y los totales calculados en cero no son inventario. «Agotado» se conserva como nota de la lista, no como saldo cero. No se deduce un tipo de cambio de los precios ni se inventa precio al detalle, impuestos o requisitos para acceder a cada tarifa.

Se conserva oz, sin conversión automática a ml. Género se extrae solo de palabras explícitas del nombre; el resto queda Por confirmar. Categoría es una clasificación inicial por marca para facilitar filtros, revisable por los dueños; no consta como columna de los Excel. Los sets y sprays conservan su nombre íntegro.

## Tamaños por revisar

'''+ '\n'.join('- '+issue for issue in issues)+'\n'
    (ROOT/'docs/discovery/catalog-import.md').write_text(report, encoding='utf-8')
    print(json.dumps({'products':len(products),'images':sum(bool(p['imageUrl']) for p in products),'brands':dict(Counter(p['brand'] for p in products)),'issues':issues},ensure_ascii=False))

if __name__ == '__main__': build(Path(sys.argv[1]))
