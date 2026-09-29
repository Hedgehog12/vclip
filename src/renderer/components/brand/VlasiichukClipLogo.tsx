import markUrl from '../../../../resources/vlasiichuk-mark.svg'
import { cn } from '../../lib/utils'

interface VlasiichukClipLogoProps {
  /**
   * lockup: vlasiichuk.pro mark + "VlasiichukClip" wordmark (for dark surfaces).
   * icon:   the mark at tile size, as in Settings → About.
   * mark:   the mark alone, for tight spaces such as the collapsed sidebar.
   */
  variant?: 'lockup' | 'icon' | 'mark'
  /** Size by height (e.g. "h-6"); width follows the artwork. */
  className?: string
  alt?: string
}

/** Artwork follows vlasiichuk.pro/BRAND.md: on dark surfaces the circle is #fbfbfd and the V is #1d1d1f. */
export function VlasiichukClipLogo({ variant = 'lockup', className, alt = 'VlasiichukClip' }: VlasiichukClipLogoProps): React.JSX.Element {
  if (variant !== 'lockup') {
    return <img src={markUrl} alt={alt} draggable={false} className={cn('w-auto shrink-0 select-none', className)} />
  }
  // Inline so the wordmark renders in the app's own Geist font.
  return (
    <svg viewBox="0 0 560 100" role="img" aria-label={alt} className={cn('w-auto shrink-0 select-none', className)}>
      <circle cx="50" cy="50" r="46" fill="#fbfbfd" />
      <path d="M30 30L50 70L70 30M43 51L50 64L57 51" fill="none" stroke="#1d1d1f" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" />
      <text x="122" y="70" fill="#fbfbfd" fontFamily="inherit" fontSize="56" letterSpacing="-1.1">
        <tspan fontWeight="600">Vlasiichuk</tspan>
        <tspan fontWeight="400">Clip</tspan>
      </text>
    </svg>
  )
}
