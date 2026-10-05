import type { Product } from '../../lib/domain'
import { barcodeSchema } from '../../lib/validation'
import { errorMessage } from '../../lib/errors'
import { cameraMessage, type ScannerAdapter } from './adapter'
export type ScanState =
  | { status: 'idle' | 'starting' | 'scanning' | 'looking' }
  | { status: 'error'; message: string }
  | { status: 'unknown'; code: string }
  | { status: 'found'; code: string; product: Product }
export class ScannerSession {
  private generation = 0
  private accepted = false
  constructor(
    private adapter: ScannerAdapter,
    private find: (code: string) => Promise<Product | null>,
    private emit: (state: ScanState) => void,
  ) {}
  async start() {
    const generation = ++this.generation
    this.accepted = true
    await this.adapter.stop().catch(() => {})
    if (generation !== this.generation) return
    this.accepted = false
    this.emit({ status: 'starting' })
    try {
      await this.adapter.start((code) => {
        void this.decode(code, generation)
      })
      if (generation === this.generation && !this.accepted)
        this.emit({ status: 'scanning' })
    } catch (error) {
      await this.adapter.stop().catch(() => {})
      if (generation === this.generation)
        this.emit({ status: 'error', message: cameraMessage(error) })
    }
  }
  async lookup(code: string) {
    const generation = ++this.generation
    this.accepted = true
    await this.adapter.stop().catch(() => {})
    if (generation !== this.generation) return
    this.accepted = false
    await this.decode(code, generation)
  }
  private async decode(raw: string, generation: number) {
    if (generation !== this.generation || this.accepted) return
    this.accepted = true // Synchronous latch: concurrent frames cannot duplicate a lookup.
    const parsed = barcodeSchema.safeParse(raw)
    await this.adapter.stop().catch(() => {})
    if (generation !== this.generation) return
    if (!parsed.success) {
      this.emit({
        status: 'error',
        message:
          'Lectura inválida. Usa un código de producto de hasta 128 caracteres.',
      })
      return
    }
    this.emit({ status: 'looking' })
    try {
      const product = await this.find(parsed.data)
      if (generation === this.generation)
        this.emit(
          product
            ? { status: 'found', code: parsed.data, product }
            : { status: 'unknown', code: parsed.data },
        )
    } catch (error) {
      if (generation === this.generation)
        this.emit({ status: 'error', message: errorMessage(error) })
    }
  }
  async cancel() {
    ++this.generation
    this.accepted = true
    await this.adapter.stop().catch(() => {})
  }
}
