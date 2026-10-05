// Posting clips through the user's own Zernio workspace. Shared by the main
// process (authoritative checks, payloads) and the renderer (inline hints).
//
// Limits come from docs.zernio.com and https://zernio.com/openapi.yaml
// (API 1.62, checked September 2026). Each platform page lists them under
// "Quick reference" and "Media requirements".

import type { ZernioPlatform } from './zernio'

/** What ffprobe reports about a clip. Null fields mean "unknown", never "zero". */
export interface ClipMediaInfo {
  durationMs: number | null
  width: number | null
  height: number | null
  sizeBytes: number
}

export interface PlatformRules {
  captionMax: number
  /** False when some accounts may go past `captionMax` (X Premium), so going over only warns. */
  captionStrict: boolean
  minSec: number
  maxSec: number | null
  maxBytes: number | null
}

const MB = 1024 * 1024
/** POST /v1/media/presign accepts files up to 5 GB. */
export const PRESIGN_MAX_BYTES = 5 * 1024 * MB

export const PLATFORM_RULES: Record<ZernioPlatform, PlatformRules> = {
  // 3 s to 10 min; creator info can lower the maximum per account.
  tiktok: { captionMax: 2200, captionStrict: true, minSec: 3, maxSec: 600, maxBytes: 4096 * MB },
  // Description limit; the title (100) is separate. 15 min for unverified channels, 12 h verified.
  youtube: { captionMax: 5000, captionStrict: true, minSec: 1, maxSec: 12 * 3600, maxBytes: null },
  // A single video is always a Reel through the API: 3 to 90 seconds.
  instagram: { captionMax: 2200, captionStrict: true, minSec: 3, maxSec: 90, maxBytes: null },
  // Feed video up to 240 min. Reels are checked separately (FACEBOOK_REEL).
  facebook: { captionMax: 63206, captionStrict: true, minSec: 1, maxSec: 240 * 60, maxBytes: 4096 * MB },
  // X sets the duration cap per account; Zernio enforces only 512 MB. 25,000 characters with Premium.
  twitter: { captionMax: 280, captionStrict: false, minSec: 0.5, maxSec: null, maxBytes: 512 * MB },
  // 10 min on personal profiles, 30 min on organization pages.
  linkedin: { captionMax: 3000, captionStrict: true, minSec: 3, maxSec: 30 * 60, maxBytes: 5120 * MB },
  threads: { captionMax: 500, captionStrict: true, minSec: 0, maxSec: 5 * 60, maxBytes: 1024 * MB }
}

/** Facebook Reels: a single vertical video lasting 3–60 seconds. */
export const FACEBOOK_REEL = { minSec: 3, maxSec: 60 }
/** YouTube classifies a vertical video of 3 minutes or less as a Short. */
export const YOUTUBE_SHORT_MAX_SEC = 180
export const YOUTUBE_UNVERIFIED_MAX_SEC = 15 * 60
export const YOUTUBE_TITLE_MAX = 100
export const LINKEDIN_PERSONAL_MAX_SEC = 10 * 60

// ---- Scheduling -------------------------------------------------------------

/** Scheduled posts must be at least this far ahead when the user picks the time. */
export const SCHEDULE_MIN_LEAD_MS = 5 * 60_000
/** Zernio deletes an upload after 7 days unless a post using it has published. */
export const UPLOAD_RETENTION_MS = 7 * 86_400_000
/** Room for clock skew and platform queues (e.g. TikTok holding a post past its daily cap). */
export const SCHEDULE_SAFETY_MARGIN_MS = 12 * 3_600_000

export function scheduleWindow(now: number, uploadedAt: number = now): { min: number; max: number } {
  return { min: now + SCHEDULE_MIN_LEAD_MS, max: uploadedAt + UPLOAD_RETENTION_MS - SCHEDULE_SAFETY_MARGIN_MS }
}

/**
 * Null when `at` is an acceptable publish time. `graceMs` relaxes the lower
 * bound for checks that run after the user picked the time (dialog open,
 * upload in progress).
 */
export function scheduleError(at: number, now: number, uploadedAt: number = now, graceMs = 0): string | null {
  if (!Number.isFinite(at)) return 'Choose a date and time.'
  const { min, max } = scheduleWindow(now, uploadedAt)
  if (at < min - graceMs) return 'Pick a time at least 5 minutes from now.'
  if (at > max) {
    return uploadedAt < now
      ? 'Zernio keeps this upload for 7 days, so pick an earlier time or post the clip again.'
      : 'Zernio keeps uploads for 7 days, so schedule at most 6½ days ahead.'
  }
  return null
}

