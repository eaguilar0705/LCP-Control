import { useEffect, useRef, useState } from 'react'
import { z } from 'zod'
import { useAccess } from '../app/AccessContext'
import { supabase } from './supabase'
import { useLocalDrafts } from './localDrafts'
import { errorMessage } from './errors'
import { rpc } from '../services/workspace'

export function useWorkspaceDrafts<T>(key: string, schema: z.ZodType<T>) {
  const { demo, storageScope } = useAccess()
  const local = useLocalDrafts(key, schema)
  const identity = `${storageScope}:${key}`
  const [state, setState] = useState<{
    identity: string
    items: T[]
    revision: number
    error: string
  } | null>(null)
  const locked = useRef(false)
  const [attempt, setAttempt] = useState(0)
  const loading = !demo && state?.identity !== identity
  useEffect(() => {
    let active = true
    if (demo) return
    void (async () => {
      try {
        if (!supabase) throw new Error('Falta conexión a la base de datos.')
        const { data, error } = await supabase
          .from('user_drafts')
          .select('items,revision')
          .eq('namespace', key)
          .maybeSingle()
        if (error) throw error
        const items = z.array(schema).parse(data?.items ?? [])
        if (active)
          setState({
            identity,
            items,
            revision: data?.revision ?? 0,
            error: '',
          })
      } catch (e) {
        if (active)
          setState({ identity, items: [], revision: 0, error: errorMessage(e) })
      }
    })()
    return () => {
      active = false
    }
  }, [demo, key, schema, identity, attempt])
  async function save(next: T[]) {
    if (demo) return local.save(next)
    if (loading || locked.current || !state || state.error) return false
    locked.current = true
    try {
      const items = z.array(schema).parse(next)
      const revision = await rpc<number>('save_my_drafts', {
        p_namespace: key,
        p_items: items,
        p_revision: state.revision,
      })
      setState({ identity, items, revision, error: '' })
      return true
    } catch (e) {
      setState({
        ...state,
        error: `${errorMessage(e)} Recarga los borradores antes de volver a guardarlos.`,
      })
      return false
    } finally {
      locked.current = false
    }
  }
  return {
    items: demo ? local.items : loading ? [] : (state?.items ?? []),
    error: demo ? local.error : (state?.error ?? ''),
    save,
    loading,
    retry: () => {
      setState(null)
      setAttempt((x) => x + 1)
    },
  }
}
