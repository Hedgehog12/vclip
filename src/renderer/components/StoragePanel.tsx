import { useCallback, useEffect, useState } from 'react'
import { ChevronDown, FolderOpen, HardDrive, Trash2 } from 'lucide-react'
import type { RunStorage, StorageUsage } from '../../preload/index'
import { getApi } from '../lib/ipc'
import { cn, errorMessage, formatBytes, formatRelativeDate } from '../lib/utils'
import { Button } from './ui/Button'
import { Callout } from './ui/Callout'
import { Panel } from './ui/Panel'

const COLLAPSED_ROWS = 5

/**
 * Disk space each job uses: its downloaded stream (kept so more ideas can be
 * rendered), its rendered clips, and the rest. A stream can be deleted with
 * one click; the clips stay.
 */
export function StoragePanel({ refreshKey, onOpenFolder, onChanged }: {
  refreshKey: unknown
  onOpenFolder: (dir: string) => void
  onChanged: () => void
}): React.JSX.Element | null {
  const [usage, setUsage] = useState<StorageUsage | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | 'all' | null>(null)
  const [showAll, setShowAll] = useState(false)

  const load = useCallback(async () => {
    try { setUsage(await getApi().storage.usage()) }
    catch (err) { setError(errorMessage(err, 'Could not measure disk use.')) }
  }, [])

  useEffect(() => { void load() }, [load, refreshKey])

  if (!usage || usage.runs.length === 0) return null

  const deleteOne = async (run: RunStorage): Promise<boolean> => {
    const result = await getApi().storage.deleteSource(run.jobId)
    if (result.error) { setError(result.error); return false }
    return true
  }

  const remove = async (target: RunStorage | 'all'): Promise<void> => {
    setError(null)
    setDeleting(target === 'all' ? 'all' : target.jobId)
    try {
      if (target === 'all') {
        for (const run of usage.runs.filter((r) => r.sourceBytes > 0 && !r.busy)) {
          if (!await deleteOne(run)) break
        }
      } else {
        await deleteOne(target)
      }
    } catch (err) {
      setError(errorMessage(err, 'Could not delete the downloaded video.'))
    } finally {
      setDeleting(null)
      await load()
      onChanged()
    }
  }

  const rows = showAll ? usage.runs : usage.runs.slice(0, COLLAPSED_ROWS)
  const streams = usage.runs.filter((run) => run.sourceBytes > 0 && !run.busy).length

  return (
    <Panel padded={false} className="overflow-hidden">
      <section aria-label="Storage">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-white/[0.06] py-2 pl-4 pr-2">
          <h2 className="flex items-center gap-2">
            <HardDrive className="h-3.5 w-3.5 text-ink-subtle" />
            <span className="eyebrow">Storage</span>
          </h2>
          <p className="mr-auto text-xs text-ink-muted">
            <span className="font-medium text-ink">{formatBytes(usage.totalBytes)}</span> used by jobs
            {usage.sourceBytes > 0 && <> · <span className="text-ink">{formatBytes(usage.sourceBytes)}</span> in downloaded streams</>}
          </p>
          {streams > 0 && (
            <Button
              size="sm"
              variant="ghost"
              icon={<Trash2 className="h-3.5 w-3.5" />}
              loading={deleting === 'all'}
              disabled={deleting !== null}
              onClick={() => { void remove('all') }}
              title="Delete every kept stream. Rendered clips stay."
            >
              Delete all streams
            </Button>
          )}
        </div>
        {error && <div className="px-3 pt-2"><Callout tone="danger" onDismiss={() => setError(null)}>{error}</Callout></div>}
        <ul className="divide-y divide-white/[0.05]">
          {rows.map((run) => (
            <li key={run.jobId} className="group/row flex items-center gap-3 py-2 pl-4 pr-2">
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
                onClick={() => onOpenFolder(run.outputDir)}
                className="opacity-0 transition-opacity focus-visible:opacity-100 group-hover/row:opacity-100"
              />
              <Button
                size="sm"
                variant="ghost"
                icon={<Trash2 className="h-3.5 w-3.5" />}
                disabled={run.sourceBytes === 0 || run.busy || deleting !== null}
                loading={deleting === run.jobId}
                onClick={() => { void remove(run) }}
                title={run.busy ? 'Rendering…' : run.sourceBytes > 0 ? 'Delete the downloaded stream. Rendered clips stay.' : 'Nothing to delete'}
                className={cn('w-[118px] justify-start', run.sourceBytes > 0 && !run.busy && 'hover:bg-danger/10 hover:text-danger')}
              >
                {run.busy ? 'Rendering…' : 'Delete stream'}
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
    </Panel>
  )
}