export function isValidTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9_+\-/]{0,63}$/.test(value)) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value })
    return true
  } catch {
    return false
  }
}

// ---- Clip checks ------------------------------------------------------------

export function formatClipDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds))
  const m = Math.floor(total / 60)
  const s = total % 60
  return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`
}

function platformLabel(platform: ZernioPlatform): string {
  return { tiktok: 'TikTok', youtube: 'YouTube', instagram: 'Instagram', facebook: 'Facebook', twitter: 'X', linkedin: 'LinkedIn', threads: 'Threads' }[platform]
}

export function isVertical(media: Pick<ClipMediaInfo, 'width' | 'height'>): boolean | null {
  return media.width && media.height ? media.height > media.width : null
}

export interface ClipCheckContext {
  /** From TikTok creator info; lowers TikTok's maximum for this account. */
  tiktokMaxSec?: number | null
  facebookFormat?: FacebookFormat
}

export interface ClipCheck {
  /** Why this platform can't take the clip; null when it can. */
  blocking: string | null
  notes: string[]
}

/** Whether `platform` accepts this clip, and anything the user should know first. */
export function checkClip(platform: ZernioPlatform, media: ClipMediaInfo, context: ClipCheckContext = {}): ClipCheck {
  const rules = PLATFORM_RULES[platform]
  const name = platformLabel(platform)
  const seconds = media.durationMs == null ? null : media.durationMs / 1000
  const vertical = isVertical(media)
  const notes: string[] = []

  let maxSec = rules.maxSec
  if (platform === 'tiktok' && context.tiktokMaxSec && context.tiktokMaxSec > 0) maxSec = Math.min(maxSec ?? Infinity, context.tiktokMaxSec)
  let minSec = rules.minSec
  if (platform === 'facebook' && context.facebookFormat === 'reel') {
    minSec = FACEBOOK_REEL.minSec
    maxSec = FACEBOOK_REEL.maxSec
    if (vertical === false) return { blocking: 'Facebook Reels need a vertical video. Post it to the feed instead.', notes }
  }

  if (media.sizeBytes > PRESIGN_MAX_BYTES) return { blocking: 'Zernio accepts uploads up to 5 GB.', notes }
  if (rules.maxBytes != null && media.sizeBytes > rules.maxBytes) {
    const size = rules.maxBytes >= 1024 * MB ? `${rules.maxBytes / (1024 * MB)} GB` : `${rules.maxBytes / MB} MB`
    return { blocking: `${name} accepts videos up to ${size}.`, notes }
  }
  if (seconds != null) {
    if (seconds < minSec) return { blocking: `${name} needs clips of at least ${minSec} seconds.`, notes }
    if (maxSec != null && seconds > maxSec + 0.5) {
      const what = platform === 'instagram' ? 'Instagram Reels' : platform === 'facebook' && context.facebookFormat === 'reel' ? 'Facebook Reels' : name
      const why = platform === 'tiktok' && maxSec < (rules.maxSec ?? Infinity) ? ' for this account' : ''
      return { blocking: `${what} can be at most ${formatClipDuration(maxSec)}${why}. This clip is ${formatClipDuration(seconds)}.`, notes }
    }
  }

  if (platform === 'youtube' && seconds != null) {
    notes.push(vertical !== false && seconds <= YOUTUBE_SHORT_MAX_SEC ? 'Posts as a Short.' : 'Posts as a regular video.')
    if (seconds > YOUTUBE_UNVERIFIED_MAX_SEC) notes.push('Channels need phone verification for videos over 15 minutes.')
  }
  if (platform === 'tiktok' && vertical === false) notes.push('TikTok works best with vertical 9:16 video.')
  if (platform === 'instagram' && vertical === false) notes.push('Reels are 9:16, so Instagram will letterbox this clip.')
  if (platform === 'linkedin' && seconds != null && seconds > LINKEDIN_PERSONAL_MAX_SEC) notes.push('Personal profiles allow up to 10 minutes; Pages allow 30.')
  return { blocking: null, notes }
}

/** Default Facebook format for a clip: a Reel when it qualifies, otherwise a feed video. */
export function defaultFacebookFormat(media: ClipMediaInfo): FacebookFormat {
  if (media.durationMs == null || media.width == null || media.height == null) return 'feed'
  return checkClip('facebook', media, { facebookFormat: 'reel' }).blocking ? 'feed' : 'reel'
}

/** Characters as people count them (code points), close to how the platforms count. */
export function captionLength(caption: string): number {
  return [...caption].length
}

export interface CaptionCheck {
  error: string | null
  warning: string | null
}

export function checkCaption(platform: ZernioPlatform, caption: string): CaptionCheck {
  const rules = PLATFORM_RULES[platform]
  const length = captionLength(caption)
  if (length <= rules.captionMax) return { error: null, warning: null }
  const text = `${platformLabel(platform)} allows ${rules.captionMax.toLocaleString('en-US')} characters.`
  return rules.captionStrict
    ? { error: text, warning: null }
    : { error: null, warning: `${text} Only X Premium accounts can post longer captions.` }
}

// ---- Caption defaults -----------------------------------------------------

/** YouTube video categories (YouTube's own ids), as the planner may choose them. */
export const YOUTUBE_CATEGORIES: readonly { id: string; label: string }[] = [
  { id: '28', label: 'Science & Technology' }, { id: '27', label: 'Education' }, { id: '26', label: 'Howto & Style' },
  { id: '22', label: 'People & Blogs' }, { id: '24', label: 'Entertainment' }, { id: '23', label: 'Comedy' },
  { id: '20', label: 'Gaming' }, { id: '10', label: 'Music' }, { id: '25', label: 'News & Politics' },
  { id: '17', label: 'Sports' }, { id: '19', label: 'Travel & Events' }, { id: '15', label: 'Pets & Animals' },
  { id: '2', label: 'Autos & Vehicles' }, { id: '1', label: 'Film & Animation' }, { id: '29', label: 'Nonprofits & Activism' }
]
/** YouTube's own default for new uploads. */
export const DEFAULT_YOUTUBE_CATEGORY = '22'

export function isYouTubeCategory(value: unknown): value is string {
  return typeof value === 'string' && YOUTUBE_CATEGORIES.some((category) => category.id === value)
}

/** YouTube keeps tags until their combined length passes 500 characters, each at most 100. */
export const YOUTUBE_TAGS_MAX_CHARS = 500
export const YOUTUBE_TAGS_MAX_COUNT = 20

/** Tags typed as "claude code, ai tools" (commas or new lines). */
export function parseTagList(text: string): string[] {
  return text.split(/[,\n]/)
}

/**
 * Keyword tags for YouTube: no "#", single spaces, no duplicates, nothing
 * YouTube rejects, and only as many as fit its limits.
 */
export function youtubeTagsFrom(tags: readonly string[]): string[] {
  const result: string[] = []
  const seen = new Set<string>()
  let length = 0
  for (const raw of tags) {
    const tag = raw.replace(/^#+/, '').replace(/\s+/g, ' ').trim()
    const key = tag.toLocaleLowerCase()
    if (!tag || [...tag].length > 100 || /[<>]/.test(tag) || seen.has(key)) continue
    const next = length + (result.length ? 1 : 0) + tag.length
    if (next > YOUTUBE_TAGS_MAX_CHARS || result.length >= YOUTUBE_TAGS_MAX_COUNT) break
    seen.add(key)
    result.push(tag)
    length = next
  }
  return result
}

/** "startup tips" → "#StartupTips", "ai" → "#ai". Drops tags with nothing usable. */
export function hashtagFor(tag: string): string | null {
  const words = tag.normalize('NFKC').split(/[^\p{L}\p{N}]+/u).filter(Boolean)
  if (words.length === 0) return null
  const joined = words.length === 1 ? words[0] : words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join('')
  return `#${joined.slice(0, 60)}`
}

