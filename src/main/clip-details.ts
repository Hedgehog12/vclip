import { randomUUID } from 'crypto'
import { lstatSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { basename, join } from 'path'
import { parseJobOutput, type ClipArtifact } from '../shared/job-output'
import { resolveRunClip } from './thumbnail-generator'

const MAX_JOB_OUTPUT_BYTES = 20 * 1024 * 1024
export const MAX_CLIP_TITLE = 200
export const MAX_CLIP_DESCRIPTION = 5000

export interface ClipDetailsUpdate {
  title: string
  description: string
}

function cleanText(value: unknown, max: number, field: string): string {
  if (typeof value !== 'string' || value.includes('\0')) throw new Error(`Invalid ${field}`)
  const text = value.replace(/\r\n/g, '\n').trim()
  if (text.length > max) throw new Error(`The ${field} can be at most ${max} characters.`)
  return text
}

/**
 * Change a rendered clip's title and description in its run's
 * job_output.json, so the Library, posting and automations all see the new
 * text. Everything else in the file is kept as the engine wrote it.
 */
export function updateClipDetails(clipPath: unknown, update: unknown, libraryDir: string): ClipArtifact {
  const { runDir, name } = resolveRunClip(clipPath, libraryDir)
  const raw = (update && typeof update === 'object' ? update : {}) as Record<string, unknown>
  const title = cleanText(raw.title, MAX_CLIP_TITLE, 'title')
  const description = cleanText(raw.description, MAX_CLIP_DESCRIPTION, 'description')
  if (!title) throw new Error('Give the clip a title.')

  const path = join(runDir, 'job_output.json')
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_JOB_OUTPUT_BYTES) throw new Error('This run’s clip list could not be read.')
  const data = JSON.parse(readFileSync(path, 'utf8')) as { clips?: Record<string, unknown>[] }
  const clip = Array.isArray(data.clips)
    ? data.clips.find((entry) => typeof entry?.s3_url === 'string' && basename(entry.s3_url.replace(/^file:\/\//, '')) === name)
    : undefined
  if (!clip) throw new Error('This clip is not part of a finished run')
  clip.summary = title
  clip.description = description || null

  const parsed = parseJobOutput(data)
  if (!parsed) throw new Error('This run’s clip list could not be updated.')
  const temp = join(runDir, `.job_output.${randomUUID()}.tmp`)
  try {
    writeFileSync(temp, JSON.stringify(data, null, 2), { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    renameSync(temp, path)
  } finally {
    rmSync(temp, { force: true })
  }
  return parsed.clips.find((entry) => basename(entry.s3_url.replace(/^file:\/\//, '')) === name)!
}

export interface DeleteClipsResult {
  /** Clips moved to the Recycle Bin and taken off their run's clip list. */
  deleted: string[]
  /** Clips that could not be moved, with why. */
  failed: { path: string; error: string }[]
}

/**
 * Move rendered clips to the Recycle Bin (clip_XX.mp4 and every clip_XX.*
 * beside it: thumbnail, subtitles) and drop them from their run's
 * job_output.json. A clip whose files can't all be moved stays listed.
 */
export async function deleteClips(
  clipPaths: unknown,
  libraryDir: string,
  trash: (path: string) => Promise<void>,
  isBusy: (runId: string) => boolean = () => false
): Promise<DeleteClipsResult> {
  if (!Array.isArray(clipPaths) || clipPaths.length === 0 || clipPaths.length > 500) throw new Error('Choose the clips to delete.')
  const result: DeleteClipsResult = { deleted: [], failed: [] }
  const byRun = new Map<string, { path: string; name: string }[]>()
  for (const path of clipPaths) {
    try {
      const { runDir, name } = resolveRunClip(path, libraryDir)
      if (isBusy(basename(runDir))) throw new Error('This job is rendering. Wait until it finishes.')
      byRun.set(runDir, [...(byRun.get(runDir) ?? []), { path: String(path), name }])
    } catch (error) {
      result.failed.push({ path: String(path), error: error instanceof Error ? error.message : 'Not a clip of the Library.' })
    }
  }

  for (const [runDir, clips] of byRun) {
    const removed = new Set<string>()
    const files = readdirSync(runDir)
    for (const clip of clips) {
      const stem = clip.name.replace(/\.[^.]+$/, '')
      try {
        for (const file of files.filter((f) => f === clip.name || f.startsWith(`${stem}.`))) await trash(join(runDir, file))
        removed.add(clip.name)
        result.deleted.push(clip.path)
      } catch {
        result.failed.push({ path: clip.path, error: 'Could not move the clip to the Recycle Bin. Is it open in another app?' })
      }
    }
    if (removed.size > 0) removeFromClipList(runDir, removed)
  }
  return result
}

/** Take clips off a run's job_output.json, keeping everything else as written. */
function removeFromClipList(runDir: string, names: Set<string>): void {
  const path = join(runDir, 'job_output.json')
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_JOB_OUTPUT_BYTES) throw new Error('This run’s clip list could not be read.')
  const data = JSON.parse(readFileSync(path, 'utf8')) as { clips?: Record<string, unknown>[]; total_clips?: unknown }
  if (!Array.isArray(data.clips)) return
  data.clips = data.clips.filter((entry) => !(typeof entry?.s3_url === 'string' && names.has(basename(entry.s3_url.replace(/^file:\/\//, '')))))
  if (typeof data.total_clips === 'number') data.total_clips = data.clips.length
  if (!parseJobOutput(data)) throw new Error('This run’s clip list could not be updated.')
  const temp = join(runDir, `.job_output.${randomUUID()}.tmp`)
  try {
    writeFileSync(temp, JSON.stringify(data, null, 2), { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    renameSync(temp, path)
  } finally {
    rmSync(temp, { force: true })
  }
}
