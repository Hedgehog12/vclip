import { app } from 'electron'
import { randomUUID } from 'crypto'
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { isAbsolute, join } from 'path'
import { loadSettings } from '../settings-store'
import { isZernioId } from '../../shared/zernio'
import {
  EMPTY_TIKTOK_ACCOUNT,
  MAX_POST_DRAFTS,
  type DraftTimingMode,
  type FacebookFormat,
  type PostDraft,
  type PostDraftEntry,
  type TikTokAccountOptions,
  type YouTubeVisibility
} from '../../shared/zernio-posts'
import { readableCache, workspaceId } from './workspace-cache'

// Posts being prepared, kept on this computer only. Nothing is uploaded until
// the draft is posted: Zernio deletes unpublished uploads after 7 days.
// One file per Zernio workspace, since drafts name that workspace's accounts.

const MAX_FILE_BYTES = 8 * 1024 * 1024
const MAX_CAPTION = 63_206
const DRAFT_ID = /^[A-Za-z0-9-]{8,64}$/

type JsonRecord = Record<string, unknown>

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : null
}

function text(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.length <= max ? value : null
}

function iso(value: unknown): string | null {
  return typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null
}

function bool(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback
}

const VISIBILITIES: YouTubeVisibility[] = ['public', 'unlisted', 'private']
const TIMING_MODES: DraftTimingMode[] = ['now', 'schedule', 'queue']

function tiktokAccount(value: unknown): TikTokAccountOptions {
  const o = record(value) ?? {}
  const privacyLevel = typeof o.privacyLevel === 'string' && /^[A-Z_]{0,64}$/.test(o.privacyLevel) ? o.privacyLevel : ''
  return { ...EMPTY_TIKTOK_ACCOUNT, privacyLevel, allowComment: bool(o.allowComment), allowDuet: bool(o.allowDuet), allowStitch: bool(o.allowStitch) }
}

/**
 * The draft fields, checked one by one; anything malformed is reset to its
 * default rather than dropping the whole draft. Null when the clip or text is unusable.
 */
export function parseDraftFields(value: unknown): Omit<PostDraft, 'id' | 'createdAt' | 'updatedAt'> | null {
  const d = record(value)
  if (!d) return null
  const clipPath = text(d.clipPath, 4096)
  const caption = text(d.caption, MAX_CAPTION)
  if (!clipPath || !isAbsolute(clipPath) || caption === null) return null
  const youtube = record(d.youtube) ?? {}
  const tiktok = record(d.tiktok) ?? {}
  const timing = record(d.timing) ?? {}
  const tiktokAccounts = record(tiktok.accounts) ?? {}
  const accountIds = Array.isArray(d.accountIds) ? [...new Set(d.accountIds.filter(isZernioId))].slice(0, 50) : []
  const durationMs = typeof d.durationMs === 'number' && Number.isFinite(d.durationMs) && d.durationMs >= 0 ? d.durationMs : null
  const categoryId = typeof youtube.categoryId === 'string' && /^\d{1,3}$/.test(youtube.categoryId) ? youtube.categoryId : null
  return {
    clipPath,
    clipTitle: text(d.clipTitle, 500) ?? '',
    durationMs,
    caption,
    accountIds,
    useThumbnail: bool(d.useThumbnail, true),
    youtube: {
      title: text(youtube.title, 500) ?? '',
      visibility: VISIBILITIES.includes(youtube.visibility as YouTubeVisibility) ? (youtube.visibility as YouTubeVisibility) : 'public',
      madeForKids: bool(youtube.madeForKids),
      categoryId,
      tags: text(youtube.tags, 2000) ?? ''
    },
    shareToFeed: bool(d.shareToFeed, true),
    facebookFormat: d.facebookFormat === 'reel' || d.facebookFormat === 'feed' ? (d.facebookFormat as FacebookFormat) : null,
    tiktok: {
      accounts: Object.fromEntries(Object.entries(tiktokAccounts).filter(([id]) => isZernioId(id)).slice(0, 50).map(([id, value]) => [id, tiktokAccount(value)])),
      disclose: bool(tiktok.disclose),
      yourBrand: bool(tiktok.yourBrand),
      brandedContent: bool(tiktok.brandedContent),
      madeWithAi: bool(tiktok.madeWithAi),
      draft: bool(tiktok.draft),
      // TikTok's consent covers one post as it goes out; it is never stored.
      consent: false
    },
    timing: {
      mode: TIMING_MODES.includes(timing.mode as DraftTimingMode) ? (timing.mode as DraftTimingMode) : 'now',
      scheduledFor: iso(timing.scheduledFor)
    }
  }
}