export function defaultCaption(title: string, tags: string[], maxTags = 5): string {
  const seen = new Set<string>()
  const hashtags: string[] = []
  for (const tag of tags) {
    const hashtag = hashtagFor(tag)
    if (!hashtag || seen.has(hashtag.toLowerCase())) continue
    seen.add(hashtag.toLowerCase())
    hashtags.push(hashtag)
    if (hashtags.length === maxTags) break
  }
  return [title.trim(), hashtags.join(' ')].filter(Boolean).join('\n\n')
}

/** YouTube titles are at most 100 characters and can't contain angle brackets. */
export function youtubeTitleFor(title: string): string {
  const cleaned = title.replace(/[<>]/g, '').replace(/\s+/g, ' ').trim()
  const chars = [...cleaned]
  if (chars.length <= YOUTUBE_TITLE_MAX) return cleaned
  return `${chars.slice(0, YOUTUBE_TITLE_MAX - 1).join('').trimEnd()}…`
}

// ---- TikTok -----------------------------------------------------------------

export interface TikTokCreatorInfo {
  accountId: string
  nickname: string | null
  /** False when TikTok won't accept another direct post from this creator right now. */
  canPostMore: boolean
  /** Only these values may be sent as privacy_level. */
  privacyLevels: { value: string; label: string }[]
  maxVideoDurationSec: number | null
  /** False when the creator turned the interaction off in the TikTok app. */
  interactions: { comment: boolean; duet: boolean; stitch: boolean }
  /** Commercial content disclosures the account can make ('brand_organic', 'brand_content'). */
  commercialContentTypes: string[]
}

