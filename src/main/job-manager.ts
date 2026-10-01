import { join } from 'path'
import { cancelJob as cancelRunningJob, startClipJob, type ClipJobConfig, type JobEventSink } from './pipeline-runner'
import { finishRunRecord, type ResumeStatus } from './run-history'
import { logger } from './logger'
import { queueThumbnailsForIdeas } from './thumbnail-generator'
import { parseJobOutput } from '../shared/job-output'
import { isActiveJobStatus, MAX_FINISHED_JOBS, MAX_PARALLEL_JOBS, type ClipJobRequest, type JobSnapshot, type JobStatus } from '../shared/jobs'

/**
 * Every clipping job in this app session: queued, running and finished. Up to
 * MAX_PARALLEL_JOBS run at once, each in its own bridge process; the rest wait
 * in FIFO order. The renderer mirrors this list through `jobs:update`
 * snapshots, sent to whichever window is open at the time, so a reload or a
 * reopened window picks the jobs back up with `jobs:list`.
 */

interface TrackedJob {
  snapshot: JobSnapshot
  config: ClipJobConfig
  outputDirectory: string
  /** Set for a render round: where the job returns if the round does not complete. */
  resumeStatus: ResumeStatus | null
}

const jobs = new Map<string, TrackedJob>()
const queue: string[] = []
/** Jobs whose bridge process has started and not yet exited. */
const running = new Set<string>()
let getSink: () => JobEventSink | null = () => null

export function initJobManager(windowGetter: () => JobEventSink | null): void {
  getSink = windowGetter
}

function broadcast(snapshot: JobSnapshot): void {
  const sink = getSink()
  if (sink && !sink.isDestroyed() && !sink.webContents.isDestroyed()) sink.webContents.send('jobs:update', snapshot)
}

function update(jobId: string, patch: Partial<Omit<JobSnapshot, 'id' | 'revision'>>): void {
  const job = jobs.get(jobId)
  if (!job) return
  job.snapshot = { ...job.snapshot, ...patch, revision: job.snapshot.revision + 1 }
  broadcast(job.snapshot)
}

type FinishStatus = Extract<JobStatus, 'completed' | 'failed' | 'cancelled' | 'awaiting_approval'>

function finish(jobId: string, status: FinishStatus, patch: Partial<JobSnapshot> = {}): void {
  const job = jobs.get(jobId)
  if (job) job.resumeStatus = null
  update(jobId, { ...patch, status, finishedAt: new Date().toISOString() })
  pruneFinished()
}

/** A render round that did not complete: the job goes back to where it was, with the error. */
function finishRound(job: TrackedJob, ended: 'failed' | 'cancelled', patch: Partial<JobSnapshot> = {}): void {
  const resume = job.resumeStatus
  if (!resume) return finish(job.snapshot.id, ended, patch)
  finish(job.snapshot.id, resume, {
    ...patch,
    ...(ended === 'cancelled' ? { error: null, errorHint: null } : {}),
    percent: 100,
    step: resume === 'awaiting_approval' ? 'Waiting for your approval' : 'Complete'
  })
}

function pruneFinished(): void {
  // Jobs waiting for approval stay listed until the user decides.
  const finished = [...jobs.values()].filter((job) => !isActiveJobStatus(job.snapshot.status) && job.snapshot.status !== 'awaiting_approval')
  for (const job of finished.slice(0, Math.max(0, finished.length - MAX_FINISHED_JOBS))) jobs.delete(job.snapshot.id)
}

/** The request as the user made it, without main-process additions. */
export function baseRequest(config: ClipJobConfig): ClipJobRequest {
  const request: ClipJobConfig = { ...config }
  delete request.plannerCapabilities
  delete request.phase
  delete request.approvedIdeaIds
  delete request.thumbnailIdeaIds
  delete request.hookIdeaIds
  return request
}

