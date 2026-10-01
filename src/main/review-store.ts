import { constants, closeSync, fstatSync, lstatSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'fs'
import { basename, isAbsolute, join, relative, sep } from 'path'
import { readRunRecord, type RunRecord, type StoredDecision } from './run-history'
import { sameFile } from './file-identity'
import type { IdeaDecision, JobReview, ReviewIdea, RunStorage, StorageUsage } from '../shared/jobs'

const REVIEW_FILE = 'review.json'
const MAX_REVIEW_BYTES = 5 * 1024 * 1024
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const IDEA_ID = /^idea-\d{2,3}$/
const SOURCE_FILE = /^source\.[a-z0-9]{1,5}$/
const CLIP_FILE = /^clip_\d{2,}\.(mp4|srt|youtube\.txt|thumbnail\.(png|jpg|webp))$/
const SCORE_KEYS = ['hook', 'standalone', 'arc', 'quotability', 'ending'] as const

export interface SavedReview {
  videoTitle: string
  recommendedCount: number
  ideas: ReviewIdea[]
  sourcePath: string | null
  sourceDownloaded: boolean
  sourceBytes: number | null
}

function inside(path: string, directory: string): boolean {
  try {
    const rel = relative(realpathSync(directory), realpathSync(path))
    return rel !== '' && !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)
  } catch { return false }
}

/** The run folder of a desktop job, refusing symlinks and anything outside the library. */
export function runDirectory(baseDir: string, jobId: string): string {
  if (!UUID.test(jobId)) throw new Error('Invalid run identifier')
  const dir = join(baseDir, jobId)
  const stat = lstatSync(dir)
  if (!stat.isDirectory() || stat.isSymbolicLink() || !inside(dir, baseDir)) throw new Error('Invalid run directory')
  return dir
}

function text(value: unknown, max: number): string | null {
  return typeof value === 'string' ? value.slice(0, max) : null
}

function ms(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : null
}

function parseIdea(value: unknown): ReviewIdea | null {
  if (!value || typeof value !== 'object') return null
  const idea = value as Record<string, unknown>
  const id = idea.idea_id
  const startMs = ms(idea.start_time_ms)
  const endMs = ms(idea.end_time_ms)
  if (typeof id !== 'string' || !IDEA_ID.test(id) || startMs === null || endMs === null || endMs <= startMs) return null
  const scores: ReviewIdea['scores'] = {}
  if (idea.scores && typeof idea.scores === 'object') {
    for (const key of SCORE_KEYS) {
      const score = (idea.scores as Record<string, unknown>)[key]
      if (typeof score === 'number' && Number.isFinite(score)) scores[key] = Math.min(10, Math.max(0, score))
    }
  }
  const skipRanges = Array.isArray(idea.skip_ranges_ms)
    ? idea.skip_ranges_ms.slice(0, 50).flatMap((range): [number, number][] => {
      if (!Array.isArray(range)) return []
      const [from, to] = [ms(range[0]), ms(range[1])]
      return from !== null && to !== null && to > from ? [[from, to]] : []
    })
    : []
  const clipIndex = idea.clip_index
  const hookStart = ms(idea.hook_start_ms)
  const hookEnd = ms(idea.hook_end_ms)
  const hookText = text(idea.hook_text, 400)?.trim()
  // Only a hook that lies inside the clip and has words to show is offered.
  const hook = hookStart !== null && hookEnd !== null && hookText && hookEnd > hookStart && hookStart >= startMs && hookEnd <= endMs
    ? { startMs: hookStart, endMs: hookEnd, text: hookText } : null
  return {
    id,
    rank: typeof idea.rank === 'number' && Number.isSafeInteger(idea.rank) ? idea.rank : 0,
    recommended: idea.recommended !== false,
    rendered: idea.rendered === true,
    clipIndex: typeof clipIndex === 'number' && Number.isSafeInteger(clipIndex) && clipIndex >= 0 ? clipIndex : null,
    title: text(idea.summary, 200)?.trim() || 'Untitled idea',
    pitch: text(idea.pitch, 600),
    description: text(idea.description, 1500),
    excerpt: text(idea.excerpt, 8000) ?? '',
    scores,
    viralityScore: typeof idea.virality_score === 'number' && Number.isFinite(idea.virality_score) ? idea.virality_score : 0,
    startMs,
    endMs,
    skipRanges,
    tags: Array.isArray(idea.tags) ? idea.tags.filter((tag): tag is string => typeof tag === 'string').slice(0, 12).map((tag) => tag.slice(0, 48)) : [],
    hook
  }
}