export const TIKTOK_PRIVACY_LABELS: Record<string, string> = {
  PUBLIC_TO_EVERYONE: 'Everyone',
  MUTUAL_FOLLOW_FRIENDS: 'Friends',
  FOLLOWER_OF_CREATOR: 'Followers',
  SELF_ONLY: 'Only me'
}

/** Commercial disclosures every selected TikTok account can make (all of them when unreported). */
export function sharedCommercialTypes(infos: TikTokCreatorInfo[]): string[] {
  const [first, ...rest] = infos
  if (!first) return []
  return first.commercialContentTypes.filter((type) => rest.every((info) => info.commercialContentTypes.includes(type)))
}

/**
 * One TikTok account's choices, checked against its own creator info.
 * TikTok's rules: the user picks the privacy level from that creator's
 * options (no default), and branded content can't be private.
 */
export function tiktokAccountError(options: TikTokPostOptions, account: TikTokAccountOptions | undefined, info: TikTokCreatorInfo): string | null {
  const privacy = account?.privacyLevel ?? ''
  if (!privacy) return 'Choose who can view the TikTok post.'
  if (!info.privacyLevels.some((level) => level.value === privacy)) return 'That TikTok privacy option isn’t available for this account. Choose another.'
  if (options.disclose && options.brandedContent && privacy === 'SELF_ONLY') return 'Branded content can’t be private on TikTok. Choose another privacy option.'
  if (!options.draft && !info.canPostMore) return 'TikTok isn’t accepting more posts from this account right now. Try later, or send it to your TikTok inbox.'
  return null
}

/**
 * Every selected TikTok account's choices, then the ones they share
 * (disclosure and consent). `label` names an account when there are several.
 */
export function tiktokOptionsError(options: TikTokPostOptions, infos: TikTokCreatorInfo[], label?: (accountId: string) => string): string | null {
  for (const info of infos) {
    const error = tiktokAccountError(options, options.accounts[info.accountId], info)
    if (error) return infos.length > 1 && label ? `${label(info.accountId)}: ${error}` : error
  }
  if (options.disclose && !options.yourBrand && !options.brandedContent) return 'Choose whether the TikTok post promotes your brand, a third party, or both.'
  if (options.disclose) {
    const requiredTypes = [options.yourBrand ? 'brand_organic' : null, options.brandedContent ? 'brand_content' : null].filter((type): type is string => type !== null)
    for (const info of infos) {
      // Older creator-info responses may omit this field. When Zernio does
      // report available types, reject a disclosure this creator cannot make.
      if (info.commercialContentTypes.length === 0) continue
      if (requiredTypes.some((type) => !info.commercialContentTypes.includes(type))) {
        const message = 'This TikTok account does not offer the selected commercial content disclosure.'
        return infos.length > 1 && label ? `${label(info.accountId)}: ${message}` : message
      }
    }
  }
  if (!options.consent) return 'Agree to TikTok’s terms to post there.'
  return null
}

/** TikTok's required declaration, shown next to the consent checkbox. */
export function tiktokConsentText(brandedContent: boolean): string {
  return brandedContent
    ? "By posting, you agree to TikTok's Branded Content Policy and Music Usage Confirmation."
    : "By posting, you agree to TikTok's Music Usage Confirmation."
}

