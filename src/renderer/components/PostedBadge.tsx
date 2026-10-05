import { useEffect, useMemo } from 'react'
import { CalendarClock, Check } from 'lucide-react'
import { usePostsStore } from '../store/use-posts-store'
import { useSettingsStore } from '../store/use-settings-store'
import { cn } from '../lib/utils'
import { isZernioPlatform } from '../../shared/zernio'
import type { PostRecord } from '../../shared/zernio-posts'
import { PlatformIcon, platformName } from './PlatformIcon'

/** Where a Library clip has gone out, from the post history on this computer. */
export interface ClipPostState {
  /** Platforms where the clip is published (one entry per platform). */
  platforms: string[]
  /** A post with this clip is still waiting for its time. */
  scheduled: boolean
}

/** Paths compared the way Windows does: case and slash direction don't matter. */
export function clipKey(path: string): string {
  return path.replace(/\\/g, '/').toLowerCase()
}

export function postedClipsFrom(posts: readonly PostRecord[]): Map<string, ClipPostState> {
  const map = new Map<string, ClipPostState>()
  for (const post of posts) {
    const key = clipKey(post.clipPath)
    const state = map.get(key) ?? { platforms: [], scheduled: false }
    // A TikTok inbox upload isn't public until it is finished in the app.
    for (const target of post.targets) {
      if (target.status === 'published' && !target.inbox && !state.platforms.includes(target.platform)) state.platforms.push(target.platform)
    }
    if (post.status === 'scheduled' || post.status === 'publishing') state.scheduled = true
    if (state.platforms.length > 0 || state.scheduled) map.set(key, state)
  }
  return map
}

/** The posted state of every clip, kept up to date with the post history. */
export function usePostedClips(): Map<string, ClipPostState> {
  const configured = useSettingsStore((s) => s.zernioConfigured)
  const posts = usePostsStore((s) => s.posts)
  const loaded = usePostsStore((s) => s.loaded)
  useEffect(() => {
    if (configured && !loaded) void usePostsStore.getState().load()
  }, [configured, loaded])
  return useMemo(() => postedClipsFrom(posts), [posts])
}

export function isPosted(state: ClipPostState | undefined): boolean {
  return Boolean(state && state.platforms.length > 0)
}

/** Green check with the platforms a clip is published on, or a clock when it is only scheduled. */
export function PostedBadge({ state, className }: { state: ClipPostState | undefined; className?: string }): React.JSX.Element | null {
  if (!state) return null
  const posted = state.platforms.length > 0
  const label = posted
    ? `Posted on ${state.platforms.map(platformName).join(', ')}${state.scheduled ? '; another post is scheduled' : ''}`
    : 'Scheduled to post'
  return (
    <span
      title={label}
      aria-label={label}
      role="img"
      className={cn('inline-flex h-5 items-center gap-1 rounded-full pl-0.5 pr-1', posted ? 'bg-success/[0.18] shadow-[inset_0_0_0_1px_rgb(var(--success)/0.4)]' : 'bg-accent/[0.18] shadow-[inset_0_0_0_1px_rgb(var(--accent)/0.4)]', className)}
    >
      <span className={cn('inline-flex h-4 w-4 items-center justify-center rounded-full text-accent-ink', posted ? 'bg-success' : 'bg-accent')}>
        {posted ? <Check className="h-3 w-3" strokeWidth={3} /> : <CalendarClock className="h-2.5 w-2.5" />}
      </span>
      {state.platforms.filter(isZernioPlatform).map((platform) => (
        <PlatformIcon key={platform} platform={platform} className="h-4 w-4 rounded-full [&_svg]:h-2.5 [&_svg]:w-2.5" />
      ))}
    </span>
  )
}
