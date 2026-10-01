import type { JobOutput } from './job-output'

/** Options for one clipping run, as the Create wizard submits them. */
export interface ClipJobRequest {
  videoUrl: string
  /** Missing on older queued requests; those retain the original quality mode. */
  clippingMode?: 'quality' | 'economy' | 'advanced'
  /** Required in Advanced mode; presets choose their own models. */
  plannerModel?: string
  transcriptionModel?: string
  maxClips: number | null
  autoClipCount: boolean
  durationRanges: string[] | null
  aspectRatio: string
  layoutStyle: string
  layoutVision: boolean
  pacing: string
  /** Export speed for every clip. Older requests default to normal speed. */
  videoSpeed?: number
  includeCaptions: boolean
  captionPreset: string
  startTimeSeconds: number | null
  endTimeSeconds: number | null
  bannerPlatform: string | null
  bannerChannelUrl: string | null
}

/** How many clipping runs the main process lets run at once; the rest wait in a queue. */
export const MAX_PARALLEL_JOBS = 2
/** Finished runs retained in the live session; older runs remain on disk. */
export const MAX_FINISHED_JOBS = 50

export type ActiveJobStatus = 'queued' | 'pending' | 'downloading' | 'transcribing' | 'planning' | 'rendering' | 'uploading'
export type TerminalJobStatus = 'completed' | 'failed' | 'cancelled'
/** Ideas are ready: the job holds no slot and waits for the user to approve some. */
export type AwaitingJobStatus = 'awaiting_approval'
export type JobStatus = ActiveJobStatus | TerminalJobStatus | AwaitingJobStatus

export const ACTIVE_JOB_STATUSES: readonly ActiveJobStatus[] = ['queued', 'pending', 'downloading', 'transcribing', 'planning', 'rendering', 'uploading']

export function isActiveJobStatus(status: string): status is ActiveJobStatus {
  return (ACTIVE_JOB_STATUSES as readonly string[]).includes(status)
}

/** Idea ids as the engine writes them (idea-01 …). */
export const IDEA_ID_PATTERN = /^idea-\d{2,3}$/
export const MAX_IDEAS_PER_RENDER = 100

export type IdeaDecision = 'approved' | 'rejected'

export interface ReviewIdea {
  id: string
  rank: number
  recommended: boolean
  rendered: boolean
  clipIndex: number | null
  title: string
  pitch: string | null
  description: string | null
  excerpt: string
  scores: Partial<Record<'hook' | 'standalone' | 'arc' | 'quotability' | 'ending', number>>
  viralityScore: number
  startMs: number
  endMs: number
  /** Longform tangents the render cuts out, in source ms. */
  skipRanges: [number, number][]
  tags: string[]
  /**
   * A line from inside the clip that can play first as a hook (cold open),
   * proposed by the AI. Null when the clip already opens strongly.
   */
  hook: { startMs: number; endMs: number; text: string } | null
}

export interface JobReview {
  jobId: string
  status: 'awaiting_approval' | 'completed' | 'cancelled' | 'failed'
  /** A render round for this job is queued or running. */
  busy: boolean
  videoTitle: string
  /** How many ideas the user asked for, or all of them when the AI decided. */
  recommendedCount: number
  autoClipCount: boolean
  ideas: ReviewIdea[]
  decisions: Record<string, IdeaDecision>
  /** Absolute path of a playable source, or null when it is gone. */
  sourcePath: string | null
  sourceDownloaded: boolean
  sourceBytes: number | null
  /** The last render round's failure, shown until the next round. */
  lastError: string | null
}

export interface RunStorage {
  jobId: string
  videoTitle: string
  date: string
  status: string
  outputDir: string
  /** The downloaded stream kept for more ideas; 0 when deleted or never downloaded. */
  sourceBytes: number
  /** The job used the user's own file, which the app never deletes or counts. */
  sourceIsUserFile: boolean
  clipBytes: number
  otherBytes: number
  totalBytes: number
  busy: boolean
}

export interface StorageUsage {
  runs: RunStorage[]
  totalBytes: number
  sourceBytes: number
}

/**
 * A job as the main process tracks it. The main process owns the list and
 * pushes a fresh snapshot on every change (`jobs:update`); `revision` only goes
 * up, so the renderer can drop a snapshot that arrives after a newer one.
 */
export interface JobSnapshot {
  id: string
  revision: number
  request: ClipJobRequest
  status: JobStatus
  percent: number
  step: string
  clipsDone: number
  clipsTotal: number
  error: string | null
  /** Suggested fix, when the main process can tell what went wrong. */
  errorHint: string | null
  failureCode?: string | null
  failureStage?: string | null
  httpStatus?: number | null
  output: JobOutput | null
  /** The run folder inside the output directory. */
  outputDir: string
  queuedAt: string
  startedAt: string | null
  finishedAt: string | null
}
