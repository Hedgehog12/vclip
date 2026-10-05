import { useCallback, useEffect, useState } from 'react'
import { ChevronDown, FolderOpen, HardDrive, Trash2 } from 'lucide-react'
import type { RunStorage, StorageUsage } from '../../preload/index'
import { getApi } from '../lib/ipc'
import { cn, errorMessage, formatBytes, formatRelativeDate } from '../lib/utils'
import { Button } from './ui/Button'
import { Callout } from './ui/Callout'
import { EmptyState } from './ui/EmptyState'
import { Panel } from './ui/Panel'
import { ConfirmDialog, type ConfirmRequest } from './ui/ConfirmDialog'
import { Checkbox } from './ui/Checkbox'

const COLLAPSED_ROWS = 5

/**
 * Disk space each job uses: its downloaded stream (kept so more ideas can be
 * rendered), its rendered clips, and the rest. Delete moves a whole job
 * folder to the Recycle Bin.
 */
export function StoragePanel(): React.JSX.Element | null {
  const [usage, setUsage] = useState<StorageUsage | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [showAll, setShowAll] = useState(false)
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const closeConfirm = useCallback(() => setConfirm(null), [])

  const load = useCallback(async () => {
    try { setUsage(await getApi().storage.usage()) }
    catch (err) { setError(errorMessage(err, 'Could not measure disk use.')) }
  }, [])

  useEffect(() => { void load() }, [load])

  const onOpenFolder = async (dir: string): Promise<void> => {
    try {
      if (!await getApi().shell.openPath(dir)) setError('This run folder is unavailable.')
    } catch (err) {
      setError(errorMessage(err, 'Could not open this run folder.'))
    }
  }

  if (!usage) {
    return error ? <Callout tone="danger" onDismiss={() => setError(null)}>{error}</Callout> : null
  }
  if (usage.runs.length === 0) {
    return (
      <EmptyState
        icon={<HardDrive />}
        title="Nothing stored yet"
        description="Downloaded streams and rendered clips from your jobs show up here."
      />
    )
  }

  const deletable = usage.runs.filter((run) => !run.busy)
  const picked = deletable.filter((run) => selected.has(run.jobId))
  const allPicked = deletable.length > 0 && picked.length === deletable.length

  /** One folder at a time; a failure stops the rest and is shown. */
  const deleteJobs = async (runs: RunStorage[]): Promise<void> => {
    setError(null)
    setDeleting(runs.length === 1 ? `job:${runs[0].jobId}` : 'many')
    try {
      for (const run of runs) {
        const result = await getApi().storage.deleteJob(run.jobId)
        if (result.error) { setError(`${run.videoTitle}: ${result.error}`); break }
        setSelected((current) => { const next = new Set(current); next.delete(run.jobId); return next })
      }
    } catch (err) {
      setError(errorMessage(err, 'Could not delete the job.'))
    } finally {
      setDeleting(null)
      await load()
    }
  }

  /** Ask first, naming every folder that will go and what is in it. */
  const askDelete = (runs: RunStorage[]): void => {
    if (runs.length === 0) return
    const total = runs.reduce((sum, run) => sum + run.totalBytes, 0)
    const withClips = runs.filter((run) => run.clipBytes > 0).length
    const one = runs.length === 1
    setConfirm({
      title: one ? 'Delete this job folder?' : `Delete ${runs.length} job folders?`,
      body: (
        <div className="space-y-2">
          <p>{one ? 'This folder and everything in it' : 'These folders and everything in them'} (stream, clips, thumbnails, transcript and review) move to the Recycle Bin:</p>
          <ul className="glass-well max-h-48 divide-y divide-white/[0.05] overflow-y-auto rounded-xl">
            {runs.map((run) => (
              <li key={run.jobId} className="flex items-center gap-3 px-3 py-1.5 text-xs">
                <span className="min-w-0 flex-1 truncate text-ink" title={run.videoTitle}>{run.videoTitle}</span>
                {run.clipBytes > 0 && <span className="shrink-0 text-ink-subtle">clips {formatBytes(run.clipBytes)}</span>}
                <span className="w-16 shrink-0 text-right font-mono tabular text-ink-muted">{formatBytes(run.totalBytes)}</span>
              </li>
            ))}
          </ul>
          <p>Total: <span className="font-medium text-ink">{formatBytes(total)}</span></p>
          {withClips > 0 && <p className="text-warning">{one ? 'Its clips leave' : `${withClips} of them ${withClips === 1 ? 'has clips that leave' : 'have clips that leave'}`} the Library. Posts already made stay online.</p>}
          {runs.some((run) => run.sourceIsUserFile) && <p className="text-ink-muted">Your own video files stay where they are.</p>}
          <p className="text-ink-muted">Empty the Recycle Bin to free the space.</p>
        </div>
      ),
      confirmLabel: one ? 'Delete' : `Delete ${runs.length}`,
      onConfirm: () => void deleteJobs(runs)
    })
  }

  const toggle = (jobId: string): void => setSelected((current) => {
    const next = new Set(current)
    if (next.has(jobId)) next.delete(jobId)
    else next.add(jobId)
    return next
  })

  const rows = showAll ? usage.runs : usage.runs.slice(0, COLLAPSED_ROWS)

  return (
    <Panel padded={false} className="overflow-hidden">
      <section aria-label="Storage">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-white/[0.06] py-2 pl-4 pr-2">
          <Checkbox
            checked={allPicked}
            indeterminate={picked.length > 0 && !allPicked}
            disabled={deletable.length === 0 || deleting !== null}
            onChange={() => setSelected(allPicked ? new Set() : new Set(deletable.map((run) => run.jobId)))}
            label="Select all jobs"
          />
          <h2 className="flex items-center gap-2">
            <HardDrive className="h-3.5 w-3.5 text-ink-subtle" />
            <span className="eyebrow">Storage</span>
          </h2>
          <p className="mr-auto text-xs text-ink-muted">
            <span className="font-medium text-ink">{formatBytes(usage.totalBytes)}</span> used by jobs
            {usage.sourceBytes > 0 && <> · <span className="text-ink">{formatBytes(usage.sourceBytes)}</span> in downloaded streams</>}
            {picked.length > 0 && <> · <span className="text-ink">{picked.length} selected</span> ({formatBytes(picked.reduce((sum, run) => sum + run.totalBytes, 0))})</>}
          </p>
          {picked.length > 0 && (
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())} disabled={deleting !== null}>Clear</Button>
          )}
          {picked.length > 0 && (
            <Button
              size="sm"
              variant="danger"
              icon={<Trash2 className="h-3.5 w-3.5" />}
              loading={deleting === 'many'}
              disabled={deleting !== null}
              onClick={() => askDelete(picked)}
              title="Move the selected job folders to the Recycle Bin"
            >
              Delete selected ({picked.length})
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            icon={<Trash2 className="h-3.5 w-3.5" />}
            disabled={deletable.length === 0 || deleting !== null}
            onClick={() => askDelete(deletable)}
            title="Move every job folder to the Recycle Bin"
            className="hover:bg-danger/10 hover:text-danger"
          >
            Delete all
          </Button>
        </div>
        {error && <div className="px-3 pt-2"><Callout tone="danger" onDismiss={() => setError(null)}>{error}</Callout></div>}
        <ul className="divide-y divide-white/[0.05]">
          {rows.map((run) => (
            <li key={run.jobId} className={cn('group/row flex items-center gap-3 py-2 pl-4 pr-2', selected.has(run.jobId) && 'bg-accent/[0.06]')}>
              <Checkbox
                checked={selected.has(run.jobId)}
                disabled={run.busy || deleting !== null}
                onChange={() => toggle(run.jobId)}
                label={`Select ${run.videoTitle}`}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-ink">{run.videoTitle}</span>
                <span className="block truncate text-2xs text-ink-subtle">
                  {run.sourceBytes > 0
                    ? <>Stream <span className="text-ink-muted">{formatBytes(run.sourceBytes)}</span></>
                    : run.sourceIsUserFile ? 'Your own file, not counted' : 'No stream kept'}
                  {' · '}Clips <span className="text-ink-muted">{formatBytes(run.clipBytes)}</span>
                  {' · '}Other {formatBytes(run.otherBytes)}
                  {!run.date.startsWith('1970-') && ` · ${formatRelativeDate(run.date)}`}
                </span>
              </span>
              <span className="w-20 shrink-0 text-right font-mono text-xs tabular text-ink">{formatBytes(run.totalBytes)}</span>
              <Button
                size="sm"
                variant="ghost"
                iconOnly
                aria-label={`Open the folder for ${run.videoTitle}`}
                title="Open folder"
                icon={<FolderOpen className="h-3.5 w-3.5" />}
                onClick={() => { void onOpenFolder(run.outputDir) }}
                className="opacity-0 transition-opacity focus-visible:opacity-100 group-hover/row:opacity-100"
              />
              <Button
                size="sm"
                variant="ghost"
                icon={<Trash2 className="h-3.5 w-3.5" />}
                disabled={run.busy || deleting !== null}
                loading={deleting === `job:${run.jobId}`}
                onClick={() => askDelete([run])}
                aria-label={`Delete the job ${run.videoTitle}`}
                title={run.busy ? 'Rendering…' : 'Move the whole job folder to the Recycle Bin: stream, clips and everything else'}
                className={cn('w-[96px] justify-start', !run.busy && 'hover:bg-danger/10 hover:text-danger')}
              >
                {run.busy ? 'Rendering…' : 'Delete'}
              </Button>
            </li>
          ))}
        </ul>
        {usage.runs.length > COLLAPSED_ROWS && (
          <button
            onClick={() => setShowAll((value) => !value)}
            className="flex w-full items-center justify-center gap-1.5 border-t border-white/[0.06] py-1.5 text-xs text-ink-muted hover:bg-white/[0.03] hover:text-ink"
          >
            <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', showAll && 'rotate-180')} />
            {showAll ? 'Show fewer' : `Show all ${usage.runs.length} jobs`}
          </button>
        )}
      </section>
      {confirm && <ConfirmDialog request={confirm} onClose={closeConfirm} />}
    </Panel>
  )
}
