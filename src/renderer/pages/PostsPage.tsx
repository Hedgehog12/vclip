import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowUpRight, CalendarClock, Clapperboard, FileText, Info, Plus, RefreshCw, RotateCcw, Search, Send, Trash2, X } from 'lucide-react'
import { cn, errorMessage, formatRelativeDate } from '../lib/utils'
import { getApi } from '../lib/ipc'
import { loadClipCover } from '../lib/thumbnails'
import { usePostsStore } from '../store/use-posts-store'
import { useSettingsStore } from '../store/use-settings-store'
import { ensureAccountsLoaded, useAccountsStore } from '../store/use-accounts-store'
import { ZERNIO_LINKS } from '../../shared/brand'
import { ZERNIO_PLATFORMS, type ZernioPlatform } from '../../shared/zernio'
import {
  DEFAULT_POSTS_FILTER,
  POSTS_SORTS,
  REMOTE_POST_STATUSES,
  filterAndSortPosts,
  postListDate,
  postListItemFromRecord,
  scheduleError,
  scheduleWindow,
  type PostDraft,
  type PostDraftEntry,
  type PostListItem,
  type PostRecord,
  type PostStatus,
  type PostsFilter,
  type PostsSort
} from '../../shared/zernio-posts'
import { PlatformIcon, platformName } from '../components/PlatformIcon'
import { PostDialog, formatScheduled, postableFromDraft, targetBadge, type PostableClip } from '../components/PostDialog'
import { ClipPickerDialog } from '../components/ClipPickerDialog'
import { PostDetailsDialog } from '../components/PostDetailsDialog'
import { Page as PageColumn } from '../components/ui/Page'
import { PageHeader } from '../components/ui/PageHeader'
import { Panel } from '../components/ui/Panel'
import { Badge, type Tone } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { Callout } from '../components/ui/Callout'
import { EmptyState } from '../components/ui/EmptyState'
import { TextInput, WELL } from '../components/ui/Field'
import { Segmented } from '../components/ui/Segmented'
import { Select, type SelectOption } from '../components/ui/Select'
import type { Page } from '../components/Sidebar'

const TITLE = 'Posts'
/** Statuses only change on Zernio's side; the main process decides which posts are worth a request. */
const POLL_MS = 30_000
/** Rows shown at first, and added by "Show more", for posts made here. */
const LOCAL_PAGE = 50
/** Rows per request to Zernio for the workspace list. */
const REMOTE_PAGE = 50
const SEARCH_DEBOUNCE_MS = 300
const VIEW_STORAGE_KEY = 'vlasiichukclip.posts.view'
/** Content, platforms, date, status, profile, actions. */
const ROW_GRID = 'lg:grid-cols-[minmax(0,1fr)_96px_120px_120px_110px_216px]'

type Source = 'app' | 'zernio'
type DateRange = 'all' | 'upcoming' | 'next7' | 'last7' | 'last30' | 'thisMonth'

interface ViewState {
  source: Source
  range: DateRange
  filter: Pick<PostsFilter, 'status' | 'platform' | 'profileId' | 'sort'>
}

const SORT_LABELS: Record<PostsSort, string> = {
  'scheduled-desc': 'Date (newest first)',
  'scheduled-asc': 'Date (oldest first)',
  'created-desc': 'Created (newest first)',
  'created-asc': 'Created (oldest first)',
  status: 'Status',
  platform: 'Platform'
}

const STATUS_LABELS: Record<PostStatus, string> = {
  draft: 'Draft',
  scheduled: 'Scheduled',
  publishing: 'Publishing',
  published: 'Published',
  partial: 'Partly published',
  failed: 'Failed',
  cancelled: 'Cancelled',
  missing: 'Not in Zernio'
}

const STATUS_TONES: Record<PostStatus, Tone> = {
  draft: 'neutral',
  scheduled: 'accent',
  publishing: 'accent',
  published: 'success',
  partial: 'warning',
  failed: 'danger',
  cancelled: 'neutral',
  missing: 'danger'
}

const STATUS_OPTIONS: SelectOption[] = [
  { value: '', label: 'All statuses' },
  ...REMOTE_POST_STATUSES.map((status) => ({ value: status, label: STATUS_LABELS[status] })),
  { value: 'missing', label: STATUS_LABELS.missing }
]

const DATE_RANGES: { value: DateRange; label: string }[] = [
  { value: 'all', label: 'All dates' },
  { value: 'upcoming', label: 'Upcoming' },
  { value: 'next7', label: 'Next 7 days' },
  { value: 'last7', label: 'Last 7 days' },
  { value: 'last30', label: 'Last 30 days' },
  { value: 'thisMonth', label: 'This month' }
]

