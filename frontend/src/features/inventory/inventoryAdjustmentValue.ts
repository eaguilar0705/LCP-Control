/** Estimated value of the units that change, using the saved NIO cost (six decimals). */
export function inventoryAdjustmentValue(
  before: number | null,
  after: number | null,
  unitCost: number | null,
) {
  if (
    before === null ||
    after === null ||
    !Number.isSafeInteger(before) ||
    !Number.isSafeInteger(after) ||
    before < 0 ||
    after < 0 ||
    before > 1000000 ||
    after > 1000000 ||
    unitCost === null ||
    !Number.isFinite(unitCost) ||
    unitCost < 0
  )
    return null
  const micros = Math.round(unitCost * 1e6)
  if (!Number.isSafeInteger(micros)) return null
  const units = after - before
  const cents = (BigInt(Math.abs(units)) * BigInt(micros) + 5000n) / 10000n
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) return null
  return { units, amountNio: Number(cents) / 100 }
}
