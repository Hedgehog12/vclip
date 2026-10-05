import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Check, ChevronDown, Clapperboard, Play, Trash2, TrendingUp, X } from 'lucide-react'
import type { IdeaDecision, JobReview, ReviewIdea } from '../../preload/index'
import { getApi } from '../lib/ipc'
import { cn, errorMessage, formatBytes, formatDuration, formatTimecode } from '../lib/utils'
import { SourcePreview } from './SourcePreview'
import { Badge } from './ui/Badge'
import { Button } from './ui/Button'
import { Callout } from './ui/Callout'
import { Checkbox } from './ui/Checkbox'
import { EmptyState } from './ui/EmptyState'
import { Page } from './ui/Page'
import { PageHeader } from './ui/PageHeader'
import { Panel } from './ui/Panel'
import { Skeleton } from './ui/Skeleton'

const SCORE_LABELS: [keyof ReviewIdea['scores'], string][] = [
  ['hook', 'Hook'], ['standalone', 'Standalone'], ['arc', 'Story'], ['quotability', 'Quotable'], ['ending', 'Ending']
]

interface IdeaReviewProps {
  jobId: string
  leading: ReactNode
  /** Changes when the job's live status changes, so the review reloads. */
  refreshKey?: unknown
  onRenderQueued: (jobId: string) => void
  onDiscarded: () => void
}

/**
 * Ideas the AI found in one video, before anything renders. The ideas the
 * user asked for are shown in full; extra ideas show only their title until
 * opened. Approve or reject each, then render the approved ones.
 */
