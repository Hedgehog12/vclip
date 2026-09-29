import { useEffect, useRef, useState } from 'react'
import { cn, formatTimecode, localFileUrl } from '../lib/utils'

interface SourcePreviewProps {
  /** The job's source video on disk. */
  path: string
  startMs: number
  endMs: number
  /** Tangents the render will cut, in source ms; the preview jumps over them too. */
  skipRanges?: [number, number][]
  className?: string
}

/**
 * Plays one idea straight from the source video: from its start to its end,
 * skipping planned cuts. Nothing is rendered, so there are no captions or
 * cropping. Seeks with currentTime because local-file:// URLs treat a #t=
 * fragment as part of the path.
 */
export function SourcePreview({ path, startMs, endMs, skipRanges = [], className }: SourcePreviewProps): React.JSX.Element {
  const video = useRef<HTMLVideoElement>(null)
  const [failed, setFailed] = useState(false)
  const [position, setPosition] = useState(startMs)

  useEffect(() => { setFailed(false); setPosition(startMs) }, [path, startMs])

  const start = (): void => {
    const element = video.current
    if (!element) return
    element.currentTime = startMs / 1000
    void element.play().catch(() => {})
  }

  const onTimeUpdate = (): void => {
    const element = video.current
    if (!element) return
    const nowMs = element.currentTime * 1000
    const skip = skipRanges.find(([from, to]) => nowMs >= from && nowMs < to - 250)
    if (skip) { element.currentTime = skip[1] / 1000; return }
    if (nowMs >= endMs) {
      element.pause()
      element.currentTime = endMs / 1000
    }
    setPosition(Math.min(Math.max(nowMs, startMs), endMs))
  }

  if (failed) {
    return (
      <p className={cn('rounded-xl bg-white/[0.04] px-3 py-2.5 text-xs text-ink-muted', className)}>
        This video format can’t be previewed in the app. Open the job folder to watch the source in another player.
      </p>
    )
  }

  const span = Math.max(1, endMs - startMs)
  return (
    <div className={cn('space-y-1.5', className)}>
      <video
        ref={video}
        src={localFileUrl(path)}
        preload="metadata"
        playsInline
        controls
        onLoadedMetadata={start}
        onTimeUpdate={onTimeUpdate}
        onError={() => setFailed(true)}
        className="aspect-video w-full rounded-xl bg-black ring-1 ring-white/[0.1]"
      />
      <div className="flex items-center gap-2 text-2xs text-ink-subtle">
        <div className="h-1 flex-1 overflow-hidden rounded-full bg-white/[0.08]" aria-hidden>
          <div className="h-full bg-accent/70" style={{ width: `${((position - startMs) / span) * 100}%` }} />
        </div>
        <span className="font-mono tabular">{formatTimecode(position)} / {formatTimecode(endMs)}</span>
        <button type="button" onClick={start} className="text-ink-muted underline decoration-white/25 underline-offset-2 hover:text-ink">
          Replay
        </button>
      </div>
      <p className="text-2xs text-ink-faint">
        Original video from {formatTimecode(startMs)} to {formatTimecode(endMs)}, without captions or cropping.
      </p>
    </div>
  )
}