const DEFAULT_VIEW: ViewState = {
  source: 'app',
  range: 'all',
  filter: { status: null, platform: null, profileId: null, sort: DEFAULT_POSTS_FILTER.sort }
}

function readView(): ViewState {
  try {
    const raw = JSON.parse(localStorage.getItem(VIEW_STORAGE_KEY) ?? 'null') as Partial<ViewState> | null
    if (!raw || typeof raw !== 'object') return DEFAULT_VIEW
    const filter = (raw.filter ?? {}) as Partial<ViewState['filter']>
    return {
      source: raw.source === 'zernio' ? 'zernio' : 'app',
      range: DATE_RANGES.some((r) => r.value === raw.range) ? (raw.range as DateRange) : 'all',
      filter: {
        status: STATUS_OPTIONS.some((o) => o.value && o.value === filter.status) ? (filter.status as PostStatus) : null,
        platform: ZERNIO_PLATFORMS.includes(filter.platform as ZernioPlatform) ? (filter.platform as ZernioPlatform) : null,
        profileId: typeof filter.profileId === 'string' ? filter.profileId : null,
        sort: POSTS_SORTS.includes(filter.sort as PostsSort) ? (filter.sort as PostsSort) : DEFAULT_POSTS_FILTER.sort
      }
    }
  } catch { return DEFAULT_VIEW }
}

function saveView(view: ViewState): void {
  try { localStorage.setItem(VIEW_STORAGE_KEY, JSON.stringify(view)) } catch { /* Optional convenience only. */ }
}

const DAY_MS = 86_400_000

/** The range as ISO bounds, worked out when the filters change. */
function rangeBounds(range: DateRange, now = Date.now()): { fromDate: string | null; toDate: string | null } {
  const iso = (ms: number): string => new Date(ms).toISOString()
  switch (range) {
    case 'upcoming': return { fromDate: iso(now), toDate: null }
    case 'next7': return { fromDate: iso(now), toDate: iso(now + 7 * DAY_MS) }
    case 'last7': return { fromDate: iso(now - 7 * DAY_MS), toDate: iso(now) }
    case 'last30': return { fromDate: iso(now - 30 * DAY_MS), toDate: iso(now) }
    case 'thisMonth': {
      const d = new Date(now)
      return { fromDate: iso(new Date(d.getFullYear(), d.getMonth(), 1).getTime()), toDate: iso(new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime() - 1) }
    }
    default: return { fromDate: null, toDate: null }
  }
}

function toLocalInput(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function listDate(item: PostListItem): { date: string; time: string } {
  const at = new Date(postListDate(item))
  const sameYear = at.getFullYear() === new Date().getFullYear()
  return {
    date: at.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) }),
    time: at.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  }
}

/** The post's state in words; also the details dialog's subtitle. */
function whenText(post: PostRecord): string {
  switch (post.status) {
    case 'scheduled':
      return post.scheduledFor ? `Scheduled for ${formatScheduled(post.scheduledFor, post.timezone)}` : 'Scheduled'
    case 'publishing':
      return 'Publishing…'
    case 'published':
      return `Posted ${formatRelativeDate(post.createdAt)}`
    case 'partial':
      return `Partly posted ${formatRelativeDate(post.createdAt)}`
    case 'failed':
      return `Failed ${formatRelativeDate(post.createdAt)}`
    case 'cancelled':
      return `Cancelled · created ${formatRelativeDate(post.createdAt)}`
    case 'missing':
      return 'No longer in your Zernio workspace'
    default:
      return `Saved as a draft in Zernio ${formatRelativeDate(post.createdAt)}`
  }
}

function openLink(url: string): void {
  void getApi().shell.openPath(url).catch(() => {})
}

export function PostsPage({ onNavigate }: { onNavigate: (page: Page) => void }): React.JSX.Element {
  const configured = useSettingsStore((s) => s.zernioConfigured)
  return (
    <PageColumn width="default">
      {configured ? (
        <PostsList onNavigate={onNavigate} />
      ) : (
        <>
          <PageHeader title={TITLE} />
          <EmptyState
            className="mt-4"
            icon={<Send />}
            title="Connect your social accounts"
            description="Clips you post or schedule from vClip show up here once Zernio is set up in Accounts."
            action={<Button variant="primary" onClick={() => onNavigate('accounts')}>Open Accounts</Button>}
          />
        </>
      )}
    </PageColumn>
  )
}