export function IdeaReview({ jobId, leading, refreshKey, onRenderQueued, onDiscarded }: IdeaReviewProps): React.JSX.Element {
  const [review, setReview] = useState<JobReview | null | undefined>(undefined)
  const [decisions, setDecisions] = useState<Record<string, IdeaDecision>>({})
  const [error, setError] = useState<string | null>(null)
  const [working, setWorking] = useState<'render' | 'discard' | null>(null)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const [openExtra, setOpenExtra] = useState<string | null>(null)
  const [previewId, setPreviewId] = useState<string | null>(null)
  // Approved ideas get an AI thumbnail unless the user unticks it.
  const [noThumbnail, setNoThumbnail] = useState<Set<string>>(new Set())
  const toggleThumbnail = (id: string, on: boolean): void => setNoThumbnail((current) => {
    const next = new Set(current)
    if (on) next.delete(id)
    else next.add(id)
    return next
  })
  // A cold open (the hook line played first) is on for every idea that has one, unless unticked.
  const [noHook, setNoHook] = useState<Set<string>>(new Set())
  const toggleHook = (id: string, on: boolean): void => setNoHook((current) => {
    const next = new Set(current)
    if (on) next.delete(id)
    else next.add(id)
    return next
  })

  const load = useCallback(async () => {
    try {
      const next = await getApi().review.get(jobId)
      setReview(next)
      if (next) setDecisions({ ...next.decisions })
    } catch (err) {
      setReview(null)
      setError(errorMessage(err, 'Could not load the ideas for this job.'))
    }
  }, [jobId])

  useEffect(() => { void load() }, [load, refreshKey])

  const decide = (id: string, decision: IdeaDecision): void => {
    const next = { ...decisions }
    if (next[id] === decision) delete next[id]
    else next[id] = decision
    setDecisions(next)
    // Saved so a restart keeps them; Render sends the approved ids itself.
    getApi().review.decide(jobId, next).catch(() => {})
  }

  const groups = useMemo(() => {
    const ideas = review?.ideas ?? []
    const pending = ideas.filter((idea) => !idea.rendered)
    return {
      recommended: pending.filter((idea) => idea.recommended),
      extras: pending.filter((idea) => !idea.recommended),
      rendered: ideas.filter((idea) => idea.rendered)
    }
  }, [review])

  if (review === undefined) {
    return (
      <Page width="focus">
        <div className="mb-3">{leading}</div>
        <div className="space-y-3" aria-busy="true" aria-label="Loading ideas">
          <Skeleton className="h-6 w-2/3 rounded-full" />
          {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-40 w-full rounded-3xl" />)}
        </div>
      </Page>
    )
  }

  if (!review) {
    return (
      <Page width="focus">
        <div className="mb-3">{leading}</div>
        <EmptyState icon={<Clapperboard />} title="The ideas for this job are unavailable" description={error ?? 'Its saved ideas could not be read.'} />
      </Page>
    )
  }

  const approvedIds = [...groups.recommended, ...groups.extras].filter((idea) => decisions[idea.id] === 'approved').map((idea) => idea.id)
  const thumbnailIds = approvedIds.filter((id) => !noThumbnail.has(id))
  const hookIds = approvedIds.filter((id) => !noHook.has(id) && review.ideas.find((idea) => idea.id === id)?.hook)
  const waiting = review.status === 'awaiting_approval'
  // "You asked for N" only makes sense before anything from this job was rendered.
  const target = waiting && !review.autoClipCount ? review.recommendedCount : null
  const undecidedExtras = groups.extras.filter((idea) => !decisions[idea.id]).length
  const sourceGone = !review.sourcePath
  const canRender = approvedIds.length > 0 && !sourceGone && !review.busy

  const render = async (): Promise<void> => {
    setError(null)
    setWorking('render')
    try {
      const result = await getApi().review.render(jobId, approvedIds, thumbnailIds, hookIds)
      if (result.error) setError(result.error)
      else onRenderQueued(jobId)
    } catch (err) {
      setError(errorMessage(err, 'Could not start rendering.'))
    } finally {
      setWorking(null)
    }
  }

  const discard = async (): Promise<void> => {
    setError(null)
    setWorking('discard')
    try {
      const result = await getApi().review.discard(jobId)
      if (result.error) setError(result.error)
      else onDiscarded()
    } catch (err) {
      setError(errorMessage(err, 'Could not discard this job.'))
    } finally {
      setWorking(null)
      setConfirmDiscard(false)
    }
  }

  const card = (idea: ReviewIdea): React.JSX.Element => (
    <IdeaCard
      key={idea.id}
      idea={idea}
      decision={decisions[idea.id] ?? null}
      sourcePath={review.sourcePath}
      previewing={previewId === idea.id}
      onPreview={() => setPreviewId((current) => (current === idea.id ? null : idea.id))}
      onDecide={(decision) => decide(idea.id, decision)}
      thumbnail={!noThumbnail.has(idea.id)}
      onThumbnail={(on) => toggleThumbnail(idea.id, on)}
      coldOpen={!noHook.has(idea.id)}
      onColdOpen={(on) => toggleHook(idea.id, on)}
      locked={review.busy}
    />
  )

  return (
    <Page width="focus" className="pb-28">
      <PageHeader
        leading={leading}
        eyebrow={waiting ? 'Waiting for approval' : 'More ideas'}
        title={review.videoTitle}
        description={waiting
          ? 'Approve the ideas worth making into videos. Nothing renders until you click Render.'
          : 'Ideas from this video that are not rendered yet. Approve more and render them into this job.'}
      />

      <div className="mt-4 space-y-3">
        {error && <Callout tone="danger" onDismiss={() => setError(null)}>{error}</Callout>}
        {review.lastError && !error && (
          <Callout tone="warning" title="The last render didn’t finish">{review.lastError}</Callout>
        )}
        {review.busy && <Callout tone="info">This job is rendering. You can approve more ideas when it’s done.</Callout>}
        {sourceGone && (
          <Callout tone="warning" title="The video for this job is gone">
            {review.sourceDownloaded
              ? 'Its downloaded stream was deleted, so these ideas can no longer be previewed or rendered.'
              : 'The original file was moved or deleted, so these ideas can no longer be previewed or rendered.'}
          </Callout>
        )}

        {groups.recommended.length > 0 && (
          <section aria-label="Recommended ideas" className="space-y-2">
            <SectionHeading
              label={target ? `Recommended · you asked for ${target}` : waiting ? 'Ideas the AI found' : 'Recommended'}
              count={groups.recommended.length}
            />
            {groups.recommended.map(card)}
          </section>
        )}

        {groups.extras.length > 0 && (
          <section aria-label="More ideas" className="space-y-2 pt-2">
            <SectionHeading label="More ideas" count={groups.extras.length} hint="Approve from the title, or open one to read it first." />
            <Panel padded={false} className="overflow-hidden">
              <ul className="divide-y divide-white/[0.05]">
                {groups.extras.map((idea) => (
                  <li key={idea.id}>
                    <IdeaRow
                      idea={idea}
                      decision={decisions[idea.id] ?? null}
                      open={openExtra === idea.id}
                      onToggle={() => setOpenExtra((current) => (current === idea.id ? null : idea.id))}
                      onDecide={(decision) => decide(idea.id, decision)}
                      thumbnail={!noThumbnail.has(idea.id)}
                      onThumbnail={(on) => toggleThumbnail(idea.id, on)}
                      coldOpen={!noHook.has(idea.id)}
                      onColdOpen={(on) => toggleHook(idea.id, on)}
                      locked={review.busy}
                    />
                    {openExtra === idea.id && <div className="px-3 pb-3">{card(idea)}</div>}
                  </li>
                ))}
              </ul>
            </Panel>
          </section>
        )}

        {groups.recommended.length === 0 && groups.extras.length === 0 && (
          <EmptyState icon={<Check />} title="Every idea has been rendered" description="Open the job to see its clips." />
        )}

        {groups.rendered.length > 0 && (
          <details className="group rounded-2xl bg-white/[0.03] px-4 py-2.5 text-sm">
            <summary className="flex cursor-pointer list-none items-center gap-2 text-ink-muted">
              <ChevronDown className="h-3.5 w-3.5 transition-transform group-open:rotate-180" />
              Already rendered <span className="font-mono text-2xs tabular text-ink-faint">{groups.rendered.length}</span>
            </summary>
            <ul className="mt-2 space-y-1">
              {groups.rendered.map((idea) => (
                <li key={idea.id} className="flex items-center gap-2 text-xs text-ink-muted">
                  <Check className="h-3.5 w-3.5 text-success" />
                  <span className="truncate text-ink">{idea.title}</span>
                  {idea.clipIndex !== null && <span className="text-ink-faint">clip {idea.clipIndex + 1}</span>}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>

      <div className="glass-thick sticky bottom-4 z-10 mt-6 flex flex-wrap items-center gap-3 rounded-full py-2 pl-5 pr-2">
        <div className="min-w-0 flex-1 text-sm">
          <span className="font-medium text-ink">{approvedIds.length} approved</span>
          {approvedIds.length > 0 && <span className="text-ink-muted"> · {thumbnailIds.length} with thumbnail</span>}
          {hookIds.length > 0 && <span className="text-ink-muted"> · {hookIds.length} with cold open</span>}
          {target !== null && <span className="text-ink-muted"> · you asked for {target}</span>}
          {target !== null && approvedIds.length < target && undecidedExtras > 0 && (
            <span className="block truncate text-xs text-warning">
              You wanted {target}. There {undecidedExtras === 1 ? 'is' : 'are'} {undecidedExtras} more idea{undecidedExtras === 1 ? '' : 's'} below.
            </span>
          )}
        </div>
        {waiting && (confirmDiscard ? (
          <>
            <span className="text-xs text-ink-muted">
              Discard{review.sourceDownloaded && review.sourceBytes ? ` and delete ${formatBytes(review.sourceBytes)}` : ''}?
            </span>
            <Button size="sm" variant="ghost" onClick={() => setConfirmDiscard(false)}>Keep</Button>
            <Button size="sm" variant="danger" loading={working === 'discard'} onClick={() => { void discard() }}>Discard job</Button>
          </>
        ) : (
          <Button size="sm" variant="ghost" icon={<Trash2 className="h-3.5 w-3.5" />} disabled={review.busy || working !== null} onClick={() => setConfirmDiscard(true)}>
            Discard job
          </Button>
        ))}
        <Button
          variant="primary"
          icon={<Clapperboard className="h-3.5 w-3.5" />}
          disabled={!canRender || working !== null}
          loading={working === 'render'}
          onClick={() => { void render() }}
        >
          Render approved ({approvedIds.length})
        </Button>
      </div>
    </Page>
  )
}

function SectionHeading({ label, count, hint }: { label: string; count: number; hint?: string }): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 px-1">
      <h2 className="eyebrow">{label}</h2>
      <span className="font-mono text-2xs tabular text-ink-faint">{count}</span>
      {hint && <p className="w-full text-xs text-ink-subtle sm:ml-auto sm:w-auto">{hint}</p>}
    </div>
  )
}

function DecisionButtons({ decision, onDecide, locked, compact = false }: {
  decision: IdeaDecision | null
  onDecide: (decision: IdeaDecision) => void
  locked: boolean
  compact?: boolean
}): React.JSX.Element {
  return (
    <div className="flex shrink-0 items-center gap-1" role="group" aria-label="Decision">
      <Button
        size="sm"
        variant={decision === 'approved' ? 'primary' : 'secondary'}
        aria-pressed={decision === 'approved'}
        disabled={locked}
        icon={<Check className="h-3.5 w-3.5" />}
        iconOnly={compact}
        aria-label="Approve"
        title="Approve"
        onClick={() => onDecide('approved')}
      >
        Approve
      </Button>
      <Button
        size="sm"
        variant={decision === 'rejected' ? 'danger' : 'ghost'}
        aria-pressed={decision === 'rejected'}
        disabled={locked}
        icon={<X className="h-3.5 w-3.5" />}
        iconOnly={compact}
        aria-label="Reject"
        title="Reject"
        onClick={() => onDecide('rejected')}
      >
        Reject
      </Button>
    </div>
  )
}

function ScoreChip({ score }: { score: number }): React.JSX.Element {
  return (
    <span className="inline-flex items-center gap-1 font-mono text-xs tabular text-ink-muted" title="AI score out of 10">
      <TrendingUp className="h-3.5 w-3.5 text-brand-star" />
      {(score * 10).toFixed(1)}
    </span>
  )
}

function IdeaCard({ idea, decision, sourcePath, previewing, onPreview, onDecide, thumbnail, onThumbnail, coldOpen, onColdOpen, locked }: {
  idea: ReviewIdea
  decision: IdeaDecision | null
  sourcePath: string | null
  previewing: boolean
  onPreview: () => void
  onDecide: (decision: IdeaDecision) => void
  thumbnail: boolean
  onThumbnail: (on: boolean) => void
  coldOpen: boolean
  onColdOpen: (on: boolean) => void
  locked: boolean
}): React.JSX.Element {
  const skipped = idea.skipRanges.reduce((sum, [from, to]) => sum + (to - from), 0)
  return (
    <Panel
      className={cn(
        'space-y-3 transition-[box-shadow,opacity] duration-200',
        decision === 'approved' && 'shadow-accent-ring',
        decision === 'rejected' && 'opacity-60'
      )}
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5 font-mono text-2xs tabular text-ink-faint">#{idea.rank}</span>
        <div className="min-w-0 flex-1">
          <h3 className="text-base font-semibold leading-snug text-ink">{idea.title}</h3>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-subtle">
            <ScoreChip score={idea.viralityScore} />
            <span className="font-mono tabular">{formatTimecode(idea.startMs)}–{formatTimecode(idea.endMs)}</span>
            <span>{formatDuration(idea.endMs - idea.startMs - skipped)}</span>
            {skipped > 0 && <span>{formatDuration(skipped)} of tangents cut</span>}
          </p>
        </div>
        {idea.hook && (
          <OptionToggle label="Cold open" checked={coldOpen} onChange={onColdOpen} disabled={locked || decision === 'rejected'}
            hint={coldOpen ? 'The hook line below plays first, then the clip. Untick to start the clip normally.' : 'The clip starts normally'} />
        )}
        <OptionToggle label="Thumbnail" checked={thumbnail} onChange={onThumbnail} disabled={locked || decision === 'rejected'}
          hint={thumbnail ? 'An AI thumbnail is made after rendering. Untick to skip it.' : 'No thumbnail for this clip'} />
        <DecisionButtons decision={decision} onDecide={onDecide} locked={locked} />
      </div>

      {idea.hook && (
        <p className={cn('rounded-xl bg-white/[0.04] px-3 py-2 text-sm leading-relaxed', coldOpen ? 'text-ink' : 'text-ink-subtle line-through decoration-white/20')} data-selectable>
          <span className="mr-2 text-2xs font-medium text-brand-star">Hook · {formatTimecode(idea.hook.startMs)} · {formatDuration(idea.hook.endMs - idea.hook.startMs)}</span>
          “{idea.hook.text}”
        </p>
      )}

      {(idea.pitch || idea.description) && (
        <p className="text-sm leading-relaxed text-ink-muted" data-selectable>{idea.pitch ?? idea.description}</p>
      )}

      {Object.keys(idea.scores).length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {SCORE_LABELS.filter(([key]) => idea.scores[key] !== undefined).map(([key, label]) => (
            <Badge key={key}>{label} <span className="font-mono tabular text-ink">{idea.scores[key]}</span></Badge>
          ))}
        </div>
      )}

      {idea.excerpt && (
        <details className="group rounded-xl bg-white/[0.03] px-3 py-2">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 text-xs font-medium text-ink-muted">
            <ChevronDown className="h-3.5 w-3.5 transition-transform group-open:rotate-180" />
            Transcript
          </summary>
          <p className="mt-2 max-h-48 overflow-auto whitespace-pre-line text-xs leading-relaxed text-ink-muted" data-selectable>{idea.excerpt}</p>
        </details>
      )}

      {sourcePath && (
        previewing ? (
          <SourcePreview path={sourcePath} startMs={idea.startMs} endMs={idea.endMs} skipRanges={idea.skipRanges} />
        ) : (
          <Button size="sm" variant="secondary" icon={<Play className="h-3.5 w-3.5" fill="currentColor" />} onClick={onPreview}>
            Preview
          </Button>
        )
      )}
    </Panel>
  )
}

function IdeaRow({ idea, decision, open, onToggle, onDecide, thumbnail, onThumbnail, coldOpen, onColdOpen, locked }: {
  idea: ReviewIdea
  decision: IdeaDecision | null
  open: boolean
  onToggle: () => void
  onDecide: (decision: IdeaDecision) => void
  thumbnail: boolean
  onThumbnail: (on: boolean) => void
  coldOpen: boolean
  onColdOpen: (on: boolean) => void
  locked: boolean
}): React.JSX.Element {
  return (
    <div className={cn('flex items-center gap-2 pr-2 transition-colors duration-150 hover:bg-white/[0.025]', decision === 'rejected' && 'opacity-60')}>
      <button onClick={onToggle} aria-expanded={open} className="flex min-w-0 flex-1 items-center gap-3 py-2.5 pl-4 text-left">
        <ChevronDown className={cn('h-3.5 w-3.5 shrink-0 text-ink-subtle transition-transform', open && 'rotate-180')} />
        <span className="min-w-0 flex-1 truncate text-sm text-ink">{idea.title}</span>
        {decision === 'approved' && <Badge tone="accent">Approved</Badge>}
        <span className="hidden sm:inline"><ScoreChip score={idea.viralityScore} /></span>
        <span className="hidden w-14 shrink-0 text-right text-xs text-ink-subtle sm:block">{formatDuration(idea.endMs - idea.startMs)}</span>
      </button>
      {!open && idea.hook && (
        <OptionToggle label="Cold open" checked={coldOpen} onChange={onColdOpen} disabled={locked || decision === 'rejected'} compact
          hint={coldOpen ? `Hook played first: “${idea.hook.text}”. Untick to start the clip normally.` : 'The clip starts normally'} />
      )}
      {!open && <OptionToggle label="Thumbnail" checked={thumbnail} onChange={onThumbnail} disabled={locked || decision === 'rejected'} compact
        hint={thumbnail ? 'An AI thumbnail is made after rendering. Untick to skip it.' : 'No thumbnail for this clip'} />}
      <DecisionButtons decision={decision} onDecide={onDecide} locked={locked} compact />
    </div>
  )
}

/** A labelled on/off option for one idea, right before Approve so it is hard to miss. */
function OptionToggle({ label, hint, checked, onChange, disabled, compact = false }: {
  label: string
  hint: string
  checked: boolean
  onChange: (on: boolean) => void
  disabled: boolean
  compact?: boolean
}): React.JSX.Element {
  return (
    <label
      title={hint}
      className={cn(
        'flex h-8 shrink-0 cursor-pointer items-center gap-2 rounded-full px-2.5 text-xs font-medium transition-colors duration-150',
        checked ? 'bg-white/[0.06] text-ink' : 'text-ink-subtle',
        disabled && 'cursor-not-allowed opacity-40'
      )}
    >
      <Checkbox checked={checked} onChange={onChange} disabled={disabled} label={label} />
      <span aria-hidden className={cn(compact && 'hidden sm:inline')}>{label}</span>
    </label>
  )
}
