import { expect, it, vi } from 'vitest'
import { catalogAdapter } from '@/services/adapters/catalog'
import { digestFromSource } from '@/features/reports/digest'
import { localDay, presetRange } from '@/features/reports/model'

const { download } = vi.hoisted(() => ({ download: vi.fn() }))
vi.mock('@/features/reports/export', () => ({ download }))
const { accountingWorkbook } =
  await import('@/features/accounting/accountingWorkbook')

it('descarga el libro de contabilidad con estados y razones', async () => {
  const range = presetRange('30d', localDay(new Date()))
  const report = digestFromSource(
    await catalogAdapter.getReportSource(range),
    range,
  )
  const { position } = await catalogAdapter.getFinance(range)
  accountingWorkbook(report, position, range, 'La Casa del Perfume')
  expect(download).toHaveBeenCalledOnce()
  const [blob, name] = download.mock.calls[0]
  expect(name).toBe(`contabilidad-${range.from}-a-${range.to}.xlsx`)
  expect((blob as Blob).size).toBeGreaterThan(1000)
})