interface RemotePosts {
  items: PostListItem[]
  loading: boolean
  error: string | null
  hasMore: boolean
  loadMore: () => void
  reload: () => void
  clearError: () => void
}

/** The workspace list from Zernio, one page at a time. Starts over when the query changes; null pauses it. */
function useRemotePosts(query: PostsFilter | null): RemotePosts {
  const [items, setItems] = useState<PostListItem[]>([])
  const [page, setPage] = useState(0)
  const [pages, setPages] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [generation, setGeneration] = useState(0)
  const request = useRef(0)
  const key = query ? JSON.stringify(query) : null

  const fetchPage = useCallback(async (next: number, append: boolean): Promise<void> => {
    if (!key) return
    const id = ++request.current
    setLoading(true)
    setError(null)
    try {
      const result = await getApi().zernio.posts.listRemote({ ...(JSON.parse(key) as PostsFilter), page: next, limit: REMOTE_PAGE })
      if (id !== request.current) return
      setItems((current) => {
        if (!append) return result.items
        const seen = new Set(current.map((item) => item.id))
        return [...current, ...result.items.filter((item) => !seen.has(item.id))]
      })
      setPage(result.page)
      setPages(result.pages)
    } catch (err) {
      if (id === request.current) setError(errorMessage(err, 'Could not load posts from Zernio.'))
    } finally {
      if (id === request.current) setLoading(false)
    }
  }, [key])

  useEffect(() => {
    if (!key) {
      request.current += 1
      setItems([])
      setPage(0)
      setPages(0)
      setLoading(false)
      return
    }
    void fetchPage(1, false)
  }, [key, generation, fetchPage])

  return {
    items,
    loading,
    error,
    hasMore: page > 0 && page < pages,
    loadMore: () => { if (!loading) void fetchPage(page + 1, true) },
    reload: () => setGeneration((g) => g + 1),
    clearError: () => setError(null)
  }
}

