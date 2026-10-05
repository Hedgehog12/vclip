import { useEffect, useState } from 'react'
import { FolderOpen, ImageOff, ListPlus, Loader2, Play, Send, Sparkles, TrendingUp, TriangleAlert, Trophy } from 'lucide-react'
import { cn, formatTimecode, isMac, localFileUrl } from '../lib/utils'
import { getApi } from '../lib/ipc'
import { clipFilePath, loadThumbnail } from '../lib/thumbnails'
import type { ClipArtifact } from '../store/use-job-store'
import type { AiThumbnail } from '../../preload/index'
import { Checkbox } from './ui/Checkbox'
import { ClipEditDialog } from './ClipEditDialog'
import { Badge } from './ui/Badge'
import { Skeleton } from './ui/Skeleton'
import { PostedBadge, type ClipPostState } from './PostedBadge'

// How the engine framed a vertical clip (its dominant layout).
const LAYOUT_LABELS: Record<string, string> = {
  talking_head: 'Speaker',
  two_shot: 'Two people',
  screen_cam: 'Screen + webcam',
  screen: 'Whole frame',
  fit: 'Whole frame',
  center_crop: 'Center crop'
}

interface ClipCardProps {
  clip: ClipArtifact
  vertical: boolean
  topPick?: boolean
  selected: boolean
  selecting: boolean
  onToggleSelect: () => void
  /** Reports the thumbnail's aspect ratio so the grid can size to the output. */
  onAspect?: (ratio: number) => void
  /** Opens the post dialog for this clip. */
  /** Opens the post dialog; `latest` is the clip as just saved in the edit dialog. */
  onPost?: (latest?: ClipArtifact) => void
  onAddToAutomation?: () => void
  /** The title or description was edited in the clip's edit dialog. */
  onEdited?: (clip: ClipArtifact) => void
  /** Where this clip is already posted, from the post history. */
  posted?: ClipPostState
}

