import { twitchVodId } from '../shared/video-source'
import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { basename, isAbsolute, join, relative, sep } from 'path'
import { randomUUID } from 'crypto'
import { sameFile } from './file-identity'

export type StoredRunStatus = 'running' | 'awaiting_approval' | 'completed' | 'failed' | 'cancelled'
/** Where a render round returns to when it is cancelled, fails or is interrupted. */
export type ResumeStatus = 'awaiting_approval' | 'completed'
export type StoredDecision = 'approved' | 'rejected'

export interface RunRecord {
  jobId: string
  startedAt: string
  finishedAt: string | null
  sourceLabel: string
  status: StoredRunStatus
  errorMessage: string | null
  failureCode?: string | null
  failureStage?: string | null
  httpStatus?: number | null
  /** The validated job request, so a review can be rendered after a restart. Re-validate before use. */
  request?: unknown
  /** Idea review decisions by idea id. */
  decisions?: Record<string, StoredDecision>
  /** Set while a render round runs: the state to return to if it does not complete. */
  resumeStatus?: ResumeStatus | null
}

const RUN_FILE = 'run-history.json'
const MAX_RECORD_BYTES = 32 * 1024
const STATUSES: readonly StoredRunStatus[] = ['running', 'awaiting_approval', 'completed', 'failed', 'cancelled']
const IDEA_ID = /^idea-\d{2,3}$/
const MAX_DECISIONS = 200
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function runDirectory(baseDir: string, jobId: string): string {
  if (!UUID.test(jobId)) throw new Error('Invalid run identifier')
  return join(baseDir, jobId)
}

function checkedDirectory(baseDir: string, jobId: string): string {
  const dir = runDirectory(baseDir, jobId)
  const stat = lstatSync(dir)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid run directory')
  const rel = relative(realpathSync(baseDir), realpathSync(dir))
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('Run is outside the output folder')
  return dir
}

function sourceLabel(source: string): string {
  const twitchId = twitchVodId(source)
  if (twitchId) return `Twitch VOD · ${twitchId}`.slice(0, 160)
  let label: string
  try {
    const url = new URL(source)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Local source')
    const host = url.hostname.toLowerCase()
    const videoId = (host === 'youtube.com' || host === 'www.youtube.com' || host === 'm.youtube.com') && url.pathname === '/watch'
      ? url.searchParams.get('v') : null
    label = videoId && /^[a-zA-Z0-9_-]{11}$/.test(videoId) ? `YouTube · ${videoId}` : host
  } catch {
    label = basename(source)
  }
  return Array.from(label, (character) => {
    const code = character.charCodeAt(0)
    return code < 32 || code === 127 ? ' ' : character
  }).join('').trim().slice(0, 160) || 'Video source'
}

function validDate(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value))
}

function validDecisions(value: unknown): value is Record<string, StoredDecision> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const entries = Object.entries(value)
  return entries.length <= MAX_DECISIONS &&
    entries.every(([id, decision]) => IDEA_ID.test(id) && (decision === 'approved' || decision === 'rejected'))
}