/** Posts made from vClip, or every post in the Zernio workspace, with filters and sorting. */
function PostsList({ onNavigate }: { onNavigate: (page: Page) => void }): React.JSX.Element {
  const { posts, loaded, refreshing, error, clearError, refresh } = usePostsStore()
  const accounts = useAccountsStore((s) => s.accounts)
  const profiles = useAccountsStore((s) => s.profiles)
  const [view, setView] = useState<ViewState>(readView)
  const [searchText, setSearchText] = useState('')
  const [search, setSearch] = useState('')
  const [shown, setShown] = useState(LOCAL_PAGE)
  // Create post: choose a clip, then the composer (also for continuing a draft).
  const [picking, setPicking] = useState(false)
  const [composing, setComposing] = useState<{ clip: PostableClip; draft: PostDraft | null } | null>(null)
  const [drafts, setDrafts] = useState<PostDraftEntry[] | null>(null)
  const [draftsError, setDraftsError] = useState<string | null>(null)

  const loadDrafts = useCallback((): void => {
    getApi().zernio.drafts.list()
      .then((list) => { setDrafts(list); setDraftsError(null) })
      .catch((err) => setDraftsError(errorMessage(err, 'Could not read your drafts.')))
  }, [])
  useEffect(() => loadDrafts(), [loadDrafts])

  const update = (change: (current: ViewState) => ViewState): void => {
    setView((current) => {
      const next = change(current)
      saveView(next)
      return next
    })
    setShown(LOCAL_PAGE)
  }
  const setFilter = (change: Partial<ViewState['filter']>): void => update((current) => ({ ...current, filter: { ...current.filter, ...change } }))

  useEffect(() => {
    void usePostsStore.getState().load().then(() => usePostsStore.getState().refresh(false))
    void ensureAccountsLoaded().catch(() => {})
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void usePostsStore.getState().refresh(false)
    }, POLL_MS)
    const onFocus = (): void => void usePostsStore.getState().refresh(false)
    window.addEventListener('focus', onFocus)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', onFocus)
    }
  }, [])

  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(searchText.trim())
      setShown(LOCAL_PAGE)
    }, SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [searchText])

  // A saved profile only applies while its dropdown is shown and the profile still exists.
  const profileId = profiles.length > 1 && profiles.some((profile) => profile.id === view.filter.profileId) ? view.filter.profileId : null
  const filter: PostsFilter = useMemo(
    () => ({ ...view.filter, profileId, ...rangeBounds(view.range), search }),
    [view, profileId, search]
  )

  const profileOfAccount = useMemo(() => {
    const map = new Map(accounts.map((account) => [account.id, account.profileId]))
    return (accountId: string): string | null => map.get(accountId) ?? null
  }, [accounts])
  const profileName = (item: PostListItem): string | null => {
    const id = item.profileId ?? item.targets.map((t) => profileOfAccount(t.accountId)).find(Boolean) ?? null
    return id ? profiles.find((profile) => profile.id === id)?.name ?? null : null
  }

  // Zernio has no 'missing' status; it only exists for posts made here.
  const remoteQuery = view.source === 'zernio' && filter.status !== 'missing' ? filter : null
  const remote = useRemotePosts(remoteQuery)

  const localItems = useMemo(
    () => filterAndSortPosts(posts.map(postListItemFromRecord), filter, profileOfAccount),
    [posts, filter, profileOfAccount]
  )
  const isApp = view.source === 'app'
  const items = isApp ? localItems.slice(0, shown) : remote.items
  const busy = refreshing || remote.loading
  const filtersActive = Boolean(view.filter.status || view.filter.platform || profileId || view.range !== 'all' || search)

  const reload = (): void => {
    void refresh(true)
    if (!isApp) remote.reload()
  }
  const clearFilters = (): void => {
    setSearchText('')
    setSearch('')
    update((current) => ({ ...current, range: 'all', filter: { ...DEFAULT_VIEW.filter, sort: current.filter.sort } }))
  }

  const platformOptions: SelectOption[] = [
    { value: '', label: 'All platforms' },
    ...ZERNIO_PLATFORMS.map((platform) => ({ value: platform, label: platformName(platform) }))
  ]
  const profileOptions: SelectOption[] = [
    { value: '', label: 'All profiles' },
    ...profiles.map((profile) => ({ value: profile.id, label: profile.name }))
  ]

  let body: React.ReactNode
  if (isApp && !loaded) {
    body = <Panel padded={false}><p role="status" className="px-4 py-3 text-xs text-ink-muted">Loading your posts…</p></Panel>
  } else if (!isApp && remote.loading && items.length === 0) {
    body = <Panel padded={false}><p role="status" className="px-4 py-3 text-xs text-ink-muted">Loading posts from Zernio…</p></Panel>
  } else if (isApp && posts.length === 0 && error) {
    body = (
      <Panel padded={false} className="flex items-center justify-between gap-3 py-2 pl-4 pr-2.5">
        <p className="text-xs text-ink-muted">Your post history is unavailable right now.</p>
        <Button size="sm" onClick={() => void usePostsStore.getState().load()}>Try again</Button>
      </Panel>
    )
  } else if (isApp && posts.length === 0 && drafts && drafts.length > 0) {
    body = <p className="px-1 text-xs text-ink-muted">Nothing posted yet. Open a draft to finish it, or create a new post.</p>
  } else if (isApp && posts.length === 0) {
    body = (
      <EmptyState
        icon={<Send />}
        title="Nothing posted yet"
        description="Choose Create post to pick a clip, or use Post on a clip in the Library. Scheduled posts wait here until they go out."
        action={<Button variant="primary" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setPicking(true)}>Create post</Button>}
      />
    )
  } else if (items.length === 0) {
    body = isApp || (remoteQuery !== null && !remote.error) ? (
      <Panel padded={false} className="flex items-center justify-between gap-3 py-2 pl-4 pr-2.5">
        <p className="text-xs text-ink-muted">{filtersActive ? 'No posts match these filters.' : 'No posts in your Zernio workspace yet.'}</p>
        {filtersActive && <Button size="sm" variant="ghost" onClick={clearFilters}>Clear filters</Button>}
      </Panel>
    ) : null
  } else {
    body = (
      <Panel padded={false} className="overflow-hidden">
        <div aria-hidden className={cn('eyebrow hidden items-center gap-3 border-b border-white/[0.06] py-2 pl-4 pr-2.5 lg:grid', ROW_GRID)}>
          <span>Content</span>
          <span>Platforms</span>
          <span>Date</span>
          <span>Status</span>
          <span>Profile</span>
          <span />
        </div>
        <ul className="divide-y divide-white/[0.05]" aria-label="Posts">
          {items.map((item) => (
            <PostRow key={item.id} item={item} profile={profileName(item)} onChanged={isApp ? undefined : remote.reload} />
          ))}
        </ul>
        {isApp && localItems.length > shown && (
          <div className="border-t border-white/[0.06] px-2.5 py-1.5">
            <Button variant="ghost" size="sm" onClick={() => setShown((n) => n + LOCAL_PAGE)}>
              Show more ({localItems.length - shown} more)
            </Button>
          </div>
        )}
        {!isApp && remote.hasMore && (
          <div className="border-t border-white/[0.06] px-2.5 py-1.5">
            <Button variant="ghost" size="sm" loading={remote.loading} onClick={remote.loadMore}>Load more</Button>
          </div>
        )}
      </Panel>
    )
  }

  return (
    <>
      <PageHeader
        title={TITLE}
        description="Your scheduled and published posts"
        className="items-center"
        actions={
          <>
            <Button
              variant="ghost"
              iconOnly
              aria-label="Refresh posts"
              title="Refresh"
              onClick={reload}
              disabled={busy}
              icon={<RefreshCw className={cn('h-3.5 w-3.5', busy && 'animate-spin')} />}
            />
            <Button trailingIcon={<ArrowUpRight className="h-3.5 w-3.5" />} title="Open your Zernio dashboard in the browser" onClick={() => openLink(ZERNIO_LINKS.dashboard)}>
              Open Zernio
            </Button>
            <Button variant="primary" icon={<Plus className="h-3.5 w-3.5" />} title="Choose a clip and write the post" onClick={() => setPicking(true)}>
              Create post
            </Button>
          </>
        }
      />

      <div className="mt-4 flex flex-wrap items-center gap-2" role="toolbar" aria-label="Filter and sort posts">
        <Segmented<Source>
          label="Which posts"
          size="sm"
          value={view.source}
          onChange={(source) => update((current) => ({ ...current, source }))}
          options={[{ value: 'app', label: 'Made here' }, { value: 'zernio', label: 'All in Zernio' }]}
        />
        <Select size="sm" aria-label="Status" className="w-[150px]" value={view.filter.status ?? ''} options={STATUS_OPTIONS}
          onChange={(value) => setFilter({ status: (value || null) as PostStatus | null })} />
        <Select size="sm" aria-label="Platform" className="w-[140px]" value={view.filter.platform ?? ''} options={platformOptions}
          onChange={(value) => setFilter({ platform: (value || null) as ZernioPlatform | null })} />
        {profiles.length > 1 && (
          <Select size="sm" aria-label="Profile" className="w-[140px]" value={view.filter.profileId ?? ''} options={profileOptions}
            onChange={(value) => setFilter({ profileId: value || null })} />
        )}
        <Select size="sm" aria-label="Date" className="w-[140px]" value={view.range} options={DATE_RANGES}
          onChange={(value) => update((current) => ({ ...current, range: value as DateRange }))} />
        <TextInput
          inputSize="sm"
          className="w-[200px]"
          placeholder="Search posts"
          aria-label="Search posts"
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
          leading={<Search className="h-3.5 w-3.5" />}
        />
        <Select size="sm" aria-label="Sort" className="ml-auto w-[190px]" value={view.filter.sort}
          options={POSTS_SORTS.map((sort) => ({ value: sort, label: SORT_LABELS[sort] }))}
          onChange={(value) => setFilter({ sort: value as PostsSort })} />
      </div>

      <div className="mt-3 space-y-3">
        {error && <Callout tone="danger" onDismiss={clearError}>{error}</Callout>}
        {!isApp && remote.error && (
          <Callout tone="danger" onDismiss={remote.clearError} action={<Button size="sm" onClick={remote.reload}>Try again</Button>}>
            {remote.error}
          </Callout>
        )}
        {!isApp && filter.status === 'missing' && (
          <Callout tone="info">“Not in Zernio” only applies to posts made here. Switch to “Made here” to see them.</Callout>
        )}
        {draftsError && <Callout tone="danger" onDismiss={() => setDraftsError(null)}>{draftsError}</Callout>}
        {isApp && (!view.filter.status || view.filter.status === 'draft') && (
          <DraftsPanel
            drafts={(drafts ?? []).filter((d) => !search || [d.clipTitle, d.caption].join('\n').toLocaleLowerCase().includes(search.toLocaleLowerCase()))}
            onOpen={(draft) => setComposing({ clip: postableFromDraft(draft), draft })}
            onDeleted={setDrafts}
            onError={setDraftsError}
          />
        )}
        {body}
        <p className="px-1 text-2xs text-ink-subtle">Zernio publishes scheduled posts even when vClip is closed. Drafts stay on this computer until you post them.</p>
      </div>

      {picking && (
        <ClipPickerDialog
          onClose={() => setPicking(false)}
          onPick={(clip) => { setPicking(false); setComposing({ clip, draft: null }) }}
        />
      )}
      {composing && (
        <PostDialog
          clips={[composing.clip]}
          draft={composing.draft}
          onDraftsChanged={loadDrafts}
          onClose={() => { setComposing(null); loadDrafts(); if (!isApp) remote.reload() }}
          onNavigate={(page) => { if (page !== 'posts') onNavigate(page) }}
        />
      )}
    </>
  )
}

