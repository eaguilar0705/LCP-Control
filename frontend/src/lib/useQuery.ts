import { useEffect, useState } from 'react'
import { errorMessage } from './errors'
export function useQuery<T>(load: () => Promise<T>) {
  const [state, setState] = useState<{
    data: T | null
    error: string | null
    loading: boolean
  }>({ data: null, error: null, loading: true })
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let active = true
    load()
      .then((data) => {
        if (active) setState({ data, error: null, loading: false })
      })
      .catch((error) => {
        if (active)
          setState({ data: null, error: errorMessage(error), loading: false })
      })
    return () => {
      active = false
    }
  }, [load, attempt])
  return {
    ...state,
    retry: () => {
      setState({ data: null, error: null, loading: true })
      setAttempt((value) => value + 1)
    },
    /**
     * Vuelve a leer sin quitar lo que ya se ve: después de guardar, la lista
     * no parpadea y el foco sigue en la fila que se editó.
     */
    refresh: () => setAttempt((value) => value + 1),
  }
}
