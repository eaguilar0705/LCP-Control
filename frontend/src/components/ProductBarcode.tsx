import { useEffect, useRef } from 'react'
import JsBarcode from 'jsbarcode'
import { Button } from './ui'
export function ProductBarcode({ code }: { code: string }) {
  const ref = useRef<SVGSVGElement>(null)
  useEffect(() => {
    if (ref.current)
      JsBarcode(ref.current, code, {
        format: 'CODE128',
        width: 2,
        height: 60,
        fontSize: 14,
        margin: 14,
      })
  }, [code])
  function download() {
    if (!ref.current) return
    const blob = new Blob(
      [new XMLSerializer().serializeToString(ref.current)],
      { type: 'image/svg+xml' },
    )
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${code}.svg`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  return (
    <div className="barcode-preview">
      <svg ref={ref} role="img" aria-label={`Código interno ${code}`} />
      <small>Etiqueta interna · No es el EAN/UPC del fabricante</small>
      <Button variant="secondary" onClick={download}>
        Descargar etiqueta
      </Button>
    </div>
  )
}