export function ClipCard({
  clip,
  vertical,
  topPick,
  selected,
  selecting,
  onToggleSelect,
  onAspect,
  onPost,
  onAddToAutomation,
  onEdited,
  posted
}: ClipCardProps): React.JSX.Element {
  const filePath = clipFilePath(clip.s3_url)
  const [thumb, setThumb] = useState<string | null | undefined>(undefined)
  const [aspect, setAspect] = useState<number | null>(null)
  const [hovering, setHovering] = useState(false)
  const [previewFailed, setPreviewFailed] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [ai, setAi] = useState<AiThumbnail | null>(null)
  const [editing, setEditing] = useState(false)
  const title = clip.summary || `Clip ${clip.clip_index + 1}`
  const score = (clip.virality_score * 10).toFixed(1)
  const clipVertical = aspect == null ? vertical : aspect < 1
  const layout = clipVertical && Object.prototype.hasOwnProperty.call(LAYOUT_LABELS, clip.layout_type)
    ? LAYOUT_LABELS[clip.layout_type]
    : undefined

  useEffect(() => {
    let cancelled = false
    setThumb(undefined)
    setAspect(null)
    setPreviewFailed(false)
    setActionError(null)
    const seek = clip.duration_ms > 0 ? (clip.duration_ms / 1000) * 0.5 : undefined
    loadThumbnail(filePath, seek).then((path) => {
      if (!cancelled) setThumb(path)
    })
    return () => {
      cancelled = true
    }
  }, [filePath, clip.duration_ms])

  useEffect(() => setAi(null), [filePath])
  // The AI thumbnail, polled while it is being made.
  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const check = (): void => {
      getApi().thumbnails.aiStatus(filePath).then((state) => {
        if (cancelled) return
        setAi(state)
        if (state?.status === 'pending') timer = setTimeout(check, 4000)
      }).catch(() => {})
    }
    check()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [filePath, ai?.status === 'pending'])



  const openClip = async (): Promise<void> => {
    setActionError(null)
    try {
      if (!await getApi().shell.openPath(filePath)) setActionError('Clip file is no longer available.')
    } catch {
      setActionError('Could not open this clip.')
    }
  }

  const showInFolder = async (): Promise<void> => {
    setActionError(null)
    try {
      if (!await getApi().shell.showItemInFolder(filePath)) setActionError('Clip file is no longer available.')
    } catch {
      setActionError('Could not show this clip in its folder.')
    }
  }

  return (
    <article
      className={cn(
        'glass group relative flex flex-col rounded-2xl p-1.5 transition-[transform,box-shadow] duration-300 ease-out',
        selected
          ? 'shadow-accent-ring'
          : 'hover:-translate-y-0.5 hover:shadow-[inset_0_1px_0_rgb(255_255_255/0.1),0_0_0_1px_rgb(255_255_255/0.08),0_24px_48px_-20px_rgb(0_0_0/0.75)]'
      )}
    >
      <div
        className={cn(
          'relative overflow-hidden rounded-xl bg-black/40 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.06)]',
          clipVertical ? 'aspect-[9/16]' : 'aspect-video'
        )}
        onMouseEnter={() => setHovering(true)}
        onMouseLeave={() => setHovering(false)}
      >
        {ai?.status === 'ready' && ai.path ? (
          <img
            src={`${localFileUrl(ai.path)}?v=${encodeURIComponent(ai.updatedAt)}`}
            alt=""
            draggable={false}
            className="absolute inset-0 h-full w-full object-cover transition-transform duration-500 ease-out group-hover:scale-[1.03]"
            onError={() => setAi(null)}
          />
        ) : thumb ? (
          <img
            src={localFileUrl(thumb)}
            alt=""
            draggable={false}
            className="absolute inset-0 h-full w-full object-cover transition-transform duration-500 ease-out group-hover:scale-[1.03]"
            onLoad={(e) => {
              const ratio = e.currentTarget.naturalWidth / e.currentTarget.naturalHeight
              if (Number.isFinite(ratio) && ratio > 0) {
                setAspect(ratio)
                onAspect?.(ratio)
              }
            }}
            onError={() => setThumb(null)}
          />
        ) : thumb === null ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-ink-subtle">
            <ImageOff className="h-6 w-6" />
            <span className="text-xs">Preview unavailable</span>
          </div>
        ) : (
          <Skeleton className="absolute inset-0 rounded-none" />
        )}
        {hovering && !previewFailed && (
          <video
            src={localFileUrl(filePath)}
            autoPlay
            muted
            loop
            playsInline
            className="absolute inset-0 h-full w-full object-cover"
            onError={() => setPreviewFailed(true)}
          />
        )}

        {/* The media opens the edit dialog, or picks the clip while clips are being selected (the checkbox is the labelled control then). */}
        <button
          type="button"
          onClick={selecting ? onToggleSelect : () => setEditing(true)}
          aria-label={`Edit “${title}”`}
          title="Edit title, description and thumbnail"
          aria-hidden={selecting || undefined}
          tabIndex={selecting ? -1 : undefined}
          className="absolute inset-0 cursor-pointer focus-visible:[outline-offset:-3px]"
        />

        <div
          className={cn(
            'absolute left-2 top-2 z-10 transition-opacity duration-200',
            selecting || selected ? 'opacity-100' : 'opacity-0 group-focus-within:opacity-100 group-hover:opacity-100'
          )}
        >
          <Checkbox variant="overlay" checked={selected} onChange={onToggleSelect} label={`Select ${title}`} />
        </div>
        <div className="pointer-events-none absolute right-2 top-2 z-10 flex items-center gap-1">
          {topPick && (
            <span
              className="pointer-events-auto inline-flex h-5 w-5 items-center justify-center rounded-full bg-accent text-accent-ink"
              title="Top pick: the best-scoring clip of this run"
              aria-label="Top pick"
            >
              <Trophy className="h-3 w-3" />
            </span>
          )}
          <span
            className="glass-chip pointer-events-auto inline-flex h-5 items-center gap-1 rounded-full px-1.5 font-mono text-2xs font-medium tabular text-white"
            title="Virality score"
          >
            <TrendingUp className="h-3 w-3 text-brand-star" />
            {score}
          </span>
        </div>
        <span className="pointer-events-none absolute bottom-2 left-2 z-10 flex items-center gap-1">
          <span className="glass-chip rounded-full px-1.5 py-px font-mono text-2xs tabular text-white/95">
            {formatTimecode(clip.duration_ms)}
          </span>
          {posted && <PostedBadge state={posted} className="pointer-events-auto backdrop-blur-sm" />}
          {ai?.status === 'pending' && (
            <span className="glass-chip inline-flex items-center gap-1 rounded-full px-1.5 py-px text-2xs text-white/95">
              <Loader2 className="h-3 w-3 animate-spin" /> Thumbnail
            </span>
          )}
          {ai?.status === 'ready' && ai.error && (
            <span className="glass-chip pointer-events-auto inline-flex items-center gap-1 rounded-full px-1.5 py-px text-2xs text-warning" title={`Regenerate failed: ${ai.error}`}>
              <TriangleAlert className="h-3 w-3" /> Regenerate failed
            </span>
          )}
          {ai?.status === 'ready' && !ai.error && (
            <span className="glass-chip inline-flex items-center gap-1 rounded-full px-1.5 py-px text-2xs text-white/95" title={ai.model === 'custom' ? 'Your own thumbnail' : `AI thumbnail${ai.model ? ` · ${ai.model}` : ''}`}>
              {ai.model === 'custom' ? 'Custom' : <><Sparkles className="h-3 w-3 text-brand-star" /> AI</>}
            </span>
          )}
          {ai?.status === 'failed' && (
            <span className="glass-chip pointer-events-auto inline-flex items-center gap-1 rounded-full px-1.5 py-px text-2xs text-warning" title={ai.error ?? 'Thumbnail failed'}>
              <TriangleAlert className="h-3 w-3" /> Thumbnail failed
            </span>
          )}
        </span>
        {/* Above the duration and posted chips, so hovering never hides them. */}
        {!selecting && (
          <div className="absolute bottom-9 right-2 z-10 flex items-center gap-1">
            <div className="flex items-center gap-1 opacity-0 transition-opacity duration-200 focus-within:opacity-100 group-hover:opacity-100">
              {onPost && <MediaAction label={`Post “${title}”`} title="Post to social accounts" icon={<Send />} onClick={() => onPost()} />}
              {onAddToAutomation && <MediaAction label={`Add “${title}” to automation`} title="Add to automation" icon={<ListPlus />} onClick={onAddToAutomation} />}
              <MediaAction label={isMac ? 'Show in Finder' : 'Show in folder'} icon={<FolderOpen />} onClick={() => { void showInFolder() }} />
            </div>
            {/* Always visible: plays the clip in the system player. */}
            <MediaAction label={`Play “${title}”`} title="Play" icon={<Play className="ml-px" fill="currentColor" />} onClick={() => { void openClip() }} />
          </div>
        )}
      </div>

      <div className="px-1.5 pb-1 pt-2">
        <h3 className="line-clamp-2 text-sm font-medium leading-[18px] text-ink" title={title}>
          {title}
        </h3>
        <p className="mt-1 truncate text-2xs text-ink-subtle">
          <span className="font-mono tabular" title="Position in the source video">
            {formatTimecode(clip.start_time_ms)} – {formatTimecode(clip.end_time_ms)}
          </span>
          {layout && <span title="How this clip was framed"> · {layout}</span>}
        </p>
        {clip.render_fallback && (
          <Badge
            tone="warning"
            icon={<TriangleAlert className="h-3 w-3" />}
            className="mt-1.5 self-start"
          >
            <span title="Smart framing failed to render this clip, so it used the classic whole-frame layout. The log has the details.">
              {clip.render_fallback === 'letterbox_natural' ? 'Fallback: whole frame, no cuts' : 'Fallback: whole frame'}
            </span>
          </Badge>
        )}
        {actionError && <p role="alert" className="mt-1.5 text-xs text-danger">{actionError}</p>}
      </div>
      {editing && (
        <ClipEditDialog
          clip={clip}
          vertical={clipVertical}
          thumbnail={ai}
          frame={thumb ?? null}
          onThumbnail={setAi}
          onSaved={(updated) => onEdited?.(updated)}
          onPost={onPost}
          onClose={() => setEditing(false)}
        />
      )}
    </article>
  )
}

/** Small frosted button over the clip's media; shown on hover or focus. */
function MediaAction({ label, title, icon, onClick }: { label: string; title?: string; icon: React.ReactNode; onClick: () => void }): React.JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      title={title ?? label}
      onClick={onClick}
      className="glass-chip flex h-7 w-7 items-center justify-center rounded-full text-white/90 transition-colors duration-150 hover:bg-white/25 hover:text-white [&_svg]:h-3.5 [&_svg]:w-3.5"
    >
      {icon}
    </button>
  )
}
