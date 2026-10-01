import { execFile } from 'child_process'
import { randomUUID } from 'crypto'
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'fs'
import { basename, dirname, join } from 'path'
import { promisify } from 'util'
import { loadSettings } from './settings-store'
import { getJobOutput } from './file-manager'
import { readSavedReview } from './review-store'
import { readResponseText } from './http-response'
import { resolveBinary } from './tools'
import { isWithinDirectory } from './security'
import { logger } from './logger'
import { fillThumbnailPrompt } from '../shared/thumbnail-prompt'

/**
 * AI thumbnails: three real frames of a rendered clip plus the user's prompt
 * go to an OpenRouter image model, and the image comes back as
 * clip_XX.thumbnail.<png|jpg|webp> beside the clip. Per-clip status lives in
 * the run folder's thumbnails.json so the Library can show pending, ready or
 * failed after a restart. Work runs one clip at a time, off the main thread.
 */

const execFileAsync = promisify(execFile)
const OPENROUTER = 'https://openrouter.ai/api/v1'
const STATUS_FILE = 'thumbnails.json'
const CLIP_NAME = /^(clip_\d{2,})\.mp4$/
const MAX_IMAGE_RESPONSE_BYTES = 40 * 1024 * 1024
const REQUEST_TIMEOUT_MS = 180_000
const FRAME_POSITIONS = [0.25, 0.5, 0.75]

export type ThumbnailStatus = 'pending' | 'ready' | 'failed'

export interface ThumbnailState {
  status: ThumbnailStatus
  /** Absolute path of the image when ready. */
  path?: string
  error?: string
  model?: string
  costUsd?: number
  updatedAt: string
}

interface StatusFile {
  version: 1
  clips: Record<string, ThumbnailState>
}

interface ClipContext {
  clipPath: string
  runDir: string
  name: string
  durationMs: number
  title: string
  pitch: string
  description: string
  vertical: boolean
}

const inFlight = new Set<string>()
let tail: Promise<unknown> = Promise.resolve()

// ── Status file ──────────────────────────────────────────────────────────────

function readStatusFile(runDir: string): StatusFile {
  try {
    const path = join(runDir, STATUS_FILE)
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) return { version: 1, clips: {} }
    const data = JSON.parse(readFileSync(path, 'utf8')) as Partial<StatusFile>
    if (data?.version !== 1 || !data.clips || typeof data.clips !== 'object') return { version: 1, clips: {} }
    return { version: 1, clips: data.clips }
  } catch {
    return { version: 1, clips: {} }
  }
}

