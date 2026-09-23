import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import JsBarcode, { type BarcodeEncodings } from 'jsbarcode'
import QRCode from 'qrcode'

// Chrome's fake capture device reads an uncompressed Y4M file and loops it, so
// the code is drawn straight into the luma plane instead of being decoded from
// an image first. Generating it here keeps a multi-megabyte video out of Git.

const WIDTH = 640
const HEIGHT = 480
const FRAMES = 3
const WHITE = 235 // Studio-range white and black: nothing is clipped.
const BLACK = 16

function blankLuma(): Buffer {
  return Buffer.alloc(WIDTH * HEIGHT, WHITE)
}

function write(luma: Buffer, path: string): string {
  // 4:2:0 chroma held at neutral grey keeps the picture monochrome.
  const chroma = Buffer.alloc((WIDTH * HEIGHT) / 2, 128)
  const header = Buffer.from(
    `YUV4MPEG2 W${WIDTH} H${HEIGHT} F15:1 Ip A1:1 C420\n`,
  )
  const frame = Buffer.concat([Buffer.from('FRAME\n'), luma, chroma])
  const absolute = resolve(path)
  mkdirSync(dirname(absolute), { recursive: true })
  writeFileSync(
    absolute,
    Buffer.concat([header, ...Array.from({ length: FRAMES }, () => frame)]),
  )
  return absolute
}

/**
 * Writes a Y4M clip showing `value` as a QR code and returns its path. Pass it
 * to Chrome as --use-file-for-fake-video-capture to feed the scanner a readable
 * code without a real camera. QR survives the downscaling the browser applies
 * on a narrow viewport, so this is the default for camera tests.
 */
export function writeQrVideo(value: string, path: string): string {
  const { modules } = QRCode.create(value, { errorCorrectionLevel: 'M' })
  const side = modules.size
  // Largest whole-pixel module that still leaves a quiet zone of four modules.
  const moduleSize = Math.floor((HEIGHT * 0.5) / (side + 8))
  const codeSize = moduleSize * side
  const left = Math.floor((WIDTH - codeSize) / 2)
  const top = Math.floor((HEIGHT - codeSize) / 2)

  const luma = blankLuma()
  for (let row = 0; row < side; row++)
    for (let column = 0; column < side; column++) {
      if (!modules.data[row * side + column]) continue
      const x = left + column * moduleSize
      for (
        let y = top + row * moduleSize;
        y < top + (row + 1) * moduleSize;
        y++
      )
        luma.fill(BLACK, y * WIDTH + x, y * WIDTH + x + moduleSize)
    }
  return write(luma, path)
}

/**
 * The same, as a CODE128 barcode: the format the app prints on its shelf
 * labels. A one-dimensional code needs far more horizontal resolution than a
 * QR, so it only decodes where the video is shown wide (desktop viewports).
 */
export function writeBarcodeVideo(value: string, path: string): string {
  const encoded: BarcodeEncodings = {}
  JsBarcode(encoded, value, { format: 'CODE128', displayValue: false })
  const pattern = encoded.encodings?.[0]?.data
  if (!pattern) throw new Error(`No se pudo codificar "${value}" como CODE128.`)

  const moduleWidth = Math.max(2, Math.floor((WIDTH * 0.88) / pattern.length))
  const barsWidth = moduleWidth * pattern.length
  const left = Math.floor((WIDTH - barsWidth) / 2)
  const top = Math.floor(HEIGHT * 0.3)
  const bottom = Math.floor(HEIGHT * 0.7)

  const luma = blankLuma()
  for (let index = 0; index < pattern.length; index++) {
    if (pattern[index] !== '1') continue
    const x = left + index * moduleWidth
    for (let y = top; y < bottom; y++)
      luma.fill(BLACK, y * WIDTH + x, y * WIDTH + x + moduleWidth)
  }
  return write(luma, path)
}