function newSnapshot(jobId: string, config: ClipJobConfig, outputDirectory: string, revision: number): JobSnapshot {
  return {
    id: jobId,
    revision,
    request: baseRequest(config),
    status: 'queued',
    percent: 0,
    step: 'Waiting for a free slot',
    clipsDone: 0,
    clipsTotal: 0,
    error: null,
    errorHint: null,
    failureCode: null,
    failureStage: null,
    httpStatus: null,
    output: null,
    outputDir: join(outputDirectory, jobId),
    queuedAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null
  }
}

/** Track a new job (its run record already exists) and start it as soon as a slot is free. */
export function enqueueJob(jobId: string, config: ClipJobConfig, outputDirectory: string): JobSnapshot {
  const snapshot = newSnapshot(jobId, config, outputDirectory, 0)
  jobs.set(jobId, { snapshot, config, outputDirectory, resumeStatus: null })
  queue.push(jobId)
  broadcast(snapshot)
  pump()
  return jobs.get(jobId)!.snapshot
}

/**
 * Queue a render round of a reviewed job (its run record is already marked
 * running). The job keeps its id, so the Jobs page shows one job throughout.
 */
export function enqueueRenderRound(jobId: string, config: ClipJobConfig, outputDirectory: string, resumeStatus: ResumeStatus): JobSnapshot {
  const existing = jobs.get(jobId)
  const snapshot = {
    ...newSnapshot(jobId, config, outputDirectory, existing ? existing.snapshot.revision + 1 : 0),
    step: 'Waiting to render your ideas',
    clipsTotal: config.approvedIdeaIds?.length ?? 0,
    output: existing?.snapshot.output ?? null
  }
  jobs.set(jobId, { snapshot, config, outputDirectory, resumeStatus })
  queue.push(jobId)
  broadcast(snapshot)
  pump()
  return jobs.get(jobId)!.snapshot
}

/** A render round for this job is queued or running, so its source must not be deleted. */
export function isJobBusy(jobId: string): boolean {
  const job = jobs.get(jobId)
  return Boolean(job && isActiveJobStatus(job.snapshot.status))
}

function pump(): void {
  while (running.size < MAX_PARALLEL_JOBS && queue.length > 0) {
    const jobId = queue.shift()!
    const job = jobs.get(jobId)
    if (!job || job.snapshot.status !== 'queued') continue
    running.add(jobId)
    update(jobId, { status: 'pending', step: 'Starting…', startedAt: new Date().toISOString() })
    logger.info('jobs.start', { jobId, running: running.size, queued: queue.length })
    const sink: JobEventSink = {
      isDestroyed: () => false,
      webContents: { isDestroyed: () => false, send: (channel, payload) => onRunnerEvent(jobId, channel, payload) }
    }
    try {
      startClipJob(jobId, job.config, sink, () => onExit(jobId), job.outputDirectory)
    } catch {
      running.delete(jobId)
      try { finishRunRecord(job.outputDirectory, jobId, 'failed', 'Could not start this run.') } catch { /* Output folder may be unavailable. */ }
      finishRound(job, 'failed', { error: 'Could not start this run.', step: 'Failed' })
    }
  }
}

function onExit(jobId: string): void {
  if (!running.delete(jobId)) return
  pump()
}

