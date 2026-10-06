// Pure helpers for posting: request validation, the POST /v1/posts body, and
// turning Zernio's post objects into local history records. No Electron or
// network here, so tests can exercise every branch directly.

import { cleanHandle, sanitizeProviderText } from './client'
import { isZernioId, isZernioPlatform, type ZernioPlatform } from '../../shared/zernio'
import {
  EMPTY_TIKTOK_ACCOUNT,
  YOUTUBE_TITLE_MAX,
  PLATFORM_RULES,
  captionLength,
  isValidTimeZone,
  type FacebookFormat,
  type PostClipRequest,
  type PostOptions,
  type PostRecord,
  type PostRecordTarget,
  type PostStatus,
  type PostTargetStatus,
  type PostTiming,
  type TikTokAccountOptions,
  type TikTokCreatorInfo,
  type TikTokPostOptions, POST_DETAILS_CAPTION_MAX, POST_DETAILS_MAX_WARNINGS, type PostDetails,
  POSTS_SORTS, REMOTE_POST_STATUSES, type PostListItem, type RemotePostsQuery
} from '../../shared/zernio-posts'

export { tiktokOptionsError } from '../../shared/zernio-posts'

type JsonRecord = Record<string, unknown>

function asRecord(value: unknown): JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : {}
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function invalid(what: string): never {
  throw new Error(`Invalid post request: ${what}`)
}

// ---- Request validation -----------------------------------------------------

const MAX_CAPTION = 63_206
const MAX_TARGETS = 20

function parseTiming(value: unknown): PostTiming {
  const timing = asRecord(value)
  if (timing.mode === 'now') return { mode: 'now' }
  if (timing.mode === 'queue') return isZernioId(timing.profileId) ? { mode: 'queue', profileId: timing.profileId } : invalid('queue profile')
  if (timing.mode !== 'schedule') invalid('timing')
  const scheduledFor = str(timing.scheduledFor)
  if (!scheduledFor || scheduledFor.length > 40 || !Number.isFinite(Date.parse(scheduledFor))) invalid('scheduled time')
  if (!isValidTimeZone(timing.timezone)) invalid('time zone')
  return { mode: 'schedule', scheduledFor: new Date(scheduledFor).toISOString(), timezone: timing.timezone }
}

function parseTikTokAccount(value: unknown): TikTokAccountOptions {
  const o = asRecord(value)
  const privacyLevel = typeof o.privacyLevel === 'string' ? o.privacyLevel : ''
  if (privacyLevel && !/^[A-Z_]{1,64}$/.test(privacyLevel)) invalid('TikTok privacy level')
  return {
    privacyLevel,
    allowComment: bool(o.allowComment, false),
    allowDuet: bool(o.allowDuet, false),
    allowStitch: bool(o.allowStitch, false)
  }
}

/** Only the TikTok accounts being posted to; each gets its own choices. */
export function parseTikTokOptions(value: unknown, accountIds: string[]): TikTokPostOptions {
  const o = asRecord(value)
  const accounts = asRecord(o.accounts)
  return {
    accounts: Object.fromEntries(accountIds.map((id) => [id, parseTikTokAccount(accounts[id])])),
    disclose: bool(o.disclose, false),
    yourBrand: bool(o.yourBrand, false),
    brandedContent: bool(o.brandedContent, false),
    madeWithAi: bool(o.madeWithAi, false),
    draft: bool(o.draft, false),
    consent: o.consent === true
  }
}