/** Fixed TikTok legal pages the dialog may open; the main process maps keys to URLs. */
export const TIKTOK_LEGAL_LINKS = {
  musicUsage: 'https://www.tiktok.com/legal/page/global/music-usage-confirmation/en',
  brandedContent: 'https://www.tiktok.com/legal/page/global/bc-policy/en'
} as const
export type TikTokLegalLink = keyof typeof TIKTOK_LEGAL_LINKS

// ---- Requests and results ---------------------------------------------------

export type FacebookFormat = 'reel' | 'feed'
export type YouTubeVisibility = 'public' | 'unlisted' | 'private'

/** Choices made separately for each TikTok account: each creator has its own options. */
export interface TikTokAccountOptions {
  /** '' until the user picks one; TikTok forbids a default. */
  privacyLevel: string
  allowComment: boolean
  allowDuet: boolean
  allowStitch: boolean
}

export const EMPTY_TIKTOK_ACCOUNT: TikTokAccountOptions = { privacyLevel: '', allowComment: false, allowDuet: false, allowStitch: false }

export interface TikTokPostOptions {
  /** By TikTok account id. */
  accounts: Record<string, TikTokAccountOptions>
  /** Commercial content disclosure. */
  disclose: boolean
  yourBrand: boolean
  brandedContent: boolean
  madeWithAi: boolean
  /** Send to the creator's TikTok inbox to finish in the app, instead of posting directly. */
  draft: boolean
  /** The user ticked TikTok's consent declaration. */
  consent: boolean
}

export interface YouTubePostOptions {
  title: string
  visibility: YouTubeVisibility
  madeForKids: boolean
  categoryId?: string
  tags?: string[]
}

export interface PostOptions {
  tiktok?: TikTokPostOptions
  youtube?: YouTubePostOptions
  instagram?: { shareToFeed: boolean }
  facebook?: { format: FacebookFormat; title?: string }
  threads?: { topicTag?: string }
}

/** `queue`: Zernio puts the post in the profile's next free queue slot. */
export type PostTiming = { mode: 'now' } | { mode: 'schedule'; scheduledFor: string; timezone: string } | { mode: 'queue'; profileId: string }

export interface PostTarget {
  platform: ZernioPlatform
  accountId: string
  /** Overrides the shared content for this account; used by automation metadata. */
  customContent?: string
}

export interface PostClipRequest {
  /** Chosen by the renderer per clip. Progress events carry it, and a retry with it reuses the upload. */
  attemptId: string
  clipPath: string
  clipTitle: string
  /** From job_output.json; used only when ffprobe can't read the file. */
  durationMs: number | null
  caption: string
  /**
   * The clip's thumbnail (clip_XX.thumbnail.png|jpg|webp beside the clip), sent
   * as the Instagram Reel cover and the YouTube thumbnail. YouTube ignores it on Shorts.
   */
  thumbnailPath?: string | null
  targets: PostTarget[]
  timing: PostTiming
  options: PostOptions
}

export interface PostProgress {
  attemptId: string
  phase: 'uploading' | 'publishing'
  transferred: number
  total: number
}

export type PostStatus = 'draft' | 'scheduled' | 'publishing' | 'published' | 'partial' | 'failed' | 'cancelled' | 'missing'
export type PostTargetStatus = 'pending' | 'processing' | 'uploading' | 'published' | 'failed' | 'cancelled'

export interface PostRecordTarget {
  platform: string
  accountId: string
  /** @handle or display name when the post was made; for display only. */
  handle: string | null
  status: PostTargetStatus
  error: string | null
  url: string | null
  /** TikTok Creator Inbox upload: "published" means handed to the inbox. */
  inbox: boolean
}

/** Longest caption kept in a post's details (what was sent is shown, not re-sent). */
export const POST_DETAILS_CAPTION_MAX = 10_000
export const POST_DETAILS_MAX_WARNINGS = 5

