import type { ReactNode } from 'react'
import { cn } from '../../lib/utils'

interface PageHeaderProps {
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
  /** Small label above the title. */
  eyebrow?: ReactNode
  /** Rendered above the title, e.g. a back link. */
  leading?: ReactNode
  /** Rendered under the title and description, e.g. tabs. */
  below?: ReactNode
  className?: string
}

export function PageHeader({ title, description, actions, eyebrow, leading, below, className }: PageHeaderProps): React.JSX.Element {
  return (
    <header className={cn('flex flex-wrap items-end justify-between gap-x-4 gap-y-2', className)}>
      <div className="min-w-0 flex-1">
        {leading && <div className="mb-2">{leading}</div>}
        {eyebrow && <p className="eyebrow mb-1">{eyebrow}</p>}
        <h1 className="title-page truncate">{title}</h1>
        {description && <p className="mt-1 max-w-2xl text-sm text-ink-muted">{description}</p>}
        {below && <div className="mt-3">{below}</div>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  )
}
