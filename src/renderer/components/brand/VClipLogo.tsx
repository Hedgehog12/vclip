import markUrl from '../../../../resources/vlasiichuk-mark.svg'
import iconUrl from '../../../../resources/vclip-icon.svg'
import { cn } from '../../lib/utils'

interface VClipLogoProps {
  /**
   * lockup: V mark + "vClip" + "by vlasiichuk.pro", for the sidebar and loading screen.
   * icon:   the rounded app icon, as in Settings → About.
   * mark:   the V mark alone, for tight spaces such as the collapsed sidebar.
   */
  variant?: 'lockup' | 'icon' | 'mark'
  /** Lockup only. md is the sidebar size; lg is for the loading screen. */
  size?: 'md' | 'lg'
  /** Mark and icon: size by height (e.g. "h-6"); width follows the artwork. Lockup: extra classes on the wrapper. */
  className?: string
  alt?: string
}

const LOCKUP = {
  md: { mark: 'h-5 w-5', name: 'text-[15px] leading-[18px]', by: 'text-[10.5px] leading-3', gap: 'gap-[9px]' },
  lg: { mark: 'h-9 w-9', name: 'text-[26px] leading-8', by: 'text-xs leading-4', gap: 'gap-3' }
} as const

/**
 * Artwork follows vlasiichuk.pro/v2.1/logo. The mark is the "Nebula face" V: left face
 * silver, right face Nebula. It is one mark for every tool; tools differ by name only.
 * Never recolor, rotate, outline or add shadows to it.
 */
export function VClipLogo({ variant = 'lockup', size = 'md', className, alt = 'vClip' }: VClipLogoProps): React.JSX.Element {
  if (variant === 'mark') {
    return <img src={markUrl} alt={alt} draggable={false} className={cn('w-auto shrink-0 select-none', className)} />
  }
  if (variant === 'icon') {
    return <img src={iconUrl} alt={alt} draggable={false} className={cn('w-auto shrink-0 select-none', className)} />
  }
  const s = LOCKUP[size]
  return (
    <div role="img" aria-label={`${alt} by vlasiichuk.pro`} className={cn('flex shrink-0 select-none items-center', s.gap, className)}>
      <img src={markUrl} alt="" draggable={false} className={cn('shrink-0', s.mark)} />
      <div aria-hidden>
        <b className={cn('block font-medium tracking-[-0.01em] text-ink', s.name)}>vClip</b>
        <small className={cn('block text-ink-subtle', s.by)}>by vlasiichuk.pro</small>
      </div>
    </div>
  )
}
