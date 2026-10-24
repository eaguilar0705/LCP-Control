import type { ReactNode } from 'react'
import { useQuery } from '../lib/useQuery'
import { demoServices, privateServices } from '../services'
import { ErrorState, LoadingState } from './ui'

export function PriceTiersBoundary({
  demo,
  children,
}: {
  demo: boolean
  children: ReactNode
}) {
  const services = demo ? demoServices : privateServices
  const query = useQuery(services.productService.listPriceTiers)
  if (query.loading) return <LoadingState />
  if (query.error)
    return <ErrorState message={query.error} retry={query.retry} />
  return children
}
