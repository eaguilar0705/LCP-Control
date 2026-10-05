declare module 'jsbarcode' {
  // Un objeto vacío como destino activa el renderizador «object»: en vez de
  // dibujar, JsBarcode deja en él el patrón de barras («0» claro, «1» oscuro).
  // Lo usan las pruebas para fabricar una imagen sin navegador.
  export interface BarcodeEncodings {
    encodings?: { data?: string }[]
  }
  export default function JsBarcode(
    element: SVGSVGElement | BarcodeEncodings,
    text: string,
    options?: {
      format?: string
      width?: number
      height?: number
      displayValue?: boolean
      fontSize?: number
      margin?: number
    },
  ): void
}