/** When a draft will go out once it is posted, in words. */
function draftPlan(draft: PostDraft): string {
  if (draft.timing.mode === 'queue') return 'Next free queue time'
  if (draft.timing.mode === 'schedule' && draft.timing.scheduledFor) return `Planned for ${formatScheduled(draft.timing.scheduledFor)}`
  return 'Post when ready'
}

/** Posts being prepared on this computer; open one to finish and post it. */
function DraftsPanel({ drafts, onOpen, onDeleted, onError }: {
  drafts: PostDraftEntry[]
  onOpen: (draft: PostDraftEntry) => void
  onDeleted: (drafts: PostDraftEntry[]) => void
  onError: (message: string) => void
}): React.JSX.Element | null {
  const [confirming, setConfirming] = useState<string | null>(null)
  if (drafts.length === 0) return null
  const remove = (id: string): void => {
    getApi().zernio.drafts.delete(id)
      .then((list) => { setConfirming(null); onDeleted(list) })
      .catch((err) => onError(errorMessage(err, 'Could not delete the draft.')))
  }
  return (
    <Panel padded={false} className="overflow-hidden">
      <h2 className="eyebrow flex items-center gap-2 border-b border-white/[0.06] py-2 pl-4 pr-2.5">
        <FileText className="h-3.5 w-3.5" />
        Drafts
        <span className="rounded-full bg-white/[0.07] px-1.5 py-px font-mono text-[10px] tabular tracking-normal text-ink-muted">{drafts.length}</span>
      </h2>
      <ul className="divide-y divide-white/[0.05]" aria-label="Drafts">
        {drafts.map((draft) => {
          const title = draft.clipTitle || draft.caption.split('\n')[0] || 'Untitled draft'
          return (
            <li key={draft.id} className="flex items-center gap-3 py-2 pl-4 pr-2.5 transition-colors duration-150 hover:bg-white/[0.02]">
              <PostThumb clipPath={draft.clipMissing ? null : draft.clipPath} />
              <div className="min-w-0 flex-1">
                <button
                  type="button"
                  disabled={draft.clipMissing}
                  onClick={() => onOpen(draft)}
                  className="block max-w-full truncate text-left text-sm font-medium text-ink enabled:hover:underline enabled:hover:decoration-white/30 enabled:hover:underline-offset-2"
                >
                  {title}
                </button>
                <p className={cn('truncate text-xs', confirming === draft.id ? 'text-ink' : draft.clipMissing ? 'text-danger' : 'text-ink-subtle')}>
                  {confirming === draft.id ? 'Delete this draft? This can’t be undone.'
                    : draft.clipMissing ? 'The clip file was moved or deleted, so this draft can’t be posted.'
                    : `${draftPlan(draft)} · ${draft.accountIds.length} account${draft.accountIds.length === 1 ? '' : 's'} · edited ${formatRelativeDate(draft.updatedAt)}`}
                </p>
              </div>
              <Badge tone="neutral">Draft</Badge>
              <div className="flex shrink-0 items-center gap-1">
                {confirming === draft.id ? (
                  <>
                    <Button size="sm" variant="ghost" onClick={() => setConfirming(null)}>Keep</Button>
                    <Button size="sm" variant="danger" onClick={() => remove(draft.id)}>Delete draft</Button>
                  </>
                ) : (
                  <>
                    <Button size="sm" variant="primary" disabled={draft.clipMissing} onClick={() => onOpen(draft)}>Open</Button>
                    <Button size="sm" variant="ghost" iconOnly aria-label={`Delete draft “${title}”`} title="Delete draft" icon={<Trash2 className="h-3.5 w-3.5" />} onClick={() => setConfirming(draft.id)} />
                  </>
                )}
              </div>
            </li>
          )
        })}
      </ul>
    </Panel>
  )
}

