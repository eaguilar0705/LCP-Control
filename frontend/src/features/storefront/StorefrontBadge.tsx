import { useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
export function StorefrontBadge({ enabled }: { enabled: boolean }) {
  const { pathname } = useLocation()
  const [count, setCount] = useState(0)
  useEffect(() => {
    if (!enabled || !supabase) return
    const api = supabase
    let active = true,
      inflight = false
    const refresh = async () => {
      if (document.hidden || inflight) return
      inflight = true
      try {
        const result = await api
          .from('storefront_drafts')
          .select('id', { count: 'exact', head: true })
          .or('status.eq.pending,removal_state.eq.pending')
        if (active && !result.error) setCount(result.count || 0)
      } finally {
        inflight = false
      }
    }
    void refresh()
    const update = () => {
      void refresh()
    }
    const timer = window.setInterval(update, 60000)
    window.addEventListener('storefront-updated', update)
    window.addEventListener('focus', update)
    document.addEventListener('visibilitychange', update)
    return () => {
      active = false
      clearInterval(timer)
      window.removeEventListener('storefront-updated', update)
      window.removeEventListener('focus', update)
      document.removeEventListener('visibilitychange', update)
    }
  }, [enabled, pathname])
  return enabled && count > 0 ? (
    <span
      className="storefront-badge"
      aria-label={`${count} cambios por revisar`}
    >
      {count}
    </span>
  ) : null
}