/** What was sent with a post, kept so the Posts page can show it later. Nothing secret. */
export interface PostDetails {
  caption: string
  /** The thumbnail file sent as the Instagram cover and YouTube thumbnail, when one was sent. */
  thumbnailPath: string | null
  /** Text that differs for a single account (account id → text). */
  accountCaptions: Record<string, string>
  youtube: { title: string; visibility: string; madeForKids: boolean; categoryId: string | null; tags: string[] } | null
  instagram: { shareToFeed: boolean } | null
  facebook: { format: string; title: string | null } | null
  threads: { topicTag: string | null } | null
  /** TikTok privacy level per account id. `draft` means the clip went to the TikTok inbox. */
  tiktok: { draft: boolean; madeWithAi: boolean; privacy: Record<string, string> } | null
  /** Notices Zernio returned when it created the post. */
  warnings: string[]
}

/** One post in the local history (userData/zernio-posts.json). Nothing secret. */
export interface PostRecord {
  id: string
  clipPath: string
  clipTitle: string
  targets: PostRecordTarget[]
  scheduledFor: string | null
  timezone: string | null
  status: PostStatus
  error: string | null
  createdAt: string
  /** When the clip reached Zernio's storage; bounds rescheduling (7-day retention). */
  uploadedAt: string
  refreshedAt: string | null
  /** What was sent. Missing on posts made before this was recorded. */
  details?: PostDetails | null
}

export type PostOutcome = 'published' | 'scheduled' | 'partial' | 'failed' | 'retrying' | 'publishing' | 'duplicate'

export interface PostClipResult {
  post: PostRecord | null
  outcome: PostOutcome
  message: string
  warnings: string[]
}

export interface PostsRefreshResult {
  posts: PostRecord[]
  /** Set when some statuses couldn't be refreshed; the list is still usable. */
  error: string | null
}

const ACTIVE: PostStatus[] = ['scheduled', 'publishing']
export function isPostActive(post: Pick<PostRecord, 'status'>): boolean {
  return ACTIVE.includes(post.status)
}

// ---- Posts list -------------------------------------------------------------

/** Zernio's own sort orders for GET /v1/posts; local history sorts the same way. */
export const POSTS_SORTS = ['scheduled-desc', 'scheduled-asc', 'created-desc', 'created-asc', 'status', 'platform'] as const
export type PostsSort = (typeof POSTS_SORTS)[number]
/** Statuses Zernio reports ('missing' exists only in local history). */
export const REMOTE_POST_STATUSES = ['draft', 'scheduled', 'publishing', 'published', 'partial', 'failed', 'cancelled'] as const satisfies readonly PostStatus[]

export interface PostsFilter {
  status: PostStatus | null
  platform: ZernioPlatform | null
  profileId: string | null
  /** ISO datetimes bounding the post's date (scheduled time, else creation). */
  fromDate: string | null
  toDate: string | null
  search: string
  sort: PostsSort
}

export const DEFAULT_POSTS_FILTER: PostsFilter = { status: null, platform: null, profileId: null, fromDate: null, toDate: null, search: '', sort: 'scheduled-desc' }

export interface RemotePostsQuery extends PostsFilter {
  page: number
  limit: number
}

/** One row of the Posts list, from local history or from the Zernio workspace. */
export interface PostListItem {
  id: string
  /** 'app' when vClip made the post (it has a local record), 'zernio' otherwise. */
  origin: 'app' | 'zernio'
  content: string
  status: PostStatus
  scheduledFor: string | null
  timezone: string | null
  createdAt: string
  publishedAt: string | null
  /** Null when Zernio doesn't report it; the accounts' profiles stand in. */
  profileId: string | null
  targets: PostRecordTarget[]
  local: PostRecord | null
}

export interface RemotePostsPage {
  items: PostListItem[]
  page: number
  pages: number
  total: number
}

export function postListItemFromRecord(record: PostRecord): PostListItem {
  return {
    id: record.id,
    origin: 'app',
    content: record.details?.caption || record.clipTitle,
    status: record.status,
    scheduledFor: record.scheduledFor,
    timezone: record.timezone,
    createdAt: record.createdAt,
    publishedAt: null,
    profileId: null,
    targets: record.targets,
    local: record
  }
}

/** The date a post is filed under: when it is (or was) due, else when it was made. */
export function postListDate(item: Pick<PostListItem, 'scheduledFor' | 'publishedAt' | 'createdAt'>): string {
  return item.scheduledFor ?? item.publishedAt ?? item.createdAt
}

const STATUS_ORDER: PostStatus[] = ['publishing', 'scheduled', 'failed', 'partial', 'missing', 'draft', 'published', 'cancelled']

