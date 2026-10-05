import { useState } from 'react'
import { z } from 'zod'
import { useAccess } from '../app/AccessContext'
// Browser-only drafts. Never used as authoritative stock, sales or authorization.
export function useLocalDrafts<T>(key: string, schema: z.ZodType<T>) {
  const { storageScope = 'demo' } = useAccess()
  const storageKey = `${key}:${storageScope}`
  const [error, setError] = useState('')
  const [items, setItems] = useState<T[]>(() => {
    try {
      const parsed = z
        .array(schema)
        .safeParse(JSON.parse(localStorage.getItem(storageKey) ?? '[]'))
      return parsed.success ? parsed.data : []
    } catch {
      return []
    }
  })
  function save(next: T[]) {
    const parsed = z.array(schema).safeParse(next)
    if (!parsed.success) {
      setError('Revisa los campos del formulario.')
      return false
    }
    try {
      localStorage.setItem(storageKey, JSON.stringify(parsed.data))
      setItems(parsed.data)
      setError('')
      return true
    } catch {
      setError(
        'No se pudo guardar en este navegador. Conserva el formulario abierto e inténtalo de nuevo.',
      )
      return false
    }
  }
  return { items, save, error }
}
