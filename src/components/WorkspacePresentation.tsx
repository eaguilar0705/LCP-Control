import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
export function WorkspaceHeading({
  title,
  eyebrow,
  icon: Icon,
  children,
}: {
  title: string
  eyebrow: string
  icon: LucideIcon
  children?: ReactNode
}) {
  return (
    <header className="workspace-heading">
      <div className="workspace-heading-copy">
        <span className="workspace-heading-icon">
          <Icon size={25} strokeWidth={1.5} />
        </span>
        <div>
          <span className="section-kicker">{eyebrow}</span>
          <h1>{title}</h1>
        </div>
      </div>
      {children && <div className="workspace-heading-action">{children}</div>}
    </header>
  )
}
export function WorkspaceEmpty({
  title,
  icon: Icon,
}: {
  title: string
  icon: LucideIcon
}) {
  return (
    <div className="workspace-empty">
      <span className="workspace-empty-icon">
        <Icon size={28} strokeWidth={1.4} />
      </span>
      <h2>{title}</h2>
    </div>
  )
}
