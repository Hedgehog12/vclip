import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { randomUUID } from 'crypto'
import { basename, dirname, extname, join } from 'path'
import { isZernioId } from '../../shared/zernio'
import { POST_DETAILS_CAPTION_MAX, POST_DETAILS_MAX_WARNINGS, type PostDetails, type PostRecord, type PostRecordTarget, type PostStatus, type PostTargetStatus } from '../../shared/zernio-posts'
import { quarantineUnbound, readableCache } from './workspace-cache'

// Local history of posts made from vClip, so the Accounts page can show
// scheduled and recent posts without listing the whole Zernio workspace.
// Holds ids, paths, titles and statuses: nothing secret.

const VERSION = 1
/** Oldest finished posts are dropped past this. Active posts are never discarded. */
const MAX_RECORDS = 300
const MAX_CACHE_BYTES = 2 * 1024 * 1024
const MAX_LEGACY_BYTES = 16 * 1024 * 1024

const STATUSES: PostStatus[] = ['draft', 'scheduled', 'publishing', 'published', 'partial', 'failed', 'cancelled', 'missing']
const TARGET_STATUSES: PostTargetStatus[] = ['pending', 'processing', 'uploading', 'published', 'failed', 'cancelled']

function text(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.length <= max ? value : null
}

function iso(value: unknown): string | null {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null
}

function parseTarget(value: unknown): PostRecordTarget | null {
  if (!value || typeof value !== 'object') return null
  const t = value as Record<string, unknown>
  if (typeof t.platform !== 'string' || !isZernioId(t.accountId) || !TARGET_STATUSES.includes(t.status as PostTargetStatus)) return null
  return {
    platform: t.platform.slice(0, 40),
    accountId: t.accountId,
    handle: text(t.handle, 200),
    status: t.status as PostTargetStatus,
    error: text(t.error, 1000),
    url: text(t.url, 2048),
    inbox: t.inbox === true
  }
}

function stringList(value: unknown, maxCount: number, maxLength: number): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.length <= maxLength).slice(0, maxCount) : []
}

function stringMap(value: unknown, maxLength: number): Record<string, string> {
  const result: Record<string, string> = {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result
  for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 20)) {
    if (isZernioId(key) && typeof item === 'string' && item.length <= maxLength) result[key] = item
  }
  return result
}

/** What was sent with a post. Anything malformed drops the details, never the post. */
export function parsePostDetails(value: unknown): PostDetails | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const d = value as Record<string, unknown>
  const caption = text(d.caption, POST_DETAILS_CAPTION_MAX)
  if (caption === null) return null
  const object = (field: unknown): Record<string, unknown> | null =>
    field && typeof field === 'object' && !Array.isArray(field) ? field as Record<string, unknown> : null
  const youtube = object(d.youtube)
  const instagram = object(d.instagram)
  const facebook = object(d.facebook)
  const threads = object(d.threads)
  const tiktok = object(d.tiktok)
  const youtubeTitle = youtube ? text(youtube.title, 500) : null
  const category = youtube && typeof youtube.categoryId === 'string' && /^\d{1,3}$/.test(youtube.categoryId) ? youtube.categoryId : null
  return {
    caption,
    thumbnailPath: text(d.thumbnailPath, 4096),
    accountCaptions: stringMap(d.accountCaptions, POST_DETAILS_CAPTION_MAX),
    youtube: youtube && youtubeTitle !== null ? {
      title: youtubeTitle, visibility: text(youtube.visibility, 20) ?? 'public', madeForKids: youtube.madeForKids === true,
      categoryId: category, tags: stringList(youtube.tags, 20, 100)
    } : null,
    instagram: instagram ? { shareToFeed: instagram.shareToFeed === true } : null,
    facebook: facebook ? { format: text(facebook.format, 20) ?? 'feed', title: text(facebook.title, 500) } : null,
    threads: threads ? { topicTag: text(threads.topicTag, 100) } : null,
    tiktok: tiktok ? { draft: tiktok.draft === true, madeWithAi: tiktok.madeWithAi === true, privacy: stringMap(tiktok.privacy, 64) } : null,
    warnings: stringList(d.warnings, POST_DETAILS_MAX_WARNINGS, 300)
  }
}

export function parsePostRecord(value: unknown): PostRecord | null {
  if (!value || typeof value !== 'object') return null
  const r = value as Record<string, unknown>
  const createdAt = iso(r.createdAt)
  const uploadedAt = iso(r.uploadedAt)
  if (!isZernioId(r.id) || typeof r.clipPath !== 'string' || !STATUSES.includes(r.status as PostStatus) || !createdAt || !uploadedAt) return null
  const targets = Array.isArray(r.targets) ? r.targets.map(parseTarget) : []
  if (targets.length === 0 || targets.some((t) => !t)) return null
  return {
    id: r.id,
    clipPath: r.clipPath.slice(0, 4096),
    clipTitle: text(r.clipTitle, 500) ?? '',
    targets: targets as PostRecordTarget[],
    scheduledFor: iso(r.scheduledFor),
    timezone: text(r.timezone, 64),
    status: r.status as PostStatus,
    error: text(r.error, 1000),
    createdAt,
    uploadedAt,
    refreshedAt: iso(r.refreshedAt),
    details: parsePostDetails(r.details)
  }
}

export class PostsStore {
  private readonly path: string
  private readonly reservations: PostRecord[] = []

