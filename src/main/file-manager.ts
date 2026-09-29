import { execFile } from 'child_process'
import { createHash, randomUUID } from 'crypto'
import { app } from 'electron'
import { promisify } from 'util'
const execFileAsync = promisify(execFile)
import { constants, existsSync, lstatSync, mkdirSync, realpathSync, renameSync, statSync, unlinkSync } from 'fs'
import { open, readdir } from 'fs/promises'
import { isAbsolute, join, relative, sep } from 'path'
import { resolveBinary } from './tools'
import { parseJobOutput, type JobOutput } from '../shared/job-output'
import { readRunRecord, type RunRecord } from './run-history'
import { ideasLeft, readSavedReview, reviewDecisions } from './review-store'
import { sameFile } from './file-identity'

export interface JobHistoryEntry {
  jobId: string
  date: string
  videoTitle: string
  clipCount: number
  status: 'completed' | 'failed' | 'cancelled' | 'running' | 'interrupted' | 'incomplete' | 'awaiting_approval'
  outputDir: string
  totalCostUsd: number | null
  finishedAt: string | null
  durationMs: number | null
  errorMessage: string | null
  /** Reviewed ideas that are neither rendered nor rejected; null for runs without a review. */
  ideasLeft: number | null
  /** The downloaded stream is still kept, so more ideas can be rendered. */
  sourceKept: boolean
}

function reviewSummary(baseDir: string, jobId: string, record: RunRecord | null): Pick<JobHistoryEntry, 'ideasLeft' | 'sourceKept'> & { title: string | null } {
  const review = readSavedReview(baseDir, jobId)
  if (!review) return { ideasLeft: null, sourceKept: false, title: null }
  return {
    ideasLeft: ideasLeft(review, reviewDecisions(record, review.ideas)),
    sourceKept: review.sourcePath !== null,
    title: review.videoTitle
  }
}

const MAX_JOB_OUTPUT_BYTES = 20 * 1024 * 1024

