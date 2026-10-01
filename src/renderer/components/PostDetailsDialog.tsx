import { useEffect, useId, useRef, useState } from 'react'
import { ArrowUpRight, FolderOpen, ImageOff, TriangleAlert, X } from 'lucide-react'
import { getApi } from '../lib/ipc'
import { cn, errorMessage, localFileUrl } from '../lib/utils'
import { usePostsStore } from '../store/use-posts-store'
import { TIKTOK_PRIVACY_LABELS, YOUTUBE_CATEGORIES, type PostDetails, type PostRecord, type PostRecordTarget } from '../../shared/zernio-posts'
import { PlatformIcon, platformName } from './PlatformIcon'
import { targetBadge } from './PostDialog'
import { Badge } from './ui/Badge'
import { Button } from './ui/Button'
import { Callout } from './ui/Callout'
import { Dialog, DialogFooter } from './ui/Dialog'

function dateTime(iso: string | null): string | null {
  if (!iso) return null
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : null
}

/** What was sent to one account, in plain words. */
function targetFacts(target: PostRecordTarget, details: PostDetails): string[] {
  const facts: string[] = []
  if (target.platform === 'youtube' && details.youtube) {
    const y = details.youtube
    facts.push(`Title: ${y.title}`)
    facts.push(`Category: ${YOUTUBE_CATEGORIES.find((category) => category.id === y.categoryId)?.label ?? 'People & Blogs'}`)
    facts.push(`Visibility: ${y.visibility}${y.madeForKids ? ' · made for kids' : ''}`)
    if (y.tags.length > 0) facts.push(`Tags: ${y.tags.join(', ')}`)
  }
  if (target.platform === 'instagram' && details.instagram) {
    facts.push(details.instagram.shareToFeed ? 'Also shown in the feed' : 'Reel only, not in the feed')
  }
  if (target.platform === 'facebook' && details.facebook) {
    facts.push(`Format: ${details.facebook.format === 'reel' ? 'Reel' : 'Feed video'}`)
    if (details.facebook.title) facts.push(`Title: ${details.facebook.title}`)
  }
  if (target.platform === 'threads' && details.threads?.topicTag) facts.push(`Topic: ${details.threads.topicTag}`)
  if (target.platform === 'tiktok' && details.tiktok) {
    if (details.tiktok.draft) facts.push('Sent to the TikTok inbox')
    else {
      const level = details.tiktok.privacy[target.accountId]
      if (level) facts.push(`Who can watch: ${(TIKTOK_PRIVACY_LABELS as Record<string, string>)[level] ?? level}`)
    }
    if (details.tiktok.madeWithAi) facts.push('Marked as made with AI')
  }
  return facts
}

/**
 * Everything about one post in one place: what was sent (caption, thumbnail,
 * YouTube fields), how it went on each account, and shortcuts to the files.
 */