function onRunnerEvent(jobId: string, channel: string, payload: unknown): void {
  const job = jobs.get(jobId)
  if (!job || !isActiveJobStatus(job.snapshot.status)) return
  const data = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>
  const number = (value: unknown, fallback: number): number => (typeof value === 'number' && Number.isFinite(value) ? value : fallback)

  if (channel === 'job:progress') {
    const status = typeof data.status === 'string' && isActiveJobStatus(data.status) && data.status !== 'queued' ? data.status : job.snapshot.status
    update(jobId, {
      status,
      percent: Math.max(0, Math.min(100, number(data.percent, job.snapshot.percent))),
      step: typeof data.step === 'string' ? data.step : job.snapshot.step,
      clipsDone: number(data.clips_done, job.snapshot.clipsDone),
      clipsTotal: number(data.clips_total, job.snapshot.clipsTotal)
    })
  } else if (channel === 'job:awaiting') {
    finish(jobId, 'awaiting_approval', { percent: 100, step: 'Waiting for your approval', error: null, errorHint: null })
  } else if (channel === 'job:complete') {
    const output = parseJobOutput(data.output)
    if (output) {
      finish(jobId, 'completed', { output, percent: 100, step: 'Complete', clipsDone: output.total_clips, clipsTotal: output.total_clips })
      // The clips are usable now; thumbnails follow in the background and show on each clip card.
      const thumbnailIds = job.config.phase === 'render' ? job.config.thumbnailIdeaIds ?? [] : []
      if (thumbnailIds.length) {
        queueThumbnailsForIdeas(join(job.outputDirectory, jobId), thumbnailIds, job.outputDirectory)
          .catch(() => logger.warn('thumbnail.queueFailed', { jobId }))
      }
    } else {
      finishRound(job, 'failed', { error: 'The clipping engine returned an unsupported result.', step: 'Failed' })
    }
  } else if (channel === 'job:error') {
    finishRound(job, 'failed', {
      error: typeof data.message === 'string' ? data.message : 'The clipping engine stopped.',
      errorHint: typeof data.hint === 'string' ? data.hint : null,
      failureCode: typeof data.failureCode === 'string' ? data.failureCode : null,
      failureStage: typeof data.failureStage === 'string' ? data.failureStage : null,
      httpStatus: typeof data.httpStatus === 'number' ? data.httpStatus : null,
      step: 'Failed'
    })
  }
}

/** Cancel a queued or running job. Returns false when there is nothing to cancel. */
export function cancelTrackedJob(jobId: string): boolean {
  const job = jobs.get(jobId)
  if (!job || !isActiveJobStatus(job.snapshot.status)) return false
  if (job.snapshot.status === 'queued') {
    const index = queue.indexOf(jobId)
    if (index !== -1) queue.splice(index, 1)
    try { finishRunRecord(job.outputDirectory, jobId, 'cancelled') } catch { logger.warn('job.history.writeFailed', { jobId }) }
    finishRound(job, 'cancelled', { step: 'Cancelled' })
    return true
  }
  // The runner records the cancellation and stops the process group; its slot
  // frees when the process actually exits.
  if (!cancelRunningJob(jobId)) return false
  finishRound(job, 'cancelled', { step: 'Cancelled' })
  return true
}

/** Mark a job discarded after the user threw its ideas away. */
export function discardTrackedJob(jobId: string): void {
  const job = jobs.get(jobId)
  if (job && job.snapshot.status === 'awaiting_approval') finish(jobId, 'cancelled', { step: 'Discarded' })
}

/** Drop a finished job from this session's list (its run folder stays on disk). */
export function dismissJob(jobId: string): boolean {
  const job = jobs.get(jobId)
  if (!job || isActiveJobStatus(job.snapshot.status) || job.snapshot.status === 'awaiting_approval') return false
  jobs.delete(jobId)
  return true
}

export function listJobs(): JobSnapshot[] {
  return [...jobs.values()].map((job) => job.snapshot).reverse()
}

/** Queued and running job IDs, so run history can tell live runs from interrupted ones. */
export function liveJobIds(): ReadonlySet<string> {
  return new Set([...jobs.values()].filter((job) => isActiveJobStatus(job.snapshot.status)).map((job) => job.snapshot.id))
}

/** On quit, queued jobs will never start: record them as cancelled rather than interrupted. */
export function cancelQueuedJobsForQuit(): void {
  for (const jobId of queue.splice(0)) {
    const job = jobs.get(jobId)
    if (!job) continue
    try { finishRunRecord(job.outputDirectory, jobId, 'cancelled') } catch { /* Quitting anyway. */ }
  }
}
