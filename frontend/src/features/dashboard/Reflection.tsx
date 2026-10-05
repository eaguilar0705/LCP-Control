import { useEffect, useState } from 'react'
import { dailyReflection } from './quotes'
export function Reflection() {
  const [quote, setQuote] = useState(() => dailyReflection())
  useEffect(() => {
    const update = () => setQuote(dailyReflection())
    const timer = setInterval(update, 30_000)
    window.addEventListener('focus', update)
    document.addEventListener('visibilitychange', update)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', update)
      document.removeEventListener('visibilitychange', update)
    }
  }, [])
  return (
    <div className="reflection">
      <span>Para comenzar el día</span>
      <blockquote>{quote}</blockquote>
    </div>
  )
}