async function readJobOutput(outputPath: string, libraryDir: string): Promise<{ data: JobOutput; modified: Date } | null> {
  const entry = lstatSync(outputPath)
  if (!entry.isFile() || entry.isSymbolicLink()) return null
  const handle = await open(outputPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const file = await handle.stat()
    if (!file.isFile() || file.size > MAX_JOB_OUTPUT_BYTES) return null
    // Windows has no O_NOFOLLOW. Check the name again after opening, then
    // compare it with the file descriptor so a swapped link is not accepted.
    const currentEntry = lstatSync(outputPath)
    if (!currentEntry.isFile() || currentEntry.isSymbolicLink() || !sameFile(file, currentEntry)) return null
    const canonical = realpathSync(outputPath)
    const library = realpathSync(libraryDir)
    const rel = relative(library, canonical)
    const current = statSync(canonical)
    if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`) || !sameFile(file, current)) return null
    const data = parseJobOutput(JSON.parse(await handle.readFile('utf-8')))
    return data ? { data, modified: file.mtime } : null
  } finally {
    await handle.close()
  }
}

export function ensureOutputDir(baseDir: string): void {
  if (!existsSync(baseDir)) {
    mkdirSync(baseDir, { recursive: true })
  }
}

export async function getJobHistory(baseDir: string, activeJobIds: ReadonlySet<string> = new Set()): Promise<JobHistoryEntry[]> {
  if (!existsSync(baseDir)) return []

  const entries: JobHistoryEntry[] = []

  try {
    const dirs = (await readdir(baseDir, { withFileTypes: true })).filter((d) => d.isDirectory())

    for (const dir of dirs) {
      const outputPath = join(baseDir, dir.name, 'job_output.json')
      const record = readRunRecord(baseDir, dir.name)
      const durationMs = record?.finishedAt
        ? Math.max(0, Date.parse(record.finishedAt) - Date.parse(record.startedAt)) : null
      try {
        const result = await readJobOutput(outputPath, baseDir)
        if (!result) throw new Error('Unsupported result file')
        const { data } = result
        const costs = data.metrics?.api_costs
        const costVal = costs && typeof costs === 'object' ? (costs as Record<string, unknown>).total_estimated_cost_usd : null
        const { ideasLeft, sourceKept } = reviewSummary(baseDir, dir.name, record)
        const review = { ideasLeft, sourceKept }
        // A later render round of a finished job shows as running while it runs.
        const renderingMore = record?.status === 'running' && record.resumeStatus && activeJobIds.has(dir.name)
        entries.push({
          jobId: dir.name,
          date: record?.startedAt ?? result.modified.toISOString(),
          videoTitle: data.source_video_title,
          clipCount: data.clips.length,
          ...review,
          status: renderingMore ? 'running' : 'completed',
          outputDir: join(baseDir, dir.name),
          totalCostUsd: typeof costVal === 'number' ? costVal : null,
          finishedAt: record?.finishedAt ?? result.modified.toISOString(),
          // A reviewed run's wall-clock time includes waiting for approval; show processing time.
          durationMs: (ideasLeft === null ? durationMs : null) ??
            (typeof data.processing_time_seconds === 'number' ? Math.round(data.processing_time_seconds * 1000) : null),
          errorMessage: null
        })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          // Desktop jobs use UUIDs. Keep interrupted runs visible without treating
          // unrelated folders in the selected output directory as clip jobs.
          if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(dir.name)) {
            const runDir = join(baseDir, dir.name)
            try {
              const stat = lstatSync(runDir)
              if (stat.isDirectory() && !stat.isSymbolicLink()) {
                // A render round interrupted by a crash returns to review, like a cancelled one.
                const status = record?.status === 'running'
                  ? (activeJobIds.has(dir.name) ? 'running' : record.resumeStatus ?? 'interrupted')
                  : record?.status === 'failed' || record?.status === 'cancelled' || record?.status === 'awaiting_approval'
                    ? record.status : 'incomplete'
                const { title, ...review } = reviewSummary(baseDir, dir.name, record)
                entries.push({ jobId: dir.name, date: record?.startedAt ?? stat.mtime.toISOString(),
                  videoTitle: title ?? record?.sourceLabel ?? 'Unfinished run', clipCount: 0,
                  status, outputDir: runDir, totalCostUsd: null,
                  finishedAt: record?.finishedAt ?? null, durationMs,
                  errorMessage: record?.errorMessage ?? null, ...review })
              }
            } catch { /* The run directory was removed during the scan. */ }
          }
          continue
        }
        entries.push({ jobId: dir.name, date: record?.startedAt ?? new Date(0).toISOString(), videoTitle: record?.sourceLabel ?? 'Unreadable run', clipCount: 0,
          status: 'failed', outputDir: join(baseDir, dir.name), totalCostUsd: null,
          finishedAt: record?.finishedAt ?? null, durationMs,
          errorMessage: record?.errorMessage ?? 'The saved result could not be read.', ideasLeft: null, sourceKept: false })
      }
    }
  } catch {
    throw new Error('Could not read the clip library')
  }

  return entries.sort((a, b) => b.date.localeCompare(a.date))
}

export async function getJobOutput(outputDir: string, libraryDir = outputDir): Promise<JobOutput | null> {
  const outputPath = join(outputDir, 'job_output.json')
  try {
    return (await readJobOutput(outputPath, libraryDir))?.data ?? null
  } catch {
    return null
  }
}

async function getVideoDurationSeconds(videoPath: string): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync(
      resolveBinary('ffprobe'),
      ['-v', 'error', '-protocol_whitelist', 'file,pipe,fd', '-format_whitelist', 'mov,matroska,webm,avi,flv', '-show_entries', 'format=duration', '-of', 'csv=p=0', videoPath],
      { timeout: 10000, maxBuffer: 1024 * 1024 }
    )
    const raw = stdout.trim()
    const dur = parseFloat(raw)
    return Number.isFinite(dur) ? dur : null
  } catch {
    return null
  }
}

/**
 * Generate a thumbnail for a video clip using ffmpeg.
 * Seeks to the middle of the clip for a representative frame.
 * If seekSeconds is provided, uses that instead.
 */
export async function generateThumbnail(videoPath: string, seekSeconds?: number): Promise<string | null> {
  if (!/\.(mp4|m4v|mkv|webm|mov|avi|flv)$/i.test(videoPath)) return null
  if (seekSeconds !== undefined && (!Number.isFinite(seekSeconds) || seekSeconds < 0 || seekSeconds > 6 * 60 * 60)) return null
  let source: string
  let sourceStat: ReturnType<typeof statSync>
  try {
    source = realpathSync(videoPath)
    sourceStat = statSync(source)
    if (!sourceStat.isFile()) return null
  } catch { return null }

  const thumbnailDir = join(app.getPath('userData'), 'thumbnails')
  mkdirSync(thumbnailDir, { recursive: true, mode: 0o700 })
  if (!lstatSync(thumbnailDir).isDirectory() || lstatSync(thumbnailDir).isSymbolicLink()) return null
  const identity = `${source}:${sourceStat.dev}:${sourceStat.ino}:${sourceStat.size}:${sourceStat.mtimeMs}:${seekSeconds ?? 'middle'}`
  const thumbPath = join(thumbnailDir, `${createHash('sha256').update(identity).digest('hex')}.jpg`)
  if (existsSync(thumbPath) && lstatSync(thumbPath).isFile() && !lstatSync(thumbPath).isSymbolicLink()) return thumbPath
  const tempPath = join(thumbnailDir, `${randomUUID()}.jpg`)

  let seekTo = seekSeconds ?? null

  if (seekTo === null) {
    const duration = await getVideoDurationSeconds(source)
    if (duration !== null && duration > 6 * 60 * 60) return null
    if (duration && duration > 0.5) {
      seekTo = Math.min(duration * 0.5, duration - 0.1)
    } else {
      seekTo = 0
    }
  }

  const ffmpeg = resolveBinary('ffmpeg')
  const frameArgs = ['-protocol_whitelist', 'file,pipe,fd', '-format_whitelist', 'mov,matroska,webm,avi,flv', '-i', source, '-frames:v', '1', '-q:v', '2', '-vf', 'scale=640:-2', tempPath]

  try {
    await execFileAsync(
      ffmpeg,
      seekTo > 0 ? ['-n', '-ss', seekTo.toFixed(2), ...frameArgs] : ['-n', ...frameArgs],
      { timeout: 15000 }
    )
    if (existsSync(tempPath)) {
      renameSync(tempPath, thumbPath)
      return thumbPath
    }
  } catch {
    // Fallback: grab first frame
    try { unlinkSync(tempPath) } catch { /* The first attempt may not have written a frame. */ }
    try {
      await execFileAsync(ffmpeg, ['-n', ...frameArgs], { timeout: 15000 })
      if (existsSync(tempPath)) {
        renameSync(tempPath, thumbPath)
        return thumbPath
      }
    } catch {
      // ignore
    }
  } finally {
    try { unlinkSync(tempPath) } catch { /* No partial thumbnail remains. */ }
  }
  return null
}