function parseOptions(value: unknown, targets: PostClipRequest['targets']): PostOptions {
  const o = asRecord(value)
  const options: PostOptions = {}
  const platforms = new Set(targets.map((t) => t.platform))
  if (platforms.has('tiktok')) options.tiktok = parseTikTokOptions(o.tiktok, targets.filter((t) => t.platform === 'tiktok').map((t) => t.accountId))
  if (platforms.has('youtube')) {
    const yt = asRecord(o.youtube)
    const title = typeof yt.title === 'string' ? yt.title.replace(/\s+/g, ' ').trim() : ''
    if (!title) invalid('YouTube title')
    if ([...title].length > YOUTUBE_TITLE_MAX) throw new Error(`YouTube titles can be at most ${YOUTUBE_TITLE_MAX} characters.`)
    if (/[<>]/.test(title)) throw new Error('YouTube titles can’t contain < or >.')
    const visibility = yt.visibility === 'unlisted' || yt.visibility === 'private' ? yt.visibility : 'public'
    const categoryId = yt.categoryId === undefined ? undefined : typeof yt.categoryId === 'string' && /^\d{1,3}$/.test(yt.categoryId) ? yt.categoryId : invalid('YouTube category')
    const tags = yt.tags === undefined ? undefined : Array.isArray(yt.tags) && yt.tags.length <= 20 &&
      yt.tags.every((tag) => typeof tag === 'string' && tag.trim().length > 0 && [...tag].length <= 100 && !/[<>]/.test(tag)) &&
      yt.tags.join(',').length <= 500 ? yt.tags.map((tag: string) => tag.trim()) : invalid('YouTube tags')
    options.youtube = { title, visibility, madeForKids: yt.madeForKids === true, ...(categoryId ? { categoryId } : {}), ...(tags ? { tags } : {}) }
  }
  if (platforms.has('instagram')) options.instagram = { shareToFeed: bool(asRecord(o.instagram).shareToFeed, true) }
  if (platforms.has('facebook')) {
    const facebook = asRecord(o.facebook)
    const format = facebook.format === 'reel' ? 'reel' : 'feed'
    const title = facebook.title
    if (title !== undefined && (format !== 'reel' || typeof title !== 'string' || !title.trim() || [...title.trim()].length > 80 || /[<>\r\n]/.test(title))) invalid('Facebook Reel title')
    options.facebook = { format, ...(typeof title === 'string' ? { title: title.trim() } : {}) }
  }
  if (platforms.has('threads')) {
    const topicTag = asRecord(o.threads).topicTag
    if (topicTag !== undefined && (typeof topicTag !== 'string' || !topicTag.trim() || [...topicTag.trim()].length > 50 || /[.#&\r\n]/.test(topicTag))) invalid('Threads topic tag')
    options.threads = typeof topicTag === 'string' ? { topicTag: topicTag.trim() } : {}
  }
  return options
}

/** Validates an IPC request from the renderer; throws with a readable reason. */
export function parsePostClipRequest(value: unknown): PostClipRequest {
  const request = asRecord(value)
  const attemptId = request.attemptId
  if (typeof attemptId !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(attemptId)) invalid('attempt')
  if (typeof request.clipPath !== 'string' || !request.clipPath || request.clipPath.includes('\0')) invalid('clip')
  const clipTitle = typeof request.clipTitle === 'string' ? request.clipTitle.slice(0, 500) : ''
  const durationMs = typeof request.durationMs === 'number' && Number.isFinite(request.durationMs) && request.durationMs >= 0 ? request.durationMs : null
  if (typeof request.caption !== 'string' || request.caption.includes('\0') || captionLength(request.caption) > MAX_CAPTION) invalid('caption')
  const thumbnailPath = request.thumbnailPath ?? null
  if (thumbnailPath !== null && (typeof thumbnailPath !== 'string' || thumbnailPath.includes('\0') || !/\.thumbnail\.(png|jpg|webp)$/i.test(thumbnailPath))) invalid('thumbnail')

  if (!Array.isArray(request.targets) || request.targets.length === 0) throw new Error('Choose at least one account to post to.')
  if (request.targets.length > MAX_TARGETS) invalid('too many accounts')
  const seen = new Set<string>()
  const targets = request.targets.map((item) => {
    const target = asRecord(item)
    if (!isZernioPlatform(target.platform) || !isZernioId(target.accountId)) invalid('account')
    const key = `${target.platform}:${target.accountId}`
    if (seen.has(key)) invalid('duplicate account')
    seen.add(key)
    const customContent = target.customContent
    if (customContent !== undefined && (typeof customContent !== 'string' || !customContent.trim() || customContent.includes('\0') ||
        captionLength(customContent) > MAX_CAPTION ||
        (PLATFORM_RULES[target.platform].captionStrict && captionLength(customContent) > PLATFORM_RULES[target.platform].captionMax) ||
        (target.platform === 'youtube' && Buffer.byteLength(customContent, 'utf8') > 5000))) invalid('platform caption')
    return { platform: target.platform, accountId: target.accountId, ...(customContent === undefined ? {} : { customContent }) }
  })

  return {
    attemptId,
    clipPath: request.clipPath,
    clipTitle,
    durationMs,
    caption: request.caption,
    thumbnailPath,
    targets,
    timing: parseTiming(request.timing),
    options: parseOptions(request.options, targets)
  }
}

// ---- TikTok -----------------------------------------------------------------

/**
 * Zernio's creator-info response. Also reads TikTok's raw field names in
 * case Zernio passes them through (privacy_level_options, *_disabled).
 */
export function parseTikTokCreatorInfo(accountId: string, value: unknown): TikTokCreatorInfo {
  const body = asRecord(value)
  const creator = asRecord(body.creator)
  const limits = asRecord(body.postingLimits)
  const interactions = asRecord(limits.interactionSettings)

  const levels = Array.isArray(body.privacyLevels) ? body.privacyLevels : Array.isArray(body.privacy_level_options) ? body.privacy_level_options : []
  const privacyLevels = levels
    .map((item) => (typeof item === 'string' ? { value: item, label: item } : { value: str(asRecord(item).value) ?? '', label: str(asRecord(item).label) ?? '' }))
    .filter((level) => /^[A-Z_]{1,64}$/.test(level.value))
    .map((level) => ({ value: level.value, label: level.label || level.value }))

  const enabled = (key: 'comment' | 'duet' | 'stitch'): boolean => {
    const descriptor = interactions[`allow_${key}`]
    if (descriptor === null) return false
    if (descriptor !== undefined) return asRecord(descriptor).enabled !== false
    return body[`${key}_disabled`] !== true
  }

  const maxSec = Number(limits.maxVideoDurationSec ?? body.max_video_post_duration_sec)
  const commercial = Array.isArray(body.commercialContentTypes) ? body.commercialContentTypes : []

  return {
    accountId,
    nickname: str(creator.nickname) ?? str(body.creator_nickname) ?? null,
    canPostMore: creator.canPostMore !== false,
    privacyLevels,
    maxVideoDurationSec: Number.isFinite(maxSec) && maxSec > 0 ? maxSec : null,
    interactions: { comment: enabled('comment'), duet: enabled('duet'), stitch: enabled('stitch') },
    commercialContentTypes: commercial.map((item) => str(asRecord(item).value) ?? str(item)).filter((v): v is string => Boolean(v))
  }
}

/** Choices one TikTok account gets, in its own entry (entry keys win over the root object). */
function tiktokAccountSettings(account: TikTokAccountOptions, interactions: TikTokCreatorInfo['interactions']): JsonRecord {
  return {
    privacy_level: account.privacyLevel,
    // A toggle the creator disabled in the TikTok app must be sent as off.
    allow_comment: account.allowComment && interactions.comment,
    allow_duet: account.allowDuet && interactions.duet,
    allow_stitch: account.allowStitch && interactions.stitch
  }
}

/** Choices shared by every TikTok account in the post. */
function tiktokSharedSettings(options: TikTokPostOptions): JsonRecord {
  const settings: JsonRecord = {
    // Only reached after the user ticked TikTok's consent declaration.
    content_preview_confirmed: options.consent,
    express_consent_given: options.consent,
    video_made_with_ai: options.madeWithAi
  }
  if (options.draft) settings.draft = true
  if (options.disclose && options.brandedContent) {
    settings.commercialContentType = 'brand_content'
    if (options.yourBrand) settings.isBrandOrganicPost = true
  } else if (options.disclose && options.yourBrand) {
    settings.commercialContentType = 'brand_organic'
  }
  return settings
}

// ---- POST /v1/posts body ----------------------------------------------------

export interface PostBodyContext {
  publicUrl: string
  /** The uploaded thumbnail (JPEG): the Instagram Reel cover and YouTube thumbnail. */
  thumbnailUrl?: string | null
  /** Each TikTok account's allowed interactions, from its creator info. Missing means all off. */
  tiktokInteractions?: Record<string, TikTokCreatorInfo['interactions']>
  facebookFormat?: FacebookFormat
}

const NO_INTERACTIONS: TikTokCreatorInfo['interactions'] = { comment: false, duet: false, stitch: false }

export function buildCreatePostBody(request: PostClipRequest, context: PostBodyContext): JsonRecord {
  const { options } = request
  const platforms = request.targets.map((target) => {
    const data: JsonRecord = {}
    if (target.platform === 'youtube' && options.youtube) {
      data.title = options.youtube.title
      data.visibility = options.youtube.visibility
      // YouTube may hold back views when the audience isn't declared, so always send it.
      data.madeForKids = options.youtube.madeForKids
      if (options.youtube.categoryId) data.categoryId = options.youtube.categoryId
    }
    if (target.platform === 'instagram' && options.instagram) data.shareToFeed = options.instagram.shareToFeed
    if (target.platform === 'instagram' && context.thumbnailUrl) data.instagramThumbnail = context.thumbnailUrl
    if (target.platform === 'facebook' && (context.facebookFormat ?? options.facebook?.format) === 'reel') {
      data.contentType = 'reel'
      if (options.facebook?.title) data.title = options.facebook.title
    }
    if (target.platform === 'threads' && options.threads?.topicTag) data.topic_tag = options.threads.topicTag
    if (target.platform === 'tiktok' && options.tiktok) {
      // The whole settings object per entry, so each account keeps its own
      // privacy level and toggles whatever Zernio's root/entry merge does.
      data.tiktokSettings = {
        ...tiktokSharedSettings(options.tiktok),
        ...tiktokAccountSettings(options.tiktok.accounts[target.accountId] ?? EMPTY_TIKTOK_ACCOUNT, context.tiktokInteractions?.[target.accountId] ?? NO_INTERACTIONS)
      }
    }
    return { platform: target.platform, accountId: target.accountId, ...(target.customContent ? { customContent: target.customContent } : {}), ...(Object.keys(data).length > 0 ? { platformSpecificData: data } : {}) }
  })

  const body: JsonRecord = {
    content: request.caption,
    // YouTube reads a custom thumbnail from the video item. YouTube accepts Shorts
    // thumbnails since July 2026; Zernio skips them silently until it supports them.
    mediaItems: [{ type: 'video', url: context.publicUrl,
      ...(context.thumbnailUrl && request.targets.some((t) => t.platform === 'youtube') ? { thumbnail: context.thumbnailUrl } : {}) }],
    platforms,
    metadata: { source: 'vclip' }
  }
  if (options.youtube?.tags?.length) body.tags = options.youtube.tags
  if (request.timing.mode === 'now') {
    body.publishNow = true
  } else if (request.timing.mode === 'queue') {
    // Zernio picks the slot itself; copying next-slot into scheduledFor would bypass its queue locking.
    body.queuedFromProfile = request.timing.profileId
  } else {
    body.scheduledFor = request.timing.scheduledFor
    body.timezone = request.timing.timezone
  }
  // TikTok documents a root-level tiktokSettings on every TikTok post; it
  // carries the shared choices, and each entry adds its account's own.
  if (options.tiktok && request.targets.some((t) => t.platform === 'tiktok')) {
    body.tiktokSettings = tiktokSharedSettings(options.tiktok)
  }
  return body
}

// ---- Zernio post → local record ---------------------------------------------

const POST_STATUSES: PostStatus[] = ['draft', 'scheduled', 'publishing', 'published', 'partial', 'failed', 'cancelled']
const TARGET_STATUSES: PostTargetStatus[] = ['pending', 'processing', 'uploading', 'published', 'failed', 'cancelled']

/** Hosts a published post's link may point at, per platform. */
const POST_URL_HOSTS: Record<ZernioPlatform, readonly string[]> = {
  tiktok: ['tiktok.com'],
  youtube: ['youtube.com', 'youtu.be'],
  instagram: ['instagram.com'],
  facebook: ['facebook.com', 'fb.watch', 'fb.com'],
  twitter: ['x.com', 'twitter.com'],
  linkedin: ['linkedin.com'],
  threads: ['threads.net', 'threads.com']
}

/** True for an https link on the platform's own site; the only links vClip opens. */
export function isPostUrl(value: unknown, platform: string): value is string {
  if (typeof value !== 'string' || value.length > 2048 || !isZernioPlatform(platform)) return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password && (url.port === '' || url.port === '443') &&
      POST_URL_HOSTS[platform].some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`))
  } catch {
    return false
  }
}

/**
 * What a post sends, for the Posts page. `thumbnailSent` says whether the
 * thumbnail was really uploaded (only Instagram and YouTube take one).
 */
export function postDetailsFrom(request: PostClipRequest, thumbnailSent: boolean, warnings: readonly string[] = []): PostDetails {
  const { options } = request
  const platforms = new Set(request.targets.map((target) => target.platform))
  const cap = (value: string): string => (value.length > POST_DETAILS_CAPTION_MAX ? `${value.slice(0, POST_DETAILS_CAPTION_MAX - 1)}…` : value)
  const accountCaptions: Record<string, string> = {}
  for (const target of request.targets) {
    if (target.customContent && target.customContent !== request.caption) accountCaptions[target.accountId] = cap(target.customContent)
  }
  const youtube = platforms.has('youtube') ? options.youtube : undefined
  const tiktok = platforms.has('tiktok') ? options.tiktok : undefined
  return {
    caption: cap(request.caption),
    thumbnailPath: thumbnailSent && request.thumbnailPath ? request.thumbnailPath : null,
    accountCaptions,
    youtube: youtube ? {
      title: youtube.title, visibility: youtube.visibility, madeForKids: youtube.madeForKids,
      categoryId: youtube.categoryId ?? null, tags: [...(youtube.tags ?? [])]
    } : null,
    instagram: platforms.has('instagram') && options.instagram ? { shareToFeed: options.instagram.shareToFeed } : null,
    facebook: platforms.has('facebook') && options.facebook ? { format: options.facebook.format, title: options.facebook.title ?? null } : null,
    threads: platforms.has('threads') && options.threads ? { topicTag: options.threads.topicTag ?? null } : null,
    tiktok: tiktok ? {
      draft: tiktok.draft === true, madeWithAi: tiktok.madeWithAi === true,
      privacy: Object.fromEntries(Object.entries(tiktok.accounts).map(([id, account]) => [id, account.privacyLevel]))
    } : null,
    warnings: warnings.filter((w) => typeof w === 'string' && w.trim()).slice(0, POST_DETAILS_MAX_WARNINGS).map((w) => w.slice(0, 300))
  }
}

/**
 * The YouTube Studio edit page of a posted video, from its public link
 * (youtube.com/shorts/ID, watch?v=ID or youtu.be/ID). Null for anything else.
 */
export function youtubeStudioUrl(postUrl: unknown): string | null {
  if (!isPostUrl(postUrl, 'youtube')) return null
  const url = new URL(postUrl)
  const id = url.hostname.endsWith('youtu.be') ? url.pathname.slice(1)
    : url.pathname.startsWith('/shorts/') ? url.pathname.slice('/shorts/'.length)
      : url.searchParams.get('v') ?? ''
  return /^[A-Za-z0-9_-]{11}$/.test(id) ? `https://studio.youtube.com/video/${id}/edit` : null
}

function accountIdOf(value: unknown): string | undefined {
  return str(value) ?? str(asRecord(value)._id) ?? str(asRecord(value).id)
}

function mergeTarget(target: PostRecordTarget, entry: JsonRecord | undefined, result: JsonRecord | undefined): PostRecordTarget {
  if (!entry && !result) return target
  const rawStatus = str(entry?.status) ?? str(result?.status)
  const status = TARGET_STATUSES.includes(rawStatus as PostTargetStatus) ? (rawStatus as PostTargetStatus) : target.status
  const url = entry?.platformPostUrl
  return {
    ...target,
    status,
    error: status === 'failed' ? sanitizeProviderText(entry?.errorMessage, 300) ?? sanitizeProviderText(result?.error, 300) ?? target.error ?? 'Publishing failed.' : null,
    url: isPostUrl(url, target.platform) ? url : target.url,
    inbox: target.inbox || asRecord(entry?.platformSpecificData).isDraft === true
  }
}

/**
 * Apply Zernio's view of a post (create, get, update or retry response) to a
 * local record. Fields Zernio leaves out keep their previous values.
 */
export function applyZernioPost(record: PostRecord, post: JsonRecord, extras: { platformResults?: JsonRecord[]; error?: string | null; now?: string } = {}): PostRecord {
  const entries = Array.isArray(post.platforms) ? post.platforms.map(asRecord) : []
  const results = extras.platformResults ?? []
  const rawStatus = str(post.status)
  const status = POST_STATUSES.includes(rawStatus as PostStatus) ? (rawStatus as PostStatus) : record.status
  const scheduledFor = str(post.scheduledFor)
  const timezone = str(post.timezone)

  const targets = record.targets.map((target) => {
    const samePlatform = record.targets.filter((t) => t.platform === target.platform).length
    const entry = entries.find((e) => accountIdOf(e.accountId) === target.accountId && (!str(e.platform) || e.platform === target.platform)) ??
      // Zernio can omit accountId from post.platforms. With two accounts on
      // the same platform, a platform-only row cannot identify either one.
      (samePlatform === 1 ? entries.find((e) => !accountIdOf(e.accountId) && e.platform === target.platform) : undefined)
    const result = results.find((r) => accountIdOf(r.accountId) === target.accountId && (!str(r.platform) || r.platform === target.platform)) ??
      (samePlatform === 1 ? results.find((r) => !accountIdOf(r.accountId) && r.platform === target.platform) : undefined)
    return mergeTarget(target, entry, result)
  })

  return {
    ...record,
    id: str(post._id) ?? str(post.id) ?? record.id,
    status,
    scheduledFor: scheduledFor && Number.isFinite(Date.parse(scheduledFor)) ? new Date(scheduledFor).toISOString() : record.scheduledFor,
    timezone: timezone && isValidTimeZone(timezone) ? timezone : record.timezone,
    targets,
    error: extras.error !== undefined ? extras.error : status === 'failed' || status === 'partial' ? record.error : null,
    refreshedAt: extras.now ?? record.refreshedAt
  }
}

// ---- Zernio's posts list ----------------------------------------------------

export const REMOTE_POSTS_PAGE_MAX = 100
const LISTED_CONTENT_MAX = 5000

function isoOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null
}

/** The renderer's list query, checked field by field before it reaches Zernio. */
export function parseRemotePostsQuery(value: unknown): RemotePostsQuery {
  const q = asRecord(value)
  const sort = POSTS_SORTS.find((s) => s === q.sort)
  if (!sort) invalid('sort')
  const status = q.status == null ? null : REMOTE_POST_STATUSES.find((s) => s === q.status) ?? invalid('status')
  const platform = q.platform == null ? null : isZernioPlatform(q.platform) ? q.platform : invalid('platform')
  const profileId = q.profileId == null ? null : isZernioId(q.profileId) ? q.profileId : invalid('profile')
  const fromDate = q.fromDate == null ? null : isoOrNull(q.fromDate) ?? invalid('from date')
  const toDate = q.toDate == null ? null : isoOrNull(q.toDate) ?? invalid('to date')
  const search = typeof q.search === 'string' && q.search.length <= 200 ? q.search.trim() : invalid('search')
  const page = Number.isInteger(q.page) && (q.page as number) >= 1 && (q.page as number) <= 1000 ? (q.page as number) : invalid('page')
  const limit = Number.isInteger(q.limit) && (q.limit as number) >= 1 && (q.limit as number) <= REMOTE_POSTS_PAGE_MAX ? (q.limit as number) : invalid('page size')
  return { sort, status, platform, profileId, fromDate, toDate, search, page, limit }
}

/** Query string for GET /v1/posts. */
export function remotePostsParams(query: RemotePostsQuery): URLSearchParams {
  const params = new URLSearchParams({ source: 'zernio', page: String(query.page), limit: String(query.limit), sortBy: query.sort })
  if (query.status) params.set('status', query.status)
  if (query.platform) params.set('platform', query.platform)
  if (query.profileId) params.set('profileId', query.profileId)
  if (query.fromDate) params.set('fromDate', query.fromDate)
  if (query.toDate) params.set('toDate', query.toDate)
  if (query.search) params.set('search', query.search)
  return params
}

function listedTarget(entry: JsonRecord): PostRecordTarget | null {
  const platform = str(entry.platform)
  const account = asRecord(entry.accountId)
  const accountId = accountIdOf(entry.accountId)
  if (!platform || !isZernioPlatform(platform) || !isZernioId(accountId)) return null
  const rawStatus = str(entry.status)
  const status = TARGET_STATUSES.includes(rawStatus as PostTargetStatus) ? (rawStatus as PostTargetStatus) : 'pending'
  const username = cleanHandle(account.username)
  return {
    platform,
    accountId,
    handle: username ? (username.startsWith('@') ? username : `@${username}`) : cleanHandle(account.displayName),
    status,
    error: status === 'failed' ? sanitizeProviderText(entry.errorMessage, 300) ?? 'Publishing failed.' : null,
    url: isPostUrl(entry.platformPostUrl, platform) ? entry.platformPostUrl : null,
    inbox: asRecord(entry.platformSpecificData).isDraft === true
  }
}

/**
 * One post from GET /v1/posts as a list row. A post vClip made keeps
 * its local record (clip file, what was sent) and takes Zernio's current state.
 */
export function listedPostItem(post: JsonRecord, local: PostRecord | null): PostListItem | null {
  const id = str(post._id) ?? str(post.id)
  const rawStatus = str(post.status)
  const status = POST_STATUSES.find((s) => s === rawStatus)
  if (!isZernioId(id) || !status) return null
  const targets = (Array.isArray(post.platforms) ? post.platforms.map(asRecord) : []).map(listedTarget).filter((t): t is PostRecordTarget => t !== null)
  const content = typeof post.content === 'string' ? post.content.slice(0, LISTED_CONTENT_MAX) : ''
  const timezone = str(post.timezone)
  const profileId = accountIdOf(post.profileId) ?? str(post.queuedFromProfile)
  const merged = local ? applyZernioPost(local, post) : null
  return {
    id,
    origin: local ? 'app' : 'zernio',
    content: content || str(post.title)?.slice(0, 500) || local?.details?.caption || local?.clipTitle || '',
    status,
    scheduledFor: isoOrNull(post.scheduledFor),
    timezone: timezone && isValidTimeZone(timezone) ? timezone : null,
    createdAt: isoOrNull(post.createdAt) ?? local?.createdAt ?? new Date(0).toISOString(),
    publishedAt: isoOrNull(post.publishedAt),
    profileId: isZernioId(profileId) ? profileId : null,
    targets: merged?.targets ?? targets,
    local: merged
  }
}
