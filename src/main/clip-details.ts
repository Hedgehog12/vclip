import { randomUUID } from 'crypto'
import { lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
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