function PostThumb({ clipPath }: { clipPath: string | null }): React.JSX.Element {
  const [thumb, setThumb] = useState<string | null>(null)
  useEffect(() => {
    if (!clipPath) return
    let cancelled = false
    loadClipCover(clipPath).then((url) => { if (!cancelled) setThumb(url) })
    return () => { cancelled = true }
  }, [clipPath])
  return thumb ? (
    <img
      src={thumb}
      alt=""
      draggable={false}
      className="h-10 w-10 shrink-0 rounded-lg object-cover shadow-[0_6px_16px_-8px_rgb(0_0_0/0.7)] ring-1 ring-white/[0.12]"
    />
  ) : (
    <span aria-hidden className="glass-tile flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-ink-subtle">
      {clipPath ? <Clapperboard className="h-3.5 w-3.5" /> : <Send className="h-3.5 w-3.5" />}
    </span>
  )
}

/**
 * One post. Posts made here (with a local record) can be rescheduled,
 * cancelled, retried and opened in detail; others are shown read-only.
 * `onChanged` reloads the workspace list after an action.
 */
function PostRow({ item, profile, onChanged }: { item: PostListItem; profile: string | null; onChanged?: () => void }): React.JSX.Element {
  const post = item.local
  const busy = usePostsStore((s) => (post ? s.busy[post.id] : undefined))
  const { cancel, reschedule, retry, dismiss, open } = usePostsStore.getState()
  const [confirming, setConfirming] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [showDetails, setShowDetails] = useState(false)
  const [linkError, setLinkError] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (editing === null) return
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [editing])

  useEffect(() => {
    if (item.status !== 'scheduled') {
      setEditing(null)
      setConfirming(false)
    }
  }, [item.status])

  const failedTargets = item.targets.filter((t) => t.error)
  const capacity = failedTargets.some((t) => t.platform === 'tiktok' && /capacity/i.test(t.error ?? ''))
  const uploadedAt = post ? Date.parse(post.uploadedAt) : now
  const editingAt = editing ? new Date(editing).getTime() : NaN
  const editingProblem = editing ? scheduleError(editingAt, now, uploadedAt) : null
  const when = listDate(item)
  const title = post?.clipTitle || item.content.split('\n')[0]?.trim() || 'Untitled post'
  const after = (done: Promise<unknown>): void => { void done.then(() => onChanged?.()) }

  const startEditing = (): void => {
    setConfirming(false)
    const currentNow = Date.now()
    setNow(currentNow)
    const current = item.scheduledFor ? Date.parse(item.scheduledFor) : currentNow + 60 * 60_000
    setEditing(toLocalInput(current))
  }

  const saveSchedule = async (): Promise<void> => {
    if (!post || !editing || editingProblem) return
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
    if (await reschedule(post.id, new Date(editingAt).toISOString(), timezone)) {
      setEditing(null)
      onChanged?.()
    }
  }

  const openTarget = (index: number): void => {
    const target = item.targets[index]
    setLinkError(null)
    if (post) open(post.id, index)
    else if (target?.url) getApi().zernio.posts.openUrl(target.url, target.platform).catch((err) => setLinkError(errorMessage(err, 'Could not open the post.')))
  }

  let actions: React.ReactNode = null
  if (post && item.status === 'scheduled') {
    actions = confirming ? (
      <>
        <Button size="sm" variant="ghost" onClick={() => setConfirming(false)} disabled={Boolean(busy)}>Keep</Button>
        <Button size="sm" variant="danger" loading={busy === 'cancel'} onClick={() => after(cancel(post.id).then(() => setConfirming(false)))}>
          Cancel post
        </Button>
      </>
    ) : (
      <>
        <Button size="sm" variant="ghost" icon={<CalendarClock className="h-3.5 w-3.5" />} onClick={startEditing} disabled={Boolean(busy) || editing !== null}>
          Reschedule
        </Button>
        <Button size="sm" variant="ghost" onClick={() => { setEditing(null); setConfirming(true) }} disabled={Boolean(busy)}>Cancel</Button>
      </>
    )
  } else if (post && (item.status === 'failed' || item.status === 'partial')) {
    actions = (
      <Button size="sm" icon={<RotateCcw className="h-3.5 w-3.5" />} loading={busy === 'retry'} disabled={Boolean(busy)} onClick={() => after(retry(post.id))}>
        Retry
      </Button>
    )
  }
  // Removing only hides a finished post from local history, so it's offered in the "Made here" list.
  const removable = post && !onChanged && item.status !== 'scheduled' && item.status !== 'publishing'

  return (
    <li className="py-2 pl-4 pr-2.5 transition-colors duration-150 hover:bg-white/[0.02]">
      <div className={cn('grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5', ROW_GRID)}>
        <div className="col-span-2 flex min-w-0 items-center gap-3 lg:col-span-1">
          <PostThumb clipPath={post?.clipPath ?? null} />
          <div className="min-w-0">
            {post ? (
              <button
                type="button"
                onClick={() => setShowDetails(true)}
                title="Show what was sent and how it went"
                className="block max-w-full truncate text-left text-sm font-medium text-ink hover:underline hover:decoration-white/30 hover:underline-offset-2"
              >
                {title}
              </button>
            ) : (
              <p className="truncate text-sm font-medium text-ink" title={item.content}>{title}</p>
            )}
            <p className={cn('truncate text-xs', confirming ? 'text-ink' : 'text-ink-subtle')}>
              {confirming ? 'Cancel this post? Zernio won’t publish it.' : post ? whenText(post) : 'Made in Zernio'}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1">
          {item.targets.map((target, index) => {
            const badge = targetBadge(target, item.status)
            const label = `${platformName(target.platform)}${target.handle ? ` ${target.handle}` : ''}: ${badge.label}`
            const icon = <PlatformIcon platform={target.platform} className="h-6 w-6 rounded-full [&_svg]:h-3 [&_svg]:w-3" />
            return target.url ? (
              <button
                key={`${target.platform}:${target.accountId}`}
                type="button"
                onClick={() => openTarget(index)}
                title={`${label}. Open on ${platformName(target.platform)}`}
                aria-label={`Open on ${platformName(target.platform)}, ${target.handle ?? 'account'}, ${badge.label}`}
                className="rounded-full transition-transform duration-150 hover:scale-110"
              >
                {icon}
              </button>
            ) : (
              <span key={`${target.platform}:${target.accountId}`} title={label} aria-label={label} className={cn('rounded-full', badge.tone === 'danger' && 'ring-1 ring-danger/70')}>
                {icon}
              </span>
            )
          })}
        </div>

        <p className="text-xs tabular text-ink">
          {when.date} <span className="text-ink-subtle">{when.time}</span>
        </p>

        <div><Badge tone={STATUS_TONES[item.status]}>{STATUS_LABELS[item.status]}</Badge></div>

        <p className="truncate text-xs text-ink-muted">{profile ?? '–'}</p>

        <div className="col-span-2 flex items-center justify-end gap-1 lg:col-span-1">
          {post && (
            <Button size="sm" variant="ghost" iconOnly aria-label={`Details of “${title}”`} title="Details" icon={<Info className="h-3.5 w-3.5" />} onClick={() => setShowDetails(true)} />
          )}
          {actions}
          {removable && (
            <Button size="sm" variant="ghost" iconOnly aria-label={`Remove “${title}” from the list`} title="Remove from list" disabled={Boolean(busy)} onClick={() => void dismiss(post.id)} icon={<X className="h-3.5 w-3.5" />} />
          )}
        </div>
      </div>

      {(failedTargets.length > 0 || (item.status === 'failed' && post?.error) || capacity || linkError) && (
        <div className="mt-1 pl-[52px]">
          {failedTargets.map((target) => (
            <p key={`${target.platform}:${target.accountId}`} className="text-xs text-danger" data-selectable>
              {platformName(target.platform)}: {target.error}
            </p>
          ))}
          {item.status === 'failed' && failedTargets.length === 0 && post?.error && (
            <p className="text-xs text-danger" data-selectable>{post.error}</p>
          )}
          {capacity && (
            <p className="text-xs text-ink-subtle">TikTok direct posting is busy. Retry in a few hours, or post the clip again with “Send to your TikTok inbox” on.</p>
          )}
          {linkError && <p className="text-xs text-danger">{linkError}</p>}
        </div>
      )}

      {editing !== null && (
        <div className="glass-tile ml-[52px] mt-2 rounded-2xl p-2 animate-fade-in">
          <div className="flex flex-wrap items-center gap-2">
            <CalendarClock aria-hidden className="h-4 w-4 text-ink-subtle" />
            <input
              type="datetime-local"
              value={editing}
              min={toLocalInput(scheduleWindow(now, uploadedAt).min)}
              max={toLocalInput(scheduleWindow(now, uploadedAt).max)}
              onChange={(e) => setEditing(e.target.value)}
              aria-label="New publish date and time"
              aria-invalid={Boolean(editingProblem)}
              className={cn('h-[30px] rounded-full px-3 font-mono text-xs tabular text-ink [color-scheme:dark] focus:outline-none', WELL)}
            />
            <Button size="sm" variant="primary" loading={busy === 'reschedule'} disabled={Boolean(editingProblem)} onClick={() => void saveSchedule()}>
              Save
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(null)} disabled={busy === 'reschedule'}>Cancel</Button>
          </div>
          {editingProblem && <p role="alert" className="mt-2 text-xs text-danger">{editingProblem}</p>}
        </div>
      )}

      {showDetails && post && <PostDetailsDialog post={post} when={whenText(post)} onClose={() => setShowDetails(false)} />}
    </li>
  )
}