/**
 * Local history filtered and sorted like Zernio's list. `profileOf` maps an
 * account to its profile, since history records don't store the profile.
 */
export function filterAndSortPosts(items: readonly PostListItem[], filter: PostsFilter, profileOf: (accountId: string) => string | null = () => null): PostListItem[] {
  const needle = filter.search.trim().toLocaleLowerCase()
  const from = filter.fromDate ? Date.parse(filter.fromDate) : null
  const to = filter.toDate ? Date.parse(filter.toDate) : null
  const matches = items.filter((item) => {
    if (filter.status && item.status !== filter.status) return false
    if (filter.platform && !item.targets.some((t) => t.platform === filter.platform)) return false
    if (filter.profileId && item.profileId !== filter.profileId && !item.targets.some((t) => profileOf(t.accountId) === filter.profileId)) return false
    const at = Date.parse(postListDate(item))
    if (from != null && at < from) return false
    if (to != null && at > to) return false
    if (needle) {
      const haystack = [item.content, item.local?.clipTitle ?? '', ...item.targets.map((t) => t.handle ?? '')].join('\n').toLocaleLowerCase()
      if (!haystack.includes(needle)) return false
    }
    return true
  })
  const byDate = (key: (item: PostListItem) => string, direction: 1 | -1) => (a: PostListItem, b: PostListItem): number =>
    direction * key(a).localeCompare(key(b)) || b.createdAt.localeCompare(a.createdAt)
  const sorters: Record<PostsSort, (a: PostListItem, b: PostListItem) => number> = {
    'scheduled-desc': byDate(postListDate, -1),
    'scheduled-asc': byDate(postListDate, 1),
    'created-desc': byDate((item) => item.createdAt, -1),
    'created-asc': byDate((item) => item.createdAt, 1),
    status: (a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) || postListDate(b).localeCompare(postListDate(a)),
    platform: (a, b) => (a.targets[0]?.platform ?? '').localeCompare(b.targets[0]?.platform ?? '') || postListDate(b).localeCompare(postListDate(a))
  }
  return matches.sort(sorters[filter.sort])
}

// ---- Queue ------------------------------------------------------------------

/** The next free slot in a profile's posting queue (GET /v1/queue/next-slot). */
export interface QueueSlot {
  profileId: string
  /** Null when the profile has no queue times yet, or every slot is taken. */
  nextSlot: string | null
  timezone: string | null
  queueName: string | null
}

/** A queue slot the clip's upload would not live to see (Zernio keeps uploads 7 days). */
export function queueSlotError(at: number, now: number): string | null {
  if (!Number.isFinite(at)) return 'This profile has no free queue time. Add queue times in Zernio, or pick a time.'
  return at > scheduleWindow(now).max
    ? 'The next free queue time is more than 6½ days away, and Zernio keeps uploads for 7 days. Pick a time instead, or add more queue times in Zernio.'
    : null
}

// ---- Drafts -----------------------------------------------------------------

/** How the post will go out once the draft is finished. */
export type DraftTimingMode = 'now' | 'schedule' | 'queue'

/**
 * A post being prepared, kept only on this computer: the clip is uploaded when
 * it is posted, because Zernio deletes unpublished uploads after 7 days.
 */
export interface PostDraft {
  id: string
  clipPath: string
  clipTitle: string
  durationMs: number | null
  caption: string
  accountIds: string[]
  useThumbnail: boolean
  /** `tags` as typed (comma or line separated). */
  youtube: { title: string; visibility: YouTubeVisibility; madeForKids: boolean; categoryId: string | null; tags: string }
  shareToFeed: boolean
  facebookFormat: FacebookFormat | null
  /** TikTok choices. Consent is never kept: it is given for the post when it goes out. */
  tiktok: TikTokPostOptions
  timing: { mode: DraftTimingMode; scheduledFor: string | null }
  createdAt: string
  updatedAt: string
}

/** What the composer sends to save; `id` null creates a new draft. */
export type PostDraftInput = Omit<PostDraft, 'id' | 'createdAt' | 'updatedAt'> & { id: string | null }

export interface PostDraftEntry extends PostDraft {
  /** The clip file was moved or deleted since the draft was saved. */
  clipMissing: boolean
}

export const MAX_POST_DRAFTS = 200