/** Read a run's review.json. The source path is only trusted when it is the run's own download. */
export function readSavedReview(baseDir: string, jobId: string): SavedReview | null {
  let fd: number | null = null
  try {
    const dir = runDirectory(baseDir, jobId)
    const file = join(dir, REVIEW_FILE)
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const stat = fstatSync(fd)
    const entry = lstatSync(file)
    if (!stat.isFile() || stat.size > MAX_REVIEW_BYTES || entry.isSymbolicLink() || !sameFile(entry, stat)) return null
    const data = JSON.parse(readFileSync(fd, 'utf8')) as Record<string, unknown>
    if (!data || typeof data !== 'object' || data.version !== 1 || data.job_id !== jobId || !Array.isArray(data.ideas)) return null
    const ideas = data.ideas.slice(0, 200).map(parseIdea).filter((idea): idea is ReviewIdea => idea !== null)
    const seen = new Set<string>()
    const unique = ideas.filter((idea) => !seen.has(idea.id) && seen.add(idea.id)).sort((a, b) => a.rank - b.rank)
    const source = data.source && typeof data.source === 'object' ? data.source as Record<string, unknown> : {}
    const downloaded = source.downloaded === true
    const metadata = data.metadata && typeof data.metadata === 'object' ? data.metadata as Record<string, unknown> : {}
    const recommended = typeof data.recommended_count === 'number' && Number.isSafeInteger(data.recommended_count)
      ? data.recommended_count : unique.filter((idea) => idea.recommended).length
    return {
      videoTitle: text(metadata.title, 300) || 'Untitled video',
      recommendedCount: Math.max(0, recommended),
      ideas: unique,
      sourcePath: downloaded ? keptSourcePath(dir) : null,
      sourceDownloaded: downloaded,
      sourceBytes: typeof source.size_bytes === 'number' && Number.isFinite(source.size_bytes) ? source.size_bytes : null
    }
  } catch {
    return null
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

/** The downloaded stream kept in a run folder, if it is still there. */
export function keptSourcePath(runDir: string): string | null {
  try {
    for (const name of readdirSync(runDir)) {
      if (!SOURCE_FILE.test(name)) continue
      const path = join(runDir, name)
      const stat = lstatSync(path)
      if (stat.isFile() && !stat.isSymbolicLink()) return path
    }
  } catch { /* The run folder was removed. */ }
  return null
}

/**
 * A job's own local file, as validated when the job started. It is only used
 * while it still exists; the app never deletes it.
 */
export function userSourcePath(record: RunRecord | null): string | null {
  const request = record?.request as { videoUrl?: unknown } | undefined
  const path = request?.videoUrl
  if (typeof path !== 'string' || !isAbsolute(path)) return null
  try { return statSync(path).isFile() ? path : null } catch { return null }
}

export function reviewDecisions(record: RunRecord | null, ideas: ReviewIdea[]): Record<string, IdeaDecision> {
  const known = new Set(ideas.map((idea) => idea.id))
  return Object.fromEntries(Object.entries(record?.decisions ?? {}).filter(([id]) => known.has(id)))
}

/** Ideas that could still be rendered: neither rendered nor rejected. */
export function ideasLeft(review: SavedReview, decisions: Record<string, StoredDecision>): number {
  return review.ideas.filter((idea) => !idea.rendered && decisions[idea.id] !== 'rejected').length
}

export function buildJobReview(baseDir: string, jobId: string, busy: boolean): JobReview | null {
  const review = readSavedReview(baseDir, jobId)
  if (!review) return null
  const record = readRunRecord(baseDir, jobId)
  const status = record?.status === 'running'
    ? record.resumeStatus ?? 'awaiting_approval'
    : record?.status ?? 'awaiting_approval'
  const request = record?.request as { autoClipCount?: unknown } | undefined
  return {
    jobId,
    status,
    busy,
    videoTitle: review.videoTitle,
    recommendedCount: review.recommendedCount,
    autoClipCount: request?.autoClipCount === true,
    ideas: review.ideas,
    decisions: reviewDecisions(record, review.ideas),
    sourcePath: review.sourceDownloaded ? review.sourcePath : userSourcePath(record),
    sourceDownloaded: review.sourceDownloaded,
    sourceBytes: review.sourceBytes,
    lastError: record?.status !== 'running' ? record?.errorMessage ?? null : null
  }
}

/** Delete a run's downloaded stream. Never touches anything but source.* inside that run folder. */
export function deleteKeptSource(baseDir: string, jobId: string): boolean {
  const dir = runDirectory(baseDir, jobId)
  const path = keptSourcePath(dir)
  if (!path || !inside(path, dir) || !SOURCE_FILE.test(basename(path))) return false
  rmSync(path, { force: true })
  return true
}

function fileBytes(path: string): number {
  try {
    const stat = lstatSync(path)
    return stat.isFile() && !stat.isSymbolicLink() ? stat.size : 0
  } catch { return 0 }
}

/** Disk use per run folder: the kept stream, rendered clips, and everything else. */
export function storageUsage(baseDir: string, isBusy: (jobId: string) => boolean,
  titles: ReadonlyMap<string, { title: string; date: string; status: string }>): StorageUsage {
  const runs: RunStorage[] = []
  let entries: string[]
  try { entries = readdirSync(baseDir) } catch { return { runs, totalBytes: 0, sourceBytes: 0 } }
  for (const jobId of entries) {
    if (!UUID.test(jobId)) continue
    let dir: string
    try { dir = runDirectory(baseDir, jobId) } catch { continue }
    let sourceBytes = 0
    let clipBytes = 0
    let otherBytes = 0
    let files: string[] = []
    try { files = readdirSync(dir) } catch { continue }
    for (const name of files) {
      const size = fileBytes(join(dir, name))
      if (SOURCE_FILE.test(name)) sourceBytes += size
      else if (CLIP_FILE.test(name)) clipBytes += size
      else otherBytes += size
    }
    const record = readRunRecord(baseDir, jobId)
    const info = titles.get(jobId)
    runs.push({
      jobId,
      videoTitle: info?.title ?? record?.sourceLabel ?? 'Unfinished run',
      date: info?.date ?? record?.startedAt ?? new Date(0).toISOString(),
      status: info?.status ?? record?.status ?? 'incomplete',
      outputDir: dir,
      sourceBytes,
      sourceIsUserFile: sourceBytes === 0 && userSourcePath(record) !== null,
      clipBytes,
      otherBytes,
      totalBytes: sourceBytes + clipBytes + otherBytes,
      busy: isBusy(jobId)
    })
  }
  runs.sort((a, b) => b.totalBytes - a.totalBytes)
  return {
    runs,
    totalBytes: runs.reduce((sum, run) => sum + run.totalBytes, 0),
    sourceBytes: runs.reduce((sum, run) => sum + run.sourceBytes, 0)
  }
}
