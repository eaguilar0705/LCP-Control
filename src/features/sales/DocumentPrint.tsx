import { Brand } from '../../components/Brand'
import {
  documentCopy,
  labels,
  returnPolicy,
  type DocumentRecord,
} from '../../lib/domain'
import { formatCurrency, formatDate } from '../../lib/format'
import { equivalentAmount, priceTierLabels } from '../../lib/pricing'
import { includedTax } from './document'
import { printDensity } from './printDensity'

/**
 * Factura o proforma en tamaño carta/A4. La densidad se ajusta sola al número
 * de renglones para que hasta 40 productos quepan en una hoja; los precios,
 * cantidades y descripciones van en negrita para que se lean en cualquier
 * impresora. La misma maqueta se ve en pantalla y en papel.
 */
export function DocumentPrint({ document: d }: { document: DocumentRecord }) {
  const copy = documentCopy[d.kind]
  const density = printDensity(d)
  const tax =
    d.taxRate === undefined || d.taxRate === null
      ? null
      : includedTax(d.total, d.taxRate)
  // La tasa con la que se cotizó el documento. Una factura vieja conserva la
  // suya: el equivalente impreso es el de su día, no el del dólar de hoy.
  const rate = d.catalogRate ?? (d.currency === 'USD' ? d.exchangeRate : null)
  const equivalent = equivalentAmount(d.total, d.currency, rate)
  const units = d.items.reduce((sum, item) => sum + item.quantity, 0)
  return (
    <article
      className={`letter-document letter-${d.kind} letter-density-${density}`}
      data-density={density}
    >
      <header className="letter-header">
        <div className="letter-issuer">
          <Brand wordmark />
          <p>
            {d.issuer.address ||
              'Dirección: __________________________________'}
          </p>
          <p>
            {d.issuer.phone
              ? `Tel. ${d.issuer.phone}`
              : 'Teléfono: ______________'}
            {' · '}RUC: ______________
          </p>
        </div>
        <div className="letter-stamp">
          <strong>{copy.stamp}</strong>
          <b>{d.number}</b>
          <span>
            {d.previewKind === 'example'
              ? 'EJEMPLO · SIN EMITIR'
              : d.previewKind === 'draft'
                ? 'BORRADOR · SIN EMITIR'
                : 'DOCUMENTO EMITIDO'}
          </span>
          <p>Fecha: {formatDate(d.createdAt)}</p>
        </div>
      </header>
      <section className="letter-client" aria-label="Datos del cliente">
        <p className="letter-client-name">
          <small>CLIENTE / RAZÓN SOCIAL</small>
          <strong>{d.customerName}</strong>
        </p>
        <p>
          <small>RUC / ID</small>
          <span>{d.customerTaxId || '______________'}</span>
        </p>
        <p>
          <small>TELÉFONO</small>
          <span>{d.customerPhone || '______________'}</span>
        </p>
        <p>
          <small>LISTA · MONEDA</small>
          <span>
            {priceTierLabels[d.tier]} ·{' '}
            {d.currency === 'NIO' ? 'Córdobas (C$)' : 'Dólares (US$)'}
          </span>
        </p>
        <p>
          <small>{d.kind === 'proforma' ? 'VIGENCIA' : 'PAGO'}</small>
          <span>
            {d.kind === 'proforma'
              ? d.validUntil
                ? formatDate(d.validUntil)
                : '____________'
              : d.paymentMethod && d.paymentMethod !== 'pending'
                ? labels.payment[d.paymentMethod]
                : 'Pendiente'}
          </span>
        </p>
        {d.currency === 'USD' && d.exchangeRate != null && (
          <p>
            <small>TIPO DE CAMBIO</small>
            <span>{d.exchangeRate} NIO por USD</span>
          </p>
        )}
        <p className="letter-client-address">
          <small>DIRECCIÓN</small>
          <span>________________________________________</span>
        </p>
      </section>
      <table className="letter-items">
        <colgroup>
          <col className="letter-col-line" />
          <col className="letter-col-quantity" />
          <col className="letter-col-description" />
          <col className="letter-col-money" />
          <col className="letter-col-money" />
        </colgroup>
        <thead>
          <tr>
            <th scope="col">N.º</th>
            <th scope="col">CANT.</th>
            <th scope="col">DESCRIPCIÓN</th>
            <th scope="col">PRECIO UNIT.</th>
            <th scope="col">IMPORTE</th>
          </tr>
        </thead>
        <tbody>
          {d.items.map((item, index) => (
            <tr key={item.id}>
              <td className="letter-line">{index + 1}</td>
              <td className="letter-quantity">{item.quantity}</td>
              <td className="letter-description">{item.description}</td>
              <td className="letter-money">
                {formatCurrency(item.unitPrice, d.currency)}
              </td>
              <td className="letter-money">
                {formatCurrency(item.lineTotal, d.currency)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <section className="letter-summary">
        <div className="letter-notes">
          <p className="letter-count">
            {d.items.length} {d.items.length === 1 ? 'producto' : 'productos'} ·{' '}
            {units} {units === 1 ? 'unidad' : 'unidades'}
          </p>
          <small>OBSERVACIONES</small>
          <p>{d.notes || 'Gracias por elegir La Casa del Perfume.'}</p>
          {d.kind === 'invoice' && d.location && (
            <p>Entrega desde: {labels.location[d.location]}</p>
          )}
        </div>
        <div className="letter-totals">
          <p>
            <span>
              {tax ? 'Subtotal sin impuesto' : 'Subtotal (sin desglose)'}
            </span>
            <b>{formatCurrency(tax?.net ?? d.total, d.currency)}</b>
          </p>
          {tax && (
            <p>
              <span>Impuesto incluido ({d.taxRate} %)</span>
              <b>{formatCurrency(tax.tax, d.currency)}</b>
            </p>
          )}
          <p className="letter-grand-total">
            <span>TOTAL {d.currency}</span>
            <b>{formatCurrency(d.total, d.currency)}</b>
          </p>
          {equivalent && (
            <p className="letter-equivalent">
              <span>Equivale a</span>
              <b>
                {formatCurrency(equivalent.amount, equivalent.currency)}
                <small>a {rate} C$ por dólar</small>
              </b>
            </p>
          )}
        </div>
      </section>
      <div className="letter-signatures">
        <span>Elaborado por</span>
        <span>
          {d.kind === 'invoice' ? 'Recibido por' : 'Aceptación del cliente'}
        </span>
      </div>
      <footer className="letter-footer">
        <strong>Gracias por tu confianza.</strong>
        {d.kind === 'invoice' && (
          <p className="letter-policy">
            <b>{returnPolicy.title}</b> {returnPolicy.text}
          </p>
        )}
        <p>
          {d.previewKind === 'example'
            ? 'Ejemplo de diseño. No registra una venta ni modifica inventario. '
            : d.previewKind === 'draft'
              ? 'Borrador sin emitir. '
              : ''}
          {d.kind === 'invoice'
            ? 'Documento de control administrativo. No es comprobante fiscal. El desglose usa la tasa de impuesto registrada.'
            : 'Cotización sujeta a disponibilidad. No constituye factura ni comprobante de pago.'}
        </p>
      </footer>
    </article>
  )
}