function writeState(runDir: string, name: string, state: Omit<ThumbnailState, 'updatedAt'>): void {
  const file = readStatusFile(runDir)
  file.clips[name] = { ...state, updatedAt: new Date().toISOString() }
  const path = join(runDir, STATUS_FILE)
  const temp = join(runDir, `.${STATUS_FILE}.${randomUUID()}.tmp`)
  try {
    writeFileSync(temp, JSON.stringify(file, null, 2), { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    renameSync(temp, path)
  } finally {
    rmSync(temp, { force: true })
  }
}

// ── Clip lookup ──────────────────────────────────────────────────────────────

/** A rendered clip file (clip_01.mp4) inside a run folder of the library. */
export function resolveRunClip(clipPath: unknown, libraryDir: string): { canonical: string; runDir: string; name: string } {
  if (typeof clipPath !== 'string' || !CLIP_NAME.test(basename(clipPath))) throw new Error('Not a rendered clip')
  const canonical = realpathSync(clipPath)
  const stat = lstatSync(canonical)
  if (!stat.isFile() || !CLIP_NAME.test(basename(canonical)) || !isWithinDirectory(canonical, libraryDir)) {
    throw new Error('Clip is outside the library')
  }
  return { canonical, runDir: dirname(canonical), name: basename(canonical) }
}

/** A rendered clip of a run in the library, with the text the prompt needs. */
async function clipContext(clipPath: unknown, libraryDir: string): Promise<ClipContext> {
  const { canonical, runDir, name } = resolveRunClip(clipPath, libraryDir)
  const output = await getJobOutput(runDir, libraryDir)
  const clip = output?.clips.find((entry) => basename(entry.s3_url.replace(/^file:\/\//, '')) === name)
  if (!output || !clip) throw new Error('This clip is not part of a finished run')
  const review = readSavedReview(libraryDir, basename(runDir))
  const idea = clip.idea_id ? review?.ideas.find((entry) => entry.id === clip.idea_id) : undefined
  const requested = output.metrics?.requested_settings as Record<string, unknown> | undefined
  return {
    clipPath: canonical,
    runDir,
    name,
    durationMs: clip.duration_ms,
    title: (clip.summary || idea?.title || output.source_video_title || 'Untitled').slice(0, 200),
    // The clip's own description wins: the user may have edited it in the Library.
    pitch: (idea?.pitch || clip.description || clip.summary || '').slice(0, 600),
    description: (clip.description || idea?.description || clip.tags.join(', ') || '').slice(0, 1500),
    vertical: requested?.aspect_ratio !== '16:9'
  }
}

/** Thumbnail files for a clip: clip_01.thumbnail.png and friends. */
function thumbnailFiles(runDir: string, name: string): string[] {
  const stem = name.replace(/\.mp4$/, '')
  try {
    return readdirSync(runDir).filter((file) => new RegExp(`^${stem}\\.thumbnail\\.(png|jpg|webp)$`).test(file)).map((file) => join(runDir, file))
  } catch { return [] }
}

// ── Frames ───────────────────────────────────────────────────────────────────

async function extractFrames(clipPath: string, durationMs: number): Promise<Buffer[]> {
  const seconds = durationMs > 0 ? durationMs / 1000 : 0
  const frames: Buffer[] = []
  for (const position of FRAME_POSITIONS) {
    const args = [
      '-v', 'error', '-nostdin',
      ...(seconds > 1 ? ['-ss', (seconds * position).toFixed(2)] : []),
      '-protocol_whitelist', 'file,pipe,fd', '-format_whitelist', 'mov,matroska,webm,avi,flv',
      '-i', clipPath, '-frames:v', '1', '-vf', 'scale=1024:-2', '-q:v', '3', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1'
    ]
    try {
      const { stdout } = await execFileAsync(resolveBinary('ffmpeg'), args, { encoding: 'buffer', timeout: 30_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true })
      if (stdout.length > 0) frames.push(stdout)
    } catch { /* A frame near the end can fail; the others are enough. */ }
  }
  if (!frames.length) throw new Error('Could not read frames from this clip')
  return frames
}

// ── OpenRouter ───────────────────────────────────────────────────────────────

function imageType(bytes: Buffer): 'png' | 'jpg' | 'webp' | null {
  if (bytes.length > 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png'
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg'
  if (bytes.length > 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'webp'
  return null
}

function fromDataUrl(value: unknown): Buffer | null {
  if (typeof value !== 'string') return null
  const match = /^data:image\/[a-z+.-]+;base64,([A-Za-z0-9+/=\s]+)$/i.exec(value)
  return match ? Buffer.from(match[1], 'base64') : null
}

/** The provider's own error text, trimmed; never the whole body. */
function providerError(body: string, status: number): string {
  try {
    const message = (JSON.parse(body) as { error?: { message?: unknown } }).error?.message
    if (typeof message === 'string' && message.trim()) return `OpenRouter: ${message.trim().slice(0, 240)}`
  } catch { /* Not JSON. */ }
  if (status === 401 || status === 403) return 'OpenRouter rejected the API key. Check it in Settings.'
  if (status === 402) return 'Your OpenRouter balance is too low for this image model.'
  if (status === 429) return 'OpenRouter is rate limiting requests. Try again in a minute.'
  return `OpenRouter returned an error (${status}).`
}

interface ImageResult { bytes: Buffer; costUsd?: number }

async function post(path: string, apiKey: string, payload: unknown): Promise<{ status: number; body: string }> {
  const response = await fetch(`${OPENROUTER}${path}`, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-Title': 'VlasiichukClip'
    },
    body: JSON.stringify(payload)
  })
  const body = await readResponseText(response, MAX_IMAGE_RESPONSE_BYTES, 'The image model returned a response that is too large.')
  return { status: response.status, body }
}

function cost(usage: unknown): number | undefined {
  const value = (usage as { cost?: unknown } | undefined)?.cost
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/**
 * The Images API first; models only served through chat completions (for
 * example some Gemini image models) are retried there.
 */
export async function requestThumbnailImage(apiKey: string, model: string, prompt: string, frames: Buffer[], vertical: boolean): Promise<ImageResult> {
  const references = frames.map((frame) => ({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${frame.toString('base64')}` } }))
  const aspect = vertical ? '9:16' : '16:9'

  const images = await post('/images', apiKey, { model, prompt, n: 1, aspect_ratio: aspect, input_references: references })
  if (images.status >= 200 && images.status < 300) {
    const data = JSON.parse(images.body) as { data?: { b64_json?: unknown }[]; usage?: unknown }
    const b64 = data.data?.[0]?.b64_json
    if (typeof b64 === 'string' && b64) return { bytes: Buffer.from(b64, 'base64'), costUsd: cost(data.usage) }
    throw new Error('The image model returned no image.')
  }
  if (![400, 404, 405, 422].includes(images.status)) throw new Error(providerError(images.body, images.status))

  const chat = await post('/chat/completions', apiKey, {
    model,
    modalities: ['image', 'text'],
    image_config: { aspect_ratio: aspect },
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, ...references] }]
  })
  if (chat.status < 200 || chat.status >= 300) throw new Error(providerError(chat.body, chat.status))
  const data = JSON.parse(chat.body) as { choices?: { message?: { images?: { image_url?: { url?: unknown } }[] } }[]; usage?: unknown }
  const bytes = fromDataUrl(data.choices?.[0]?.message?.images?.[0]?.image_url?.url)
  if (!bytes) throw new Error('The image model returned no image. Choose a different thumbnail model in Settings.')
  return { bytes, costUsd: cost(data.usage) }
}

// ── Generation ───────────────────────────────────────────────────────────────

/** Write the image as the clip's only thumbnail and mark it ready. */
function saveThumbnail(runDir: string, name: string, bytes: Buffer, info: { model: string; costUsd?: number }): string {
  const type = imageType(bytes)
  if (!type) throw new Error('That file is not a PNG, JPEG or WebP image.')
  const target = join(runDir, `${name.replace(/\.mp4$/, '')}.thumbnail.${type}`)
  const temp = join(runDir, `.${basename(target)}.${randomUUID()}.tmp`)
  try {
    writeFileSync(temp, bytes, { flag: 'wx', mode: 0o600 })
    for (const old of thumbnailFiles(runDir, name)) if (old !== target) rmSync(old, { force: true })
    renameSync(temp, target)
  } finally {
    rmSync(temp, { force: true })
  }
  writeState(runDir, name, { status: 'ready', path: target, ...info })
  return target
}

/** The largest picture accepted as a custom thumbnail. */
export const MAX_CUSTOM_THUMBNAIL_BYTES = 20 * 1024 * 1024

/** Use the user's own picture as the clip's thumbnail. */
export function setCustomThumbnail(clipPath: unknown, imagePath: string, libraryDir: string): ThumbnailState {
  const { canonical, runDir, name } = resolveRunClip(clipPath, libraryDir)
  if (inFlight.has(canonical)) throw new Error('A thumbnail is being made for this clip. Wait until it finishes.')
  const stat = lstatSync(imagePath)
  if (!stat.isFile() || stat.size > MAX_CUSTOM_THUMBNAIL_BYTES) throw new Error('Choose a picture smaller than 20 MB.')
  saveThumbnail(runDir, name, readFileSync(imagePath), { model: 'custom' })
  logger.info('thumbnail.custom', { clip: name })
  return readStatusFile(runDir).clips[name]
}

async function generate(context: ClipContext): Promise<void> {
  let model: string | undefined
  try {
    const settings = loadSettings()
    model = settings.thumbnailModel
    if (!settings.openrouterApiKey) throw new Error('Add your OpenRouter key in Settings to create thumbnails.')
    const frames = await extractFrames(context.clipPath, context.durationMs)
    const prompt = fillThumbnailPrompt(settings.thumbnailPrompt, {
      title: context.title,
      pitch: context.pitch,
      description: context.description,
      format: context.vertical ? 'vertical 9:16, for YouTube Shorts, Reels and TikTok' : 'horizontal 16:9, for YouTube'
    })
    const result = await requestThumbnailImage(settings.openrouterApiKey, model, prompt, frames, context.vertical)
    if (!imageType(result.bytes)) throw new Error('The image model returned a file that is not an image.')
    saveThumbnail(context.runDir, context.name, result.bytes, { model, costUsd: result.costUsd })
    logger.info('thumbnail.ready', { clip: context.name, model, costUsd: result.costUsd ?? null })
  } catch (error) {
    const message = error instanceof Error && error.name !== 'TimeoutError' && error.name !== 'AbortError'
      ? error.message.slice(0, 300) : 'The image model took too long to answer. Try again.'
    // A failed regenerate keeps the thumbnail that was already there.
    const previous = thumbnailFiles(context.runDir, context.name)[0]
    writeState(context.runDir, context.name, previous
      ? { status: 'ready', path: previous, error: message, model }
      : { status: 'failed', error: message, model })
    logger.warn('thumbnail.failed', { clip: context.name, model, error: message })
  }
}

/** Queue a clip for an AI thumbnail. Resolves once it is queued, not when done. */
export async function queueThumbnail(clipPath: unknown, libraryDir: string): Promise<ThumbnailState> {
  const context = await clipContext(clipPath, libraryDir)
  if (inFlight.has(context.clipPath)) return thumbnailStatusFor(context)
  writeState(context.runDir, context.name, { status: 'pending', model: loadSettings().thumbnailModel })
  inFlight.add(context.clipPath)
  // One clip's failure (even writing its status) must never stop the queue.
  tail = tail
    .then(() => generate(context))
    .catch((error) => logger.error('thumbnail.crashed', { clip: context.name, error: error instanceof Error ? error.message : 'unknown' }))
    .finally(() => inFlight.delete(context.clipPath))
  return thumbnailStatusFor(context)
}

/** Queue thumbnails for the clips a render round made from the given ideas. */
export async function queueThumbnailsForIdeas(runDir: string, ideaIds: readonly string[], libraryDir: string): Promise<void> {
  if (!ideaIds.length) return
  const output = await getJobOutput(runDir, libraryDir)
  const wanted = new Set(ideaIds)
  for (const clip of output?.clips ?? []) {
    if (!clip.idea_id || !wanted.has(clip.idea_id)) continue
    try { await queueThumbnail(join(runDir, basename(clip.s3_url.replace(/^file:\/\//, ''))), libraryDir) }
    catch (error) { logger.warn('thumbnail.queueFailed', { idea: clip.idea_id, error: error instanceof Error ? error.message : 'unknown' }) }
  }
}

function thumbnailStatusFor(context: ClipContext): ThumbnailState {
  const state = readStatusFile(context.runDir).clips[context.name]
  if (!state) {
    // A thumbnail made before the status file existed, or copied in by hand.
    const file = thumbnailFiles(context.runDir, context.name)[0]
    return file ? { status: 'ready', path: file, updatedAt: new Date(0).toISOString() } : { status: 'failed', updatedAt: new Date(0).toISOString() }
  }
  if (state.status === 'pending' && !inFlight.has(context.clipPath)) {
    return { ...state, status: 'failed', error: 'Interrupted when the app closed. Try again.' }
  }
  if (state.status === 'ready' && !(state.path && existsSync(state.path) && isWithinDirectory(state.path, context.runDir))) {
    return { status: 'failed', error: 'The thumbnail file was removed.', updatedAt: state.updatedAt }
  }
  return state
}

/**
 * The AI thumbnail state of a clip, or null when none was ever requested.
 * `failed` without an error means "not made yet".
 */
export async function thumbnailStatus(clipPath: unknown, libraryDir: string): Promise<ThumbnailState | null> {
  const context = await clipContext(clipPath, libraryDir)
  const state = thumbnailStatusFor(context)
  return state.status === 'failed' && !state.error ? null : state
}
