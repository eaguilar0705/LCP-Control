import { useSyncExternalStore } from 'react'
import { getPriceTiers, subscribePriceTiers } from './pricing'

export function usePriceTiers() {
  return useSyncExternalStore(subscribePriceTiers, getPriceTiers, getPriceTiers)
}