export function PostDetailsDialog({ post, when, onClose }: { post: PostRecord; when: string; onClose: () => void }): React.JSX.Element {
  const titleId = useId()
  const dialogRef = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [thumbnailBroken, setThumbnailBroken] = useState(false)
  const details = post.details ?? null
  const thumbnail = details?.thumbnailPath ?? null
  const shorts = post.targets.some((target) => target.platform === 'youtube' && target.url?.includes('/shorts/'))
  const coverPlatforms = [...new Set(post.targets.map((target) => target.platform).filter((platform) => platform === 'instagram' || platform === 'youtube'))]
  const times: [string, string | null][] = [
    ['Scheduled for', post.status === 'scheduled' || post.scheduledFor ? dateTime(post.scheduledFor) : null],
    ['Created', dateTime(post.createdAt)],
    ['Clip uploaded to Zernio', dateTime(post.uploadedAt)],
    ['Status last checked', dateTime(post.refreshedAt)]
  ]

  useEffect(() => {
    dialogRef.current?.focus()
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') { event.preventDefault(); onClose() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const run = (action: () => Promise<unknown>, fallback: string): void => {
    setError(null)
    action().catch((err) => setError(errorMessage(err, fallback)))
  }
  const showInFolder = (path: string, missing: string): void => run(async () => {
    if (!await getApi().shell.showItemInFolder(path)) throw new Error(missing)
  }, 'Could not show the file.')

  return (
    <Dialog ref={dialogRef} aria-labelledby={titleId} onBackdropMouseDown={onClose} panelClassName="max-w-[680px]">
      <div className="flex items-start justify-between gap-3 px-5 pt-5">
        <div className="min-w-0">
          <p className="eyebrow">Post details</p>
          <h2 id={titleId} className="mt-1 line-clamp-2 text-lg font-semibold leading-snug text-ink" title={post.clipTitle}>{post.clipTitle || 'Untitled clip'}</h2>
          <p className="mt-1 text-xs text-ink-muted">{when}</p>
        </div>
        <Button variant="ghost" iconOnly aria-label="Close" icon={<X className="h-4 w-4" />} onClick={onClose} />
      </div>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-5">
        {!details && (
          <Callout tone="info">
            This post was made before its details were saved, so only its status and links are shown.
          </Callout>
        )}
        {error && <Callout tone="danger" onDismiss={() => setError(null)}>{error}</Callout>}
        {post.error && <Callout tone="danger"><span data-selectable>{post.error}</span></Callout>}

        <section aria-label="Accounts">
          <h3 className="eyebrow mb-2">Accounts</h3>
          <ul className="glass-well divide-y divide-white/[0.06] overflow-hidden rounded-2xl">
            {post.targets.map((target, index) => {
              const badge = targetBadge(target, post.status)
              const facts = details ? targetFacts(target, details) : []
              const ownText = details?.accountCaptions[target.accountId]
              return (
                <li key={`${target.platform}:${target.accountId}`} className="px-3 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <PlatformIcon platform={target.platform} className="h-8 w-8 rounded-[10px] [&_svg]:h-[15px] [&_svg]:w-[15px]" />
                    <span className="min-w-0 flex-1 truncate text-sm text-ink">
                      {platformName(target.platform)}
                      {target.handle && <span className="ml-1.5 text-ink-muted">{target.handle}</span>}
                    </span>
                    <Badge tone={badge.tone}>{badge.label}</Badge>
                    {target.url && (
                      <Button size="sm" variant="ghost" trailingIcon={<ArrowUpRight className="h-3.5 w-3.5" />}
                        onClick={() => usePostsStore.getState().open(post.id, index)}>
                        Open
                      </Button>
                    )}
                    {target.platform === 'youtube' && target.url && (
                      <Button size="sm" variant="ghost" trailingIcon={<ArrowUpRight className="h-3.5 w-3.5" />}
                        title="Edit this video in YouTube Studio, for example to set its thumbnail"
                        onClick={() => run(() => getApi().zernio.posts.openStudio(post.id, index), 'Could not open YouTube Studio.')}>
                        YouTube Studio
                      </Button>
                    )}
                  </div>
                  {target.error && <p className="mt-1.5 text-xs text-danger" data-selectable>{target.error}</p>}
                  {facts.length > 0 && (
                    <ul className="mt-2 space-y-0.5 pl-10 text-xs text-ink-muted" data-selectable>
                      {facts.map((fact) => <li key={fact} className="break-words">{fact}</li>)}
                    </ul>
                  )}
                  {ownText && (
                    <p className="mt-2 whitespace-pre-line break-words pl-10 text-xs text-ink-muted" data-selectable>
                      <span className="text-ink-subtle">Own text for this account: </span>{ownText}
                    </p>
                  )}
                </li>
              )
            })}
          </ul>
        </section>

        {details && (
          <section aria-label="Caption">
            <h3 className="eyebrow mb-2">Caption</h3>
            <p className="glass-well max-h-56 overflow-y-auto whitespace-pre-line break-words rounded-2xl px-3 py-2.5 text-sm leading-relaxed text-ink" data-selectable>
              {details.caption || 'No caption'}
            </p>
          </section>
        )}

        {details && (
          <section aria-label="Thumbnail">
            <h3 className="eyebrow mb-2">Thumbnail</h3>
            {thumbnail ? (
              <div className="flex items-start gap-3">
                {thumbnailBroken ? (
                  <div className="glass-tile flex h-28 w-16 shrink-0 items-center justify-center rounded-lg text-ink-subtle"><ImageOff className="h-4 w-4" /></div>
                ) : (
                  <img src={localFileUrl(thumbnail)} alt="Thumbnail sent with the post" draggable={false} onError={() => setThumbnailBroken(true)}
                    className="max-h-40 max-w-[160px] shrink-0 rounded-lg object-contain ring-1 ring-white/[0.12]" />
                )}
                <div className="min-w-0 text-xs leading-relaxed text-ink-muted">
                  <p>Sent as the {coverPlatforms.map((platform) => (platform === 'instagram' ? 'Instagram cover' : 'YouTube thumbnail')).join(' and ')}.</p>
                  {shorts && (
                    <p className="mt-1.5 flex gap-1.5 text-warning">
                      <TriangleAlert className="mt-px h-3.5 w-3.5 shrink-0" />
                      YouTube Shorts ignore it for now. Set it in YouTube Studio (button above) under Thumbnail → Upload file.
                    </p>
                  )}
                </div>
              </div>
            ) : (
              <p className="text-xs text-ink-muted">No thumbnail was sent with this post.</p>
            )}
          </section>
        )}

        {details && details.warnings.length > 0 && (
          <section aria-label="Notices from Zernio">
            <h3 className="eyebrow mb-2">Notices from Zernio</h3>
            <ul className="space-y-1 text-xs text-warning">
              {details.warnings.map((warning) => <li key={warning} data-selectable>{warning}</li>)}
            </ul>
          </section>
        )}

        <section aria-label="Timing">
          <h3 className="eyebrow mb-2">Timing</h3>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
            {times.filter(([, value]) => value).map(([label, value]) => (
              <div key={label} className="contents">
                <dt className="text-ink-subtle">{label}</dt>
                <dd className={cn('text-ink-muted')}>{value}{label === 'Scheduled for' && post.timezone ? ` (${post.timezone})` : ''}</dd>
              </div>
            ))}
          </dl>
        </section>
      </div>

      <DialogFooter>
        <Button icon={<FolderOpen className="h-3.5 w-3.5" />} title={post.clipPath}
          onClick={() => showInFolder(post.clipPath, 'The clip file is no longer there.')}>
          Show clip file
        </Button>
        {thumbnail && (
          <Button icon={<FolderOpen className="h-3.5 w-3.5" />} onClick={() => showInFolder(thumbnail, 'The thumbnail file is no longer there.')}>
            Show thumbnail file
          </Button>
        )}
        <Button variant="primary" onClick={onClose}>Close</Button>
      </DialogFooter>
    </Dialog>
  )
}
