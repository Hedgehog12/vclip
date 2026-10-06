import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { Clapperboard, Loader2, Search, X } from 'lucide-react'
import { getApi } from '../lib/ipc'
import { loadClipCover } from '../lib/thumbnails'
import { cn, errorMessage, formatRelativeDate } from '../lib/utils'
import { parseJobOutput } from '../../shared/job-output'
import { formatClipDuration } from '../../shared/zernio-posts'
import { toPostable } from './ClipList'
import type { PostableClip } from './PostDialog'
import { Button } from './ui/Button'
import { Callout } from './ui/Callout'
import { Checkbox } from './ui/Checkbox'
import { PostedBadge, clipKey, isPosted, usePostedClips } from './PostedBadge'
import { Dialog } from './ui/Dialog'
import { TextInput } from './ui/Field'

const HIDE_POSTED_KEY = 'vclip.picker.hidePosted'

function readHidePosted(): boolean {
  try { return localStorage.getItem(HIDE_POSTED_KEY) === '1' } catch { return false }
}

/** Runs read at most; the newest come first. */
const MAX_RUNS = 40

interface RunClips {
  outputDir: string
  title: string
  date: string
  clips: PostableClip[]
}

/** Every clip of the finished runs in the Library, newest run first. */
async function loadRuns(): Promise<RunClips[]> {
  const entries = (await getApi().history.list())
    .filter((entry) => entry.clipCount > 0 && entry.status !== 'running')
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, MAX_RUNS)
  const runs = await Promise.all(entries.map(async (entry): Promise<RunClips | null> => {
    try {
      const output = parseJobOutput(await getApi().history.getJob(entry.outputDir))
      if (!output || output.clips.length === 0) return null
      return { outputDir: entry.outputDir, title: entry.videoTitle || output.source_video_title, date: entry.date, clips: output.clips.map(toPostable) }
    } catch { return null }
  }))
  return runs.filter((run): run is RunClips => run !== null)
}

function ClipThumb({ clip }: { clip: PostableClip }): React.JSX.Element {
  const [thumb, setThumb] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    loadClipCover(clip.path, clip.durationMs).then((url) => { if (!cancelled) setThumb(url) })
    return () => { cancelled = true }
  }, [clip.path, clip.durationMs])
  return thumb ? (
    <img src={thumb} alt="" draggable={false} className="aspect-[9/16] w-full rounded-xl object-cover ring-1 ring-white/[0.12]" />
  ) : (
    <span aria-hidden className="glass-tile flex aspect-[9/16] w-full items-center justify-center rounded-xl text-ink-subtle">
      <Clapperboard className="h-4 w-4" />
    </span>
  )
}

/** "Create post", step one: choose the clip from the Library. */
export function ClipPickerDialog({ onPick, onClose }: { onPick: (clip: PostableClip) => void; onClose: () => void }): React.JSX.Element {
  const titleId = useId()
  const dialogRef = useRef<HTMLDivElement>(null)
  const [runs, setRuns] = useState<RunClips[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const posted = usePostedClips()
  const [hidePosted, setHidePosted] = useState(readHidePosted)
  const toggleHidePosted = (value: boolean): void => {
    setHidePosted(value)
    try { localStorage.setItem(HIDE_POSTED_KEY, value ? '1' : '0') } catch { /* Only a convenience. */ }
  }

  useEffect(() => {
    let cancelled = false
    loadRuns()
      .then((result) => { if (!cancelled) setRuns(result) })
      .catch((err) => { if (!cancelled) { setRuns([]); setError(errorMessage(err, 'Could not read the Library.')) } })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    dialogRef.current?.focus()
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') { event.preventDefault(); onClose() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const postedCount = useMemo(() => (runs ?? []).reduce((sum, run) => sum + run.clips.filter((clip) => isPosted(posted.get(clipKey(clip.path)))).length, 0), [runs, posted])
  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    return (runs ?? [])
      .map((run) => ({ ...run, clips: hidePosted ? run.clips.filter((clip) => !isPosted(posted.get(clipKey(clip.path)))) : run.clips }))
      .map((run) => !needle || run.title.toLocaleLowerCase().includes(needle) ? run : { ...run, clips: run.clips.filter((clip) => [clip.title, clip.description ?? '', ...clip.tags].join(' ').toLocaleLowerCase().includes(needle)) })
      .filter((run) => run.clips.length > 0)
  }, [runs, query, hidePosted, posted])

  return (
    <Dialog ref={dialogRef} aria-labelledby={titleId} onBackdropMouseDown={onClose} panelClassName="max-w-[880px] h-[80vh]">
      <div className="flex items-start gap-3 border-b border-white/[0.07] px-5 py-4">
        <div className="min-w-0 flex-1">
          <p className="eyebrow">Create post</p>
          <h2 id={titleId} className="mt-1 text-lg font-semibold text-ink">Choose a clip</h2>
        </div>
        <label className="flex h-8 cursor-pointer items-center gap-2 whitespace-nowrap text-xs text-ink-muted" title="Hide clips that are already published somewhere">
          <Checkbox checked={hidePosted} onChange={toggleHidePosted} label="Hide posted clips" />
          <span aria-hidden>Hide posted{postedCount > 0 ? ` (${postedCount})` : ''}</span>
        </label>
        <TextInput
          className="w-[240px]"
          inputSize="sm"
          placeholder="Search clips"
          aria-label="Search clips"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          leading={<Search className="h-3.5 w-3.5" />}
        />
        <Button variant="ghost" iconOnly aria-label="Close" icon={<X className="h-4 w-4" />} onClick={onClose} />
      </div>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
        {error && <Callout tone="danger">{error}</Callout>}
        {runs === null ? (
          <p role="status" className="flex items-center gap-2 text-sm text-ink-muted"><Loader2 className="h-4 w-4 animate-spin" />Reading your Library…</p>
        ) : visible.length === 0 ? (
          <p className="text-sm text-ink-muted">{query ? `No clips match “${query}”.` : hidePosted && postedCount > 0 ? 'Every clip is posted already. Untick “Hide posted” to see them.' : 'No finished clips yet. Clip a video first, then post it from here.'}</p>
        ) : visible.map((run) => (
          <section key={run.outputDir} aria-label={run.title}>
            <h3 className="mb-2 flex items-baseline gap-2 text-sm font-medium text-ink">
              <span className="truncate">{run.title}</span>
              <span className="shrink-0 text-2xs font-normal text-ink-subtle">{formatRelativeDate(run.date)} · {run.clips.length} clip{run.clips.length === 1 ? '' : 's'}{hidePosted ? ' not posted yet' : ''}</span>
            </h3>
            <ul className="grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-3">
              {run.clips.map((clip) => (
                <li key={clip.path}>
                  <button
                    type="button"
                    onClick={() => onPick(clip)}
                    className={cn('group block w-full rounded-2xl p-1.5 text-left transition-colors duration-150 hover:bg-white/[0.06] focus-visible:bg-white/[0.06] focus-visible:outline-none')}
                    title={clip.title}
                  >
                    <span className="relative block">
                      <ClipThumb clip={clip} />
                      <PostedBadge state={posted.get(clipKey(clip.path))} className="absolute bottom-1.5 left-1.5 backdrop-blur-sm" />
                    </span>
                    <span className="mt-1.5 line-clamp-2 block text-xs font-medium leading-snug text-ink">{clip.title}</span>
                    <span className="mt-0.5 block font-mono text-2xs tabular text-ink-subtle">{formatClipDuration(clip.durationMs / 1000)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </Dialog>
  )
}