  constructor(private readonly filePath: string, private readonly workspace: string | null = null) {
    if (workspace && !/^[A-Za-z0-9_-]+$/.test(workspace)) throw new Error('Invalid post workspace')
    const extension = extname(filePath)
    this.path = workspace ? join(dirname(filePath), `${basename(filePath, extension)}-${workspace}${extension}`) : filePath
  }

  private serialize(posts: PostRecord[]): string {
    const active = posts.filter((post) => post.status === 'scheduled' || post.status === 'publishing')
    const finished = posts.filter((post) => post.status !== 'scheduled' && post.status !== 'publishing')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    if (active.length > MAX_RECORDS) throw new Error('Post history is full of active posts. Finish or cancel a post before adding another.')
    const encode = (finishedCount: number): string => JSON.stringify({
      version: this.workspace ? 2 : VERSION,
      ...(this.workspace ? { workspace: this.workspace } : {}),
      posts: [...active, ...finished.slice(0, finishedCount)]
    }, null, 2)
    const limit = Math.min(finished.length, MAX_RECORDS - active.length)
    let low = 0
    let high = limit
    let result: string | null = null
    while (low <= high) {
      const middle = Math.floor((low + high) / 2)
      const payload = encode(middle)
      if (Buffer.byteLength(payload) <= MAX_CACHE_BYTES) {
        result = payload
        low = middle + 1
      } else high = middle - 1
    }
    if (result === null) throw new Error('Active post history exceeds the storage limit. Existing history was preserved.')
    return result
  }

  /** Move a bound legacy file only when it belongs to this workspace. */
  private migrateLegacy(): void {
    if (!this.workspace || existsSync(this.path) || !existsSync(this.filePath)) return
    if (!readableCache(this.filePath, MAX_LEGACY_BYTES)) throw new Error('Legacy post history could not be migrated. The file was preserved.')
    let raw: { version?: unknown; workspace?: unknown; posts?: unknown }
    try { raw = JSON.parse(readFileSync(this.filePath, 'utf-8')) }
    catch { quarantineUnbound(this.filePath); return }
    if (raw.version !== 2 || raw.workspace !== this.workspace) {
      if (raw.version !== 2 || typeof raw.workspace !== 'string') quarantineUnbound(this.filePath)
      return
    }
    const records = Array.isArray(raw.posts) ? raw.posts.map(parsePostRecord).filter((post): post is PostRecord => post !== null) : []
    this.write(records)
    try { renameSync(this.filePath, `${this.filePath}.migrated-${Date.now()}`) }
    catch { /* The scoped copy is already durable; leave the old file for recovery. */ }
  }

  /** Newest first. A damaged file is set aside so the next write can't erase it. */
  list(): PostRecord[] {
    this.migrateLegacy()
    if (!existsSync(this.path)) return []
    try {
      if (!readableCache(this.path, MAX_CACHE_BYTES)) { quarantineUnbound(this.path); return [] }
      const raw = JSON.parse(readFileSync(this.path, 'utf-8')) as { version?: unknown; workspace?: unknown; posts?: unknown }
      if (this.workspace && (raw.version !== 2 || raw.workspace !== this.workspace)) {
        quarantineUnbound(this.path)
        return []
      }
      const posts = Array.isArray(raw.posts) ? raw.posts.map(parsePostRecord).filter((p): p is PostRecord => p !== null) : []
      return posts.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    } catch {
      try { renameSync(this.path, `${this.path}.damaged-${Date.now()}`) } catch { /* Keep going with an empty history. */ }
      return []
    }
  }

  get(id: string): PostRecord | null {
    return this.list().find((post) => post.id === id) ?? null
  }

  /** Reserve enough room for the largest accepted provider response before creating a remote post. */
  reserveActive(base: PostRecord): () => void {
    const worst: PostRecord = {
      ...base,
      id: 'x'.repeat(64),
      scheduledFor: '2026-09-25T10:00:00.000Z',
      timezone: 'x'.repeat(64),
      status: 'publishing',
      // JSON can escape one UTF-16 code unit as six bytes. Reserve that
      // upper bound for provider strings rather than their character count.
      error: '\0'.repeat(300),
      targets: base.targets.map((target) => ({
        ...target,
        error: '\0'.repeat(300),
        url: '\0'.repeat(2048)
      })),
      // Zernio's notices are saved into the details once the post exists.
      details: base.details ? { ...base.details, warnings: Array.from({ length: POST_DETAILS_MAX_WARNINGS }, () => '\0'.repeat(300)) } : base.details
    }
    this.serialize([...this.list(), ...this.reservations, worst])
    this.reservations.push(worst)
    return () => {
      const index = this.reservations.indexOf(worst)
      if (index !== -1) this.reservations.splice(index, 1)
    }
  }

  private write(posts: PostRecord[]): void {
    const payload = this.serialize(posts)
    const tempPath = `${this.path}.${randomUUID()}.tmp`
    try {
      writeFileSync(tempPath, payload, { encoding: 'utf-8', mode: 0o600, flag: 'wx' })
      renameSync(tempPath, this.path)
    } finally { rmSync(tempPath, { force: true }) }
  }

  /** Insert or replace records by id. */
  save(...records: PostRecord[]): PostRecord[] {
    const byId = new Map(this.list().map((post) => [post.id, post]))
    for (const record of records) byId.set(record.id, record)
    this.write([...byId.values()])
    return this.list()
  }

  remove(id: string): PostRecord[] {
    this.write(this.list().filter((post) => post.id !== id))
    return this.list()
  }

  clear(): void {
    this.write([])
  }
}