export function parseDraft(value: unknown): PostDraft | null {
  const d = record(value)
  const fields = parseDraftFields(value)
  const createdAt = iso(d?.createdAt)
  const updatedAt = iso(d?.updatedAt)
  if (!d || !fields || typeof d.id !== 'string' || !DRAFT_ID.test(d.id) || !createdAt || !updatedAt) return null
  return { id: d.id, ...fields, createdAt, updatedAt }
}

function workspace(): string {
  const key = loadSettings().zernioApiKey
  if (!key) throw new Error('Add your Zernio API key on the Accounts page first.')
  return workspaceId(key)
}

function draftsPath(id: string): string {
  return join(app.getPath('userData'), `post-drafts-${id}.json`)
}

function read(id: string): PostDraft[] {
  const path = draftsPath(id)
  if (!existsSync(path)) return []
  try {
    if (!readableCache(path, MAX_FILE_BYTES)) throw new Error('too large')
    const raw = record(JSON.parse(readFileSync(path, 'utf-8')))
    if (!raw || raw.workspace !== id || !Array.isArray(raw.drafts)) throw new Error('unexpected shape')
    return raw.drafts.map(parseDraft).filter((draft): draft is PostDraft => draft !== null)
  } catch {
    // Set a damaged file aside so the next save can't erase what is in it.
    try { renameSync(path, `${path}.damaged-${Date.now()}`) } catch { /* Start empty. */ }
    return []
  }
}

function write(id: string, drafts: PostDraft[]): void {
  const path = draftsPath(id)
  const payload = JSON.stringify({ version: 1, workspace: id, drafts }, null, 2)
  if (Buffer.byteLength(payload) > MAX_FILE_BYTES) throw new Error('Your drafts take too much space. Delete a few, then save again.')
  const tempPath = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(tempPath, payload, { encoding: 'utf-8', mode: 0o600, flag: 'wx' })
    renameSync(tempPath, path)
  } finally { rmSync(tempPath, { force: true }) }
}

/** Newest first, each with whether its clip file is still there. */
export function listDrafts(): PostDraftEntry[] {
  return read(workspace())
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map((draft) => ({ ...draft, clipMissing: !existsSync(draft.clipPath) }))
}

/** Creates the draft when `id` is null, otherwise replaces it. Returns the saved draft. */
export function saveDraft(raw: unknown): PostDraft {
  const id = workspace()
  const input = record(raw)
  const fields = parseDraftFields(raw)
  if (!input || !fields) throw new Error('This draft can’t be saved: its clip or caption is missing.')
  const drafts = read(id)
  const now = new Date().toISOString()
  const existing = typeof input.id === 'string' ? drafts.find((draft) => draft.id === input.id) : undefined
  if (input.id != null && !existing) throw new Error('This draft was deleted. Save it again as a new draft.')
  if (!existing && drafts.length >= MAX_POST_DRAFTS) throw new Error(`You have ${MAX_POST_DRAFTS} drafts. Delete some before saving another.`)
  const draft: PostDraft = { id: existing?.id ?? randomUUID(), ...fields, createdAt: existing?.createdAt ?? now, updatedAt: now }
  write(id, existing ? drafts.map((d) => (d.id === draft.id ? draft : d)) : [...drafts, draft])
  return draft
}

export function deleteDraft(draftId: unknown): PostDraftEntry[] {
  if (typeof draftId !== 'string' || !DRAFT_ID.test(draftId)) throw new Error('Unknown draft')
  const id = workspace()
  write(id, read(id).filter((draft) => draft.id !== draftId))
  return listDrafts()
}