export function readRunRecord(baseDir: string, jobId: string): RunRecord | null {
  let fd: number | null = null
  try {
    const dir = checkedDirectory(baseDir, jobId)
    const file = join(dir, RUN_FILE)
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > MAX_RECORD_BYTES) return null
    const fileStat = lstatSync(file)
    if (fileStat.isSymbolicLink() || !sameFile(fileStat, stat)) return null
    const data: unknown = JSON.parse(readFileSync(fd, 'utf8'))
    if (!data || typeof data !== 'object') return null
    const record = data as Partial<RunRecord>
    if (record.jobId !== jobId || !validDate(record.startedAt) ||
        (record.finishedAt !== null && !validDate(record.finishedAt)) ||
        typeof record.sourceLabel !== 'string' || record.sourceLabel.length > 160 ||
        !STATUSES.includes(record.status as StoredRunStatus) ||
        (record.request !== undefined && (!record.request || typeof record.request !== 'object' || Array.isArray(record.request))) ||
        (record.decisions !== undefined && !validDecisions(record.decisions)) ||
        (record.resumeStatus != null && record.resumeStatus !== 'awaiting_approval' && record.resumeStatus !== 'completed') ||
        (record.errorMessage !== null && (typeof record.errorMessage !== 'string' || record.errorMessage.length > 300)) ||
        (record.failureCode != null && (typeof record.failureCode !== 'string' || !/^[a-z]+(?:[._][a-z]+)*$/.test(record.failureCode) || record.failureCode.length > 64)) ||
        (record.failureStage != null && !['setup', 'download', 'transcription', 'planning', 'rendering', 'saving', 'uploading'].includes(record.failureStage)) ||
        (record.httpStatus != null && (!Number.isInteger(record.httpStatus) || record.httpStatus < 100 || record.httpStatus > 599))) return null
    return record as RunRecord
  } catch {
    return null
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

function writeRunRecord(baseDir: string, record: RunRecord): void {
  const dir = checkedDirectory(baseDir, record.jobId)
  const temp = join(dir, `${RUN_FILE}.${randomUUID()}.tmp`)
  try {
    writeFileSync(temp, JSON.stringify(record), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    renameSync(temp, join(dir, RUN_FILE))
  } finally {
    try { unlinkSync(temp) } catch { /* The rename already moved it. */ }
  }
}

export function createRunRecord(baseDir: string, jobId: string, source: string, request?: object): void {
  mkdirSync(runDirectory(baseDir, jobId), { recursive: true, mode: 0o700 })
  writeRunRecord(baseDir, {
    jobId,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    sourceLabel: sourceLabel(source),
    status: 'running',
    errorMessage: null,
    ...(request ? { request } : {})
  })
}

/**
 * End the running part of a run. A render round that fails or is cancelled
 * returns the run to where it was (waiting for approval, or done with more
 * ideas left) with the failure message, so its ideas are never lost.
 */
export function finishRunRecord(baseDir: string, jobId: string, status: Exclude<StoredRunStatus, 'running'>, errorMessage: string | null = null,
  details: Pick<RunRecord, 'failureCode' | 'failureStage' | 'httpStatus'> = {}): void {
  const previous = readRunRecord(baseDir, jobId)
  if (!previous || previous.status !== 'running') return
  const resume = previous.resumeStatus
  const next: StoredRunStatus = resume && (status === 'failed' || status === 'cancelled') ? resume : status
  writeRunRecord(baseDir, {
    ...previous,
    status: next,
    resumeStatus: null,
    finishedAt: new Date().toISOString(),
    errorMessage: status === 'cancelled' && resume ? null : errorMessage,
    ...details
  })
}

/** Start a render round of a reviewed run. Returns false when the run is not reviewable. */
export function beginRenderRound(baseDir: string, jobId: string): ResumeStatus | null {
  const previous = readRunRecord(baseDir, jobId)
  if (!previous || (previous.status !== 'awaiting_approval' && previous.status !== 'completed')) return null
  writeRunRecord(baseDir, {
    ...previous, status: 'running', resumeStatus: previous.status, errorMessage: null,
    failureCode: null, failureStage: null, httpStatus: null
  })
  return previous.status
}

export function saveDecisions(baseDir: string, jobId: string, decisions: Record<string, StoredDecision>): boolean {
  const previous = readRunRecord(baseDir, jobId)
  if (!previous || !validDecisions(decisions)) return false
  writeRunRecord(baseDir, { ...previous, decisions })
  return true
}

/** Discard a run that is waiting for approval. A finished run keeps its status. */
export function discardRunRecord(baseDir: string, jobId: string): void {
  const previous = readRunRecord(baseDir, jobId)
  if (!previous || previous.status !== 'awaiting_approval') return
  writeRunRecord(baseDir, { ...previous, status: 'cancelled', finishedAt: new Date().toISOString() })
}
