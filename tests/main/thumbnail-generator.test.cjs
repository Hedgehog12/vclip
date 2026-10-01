const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const vm = require('node:vm')
const util = require('node:util')
const ts = require('typescript')

function transpile(file) {
  const source = fs.readFileSync(path.join(__dirname, '../../src', file), 'utf8')
  return ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
}

function loadModule(file, mocks = {}, globals = {}) {
  const module = { exports: {} }
  vm.runInNewContext(transpile(file), {
    module, exports: module.exports, require: (id) => mocks[id] ?? require(id),
    URL, Set, Map, process, Buffer, console, setTimeout, clearTimeout, AbortSignal, Response, ...globals
  })
  return module.exports
}

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)])
const JPEG_FRAME = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])

/** A run folder with one rendered clip, and a generator wired to fake ffmpeg, OpenRouter and settings. */
function setup(respond) {
  const library = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vlasiichukclip-thumbs-')))
  const runDir = path.join(library, '11111111-2222-4333-8444-555555555555')
  fs.mkdirSync(runDir)
  const clip = path.join(runDir, 'clip_01.mp4')
  fs.writeFileSync(clip, 'video')
  const requests = []
  const ffmpegCalls = []
  const execFile = () => { throw new Error('use the promisified form') }
  execFile[util.promisify.custom] = async (command, args) => {
    ffmpegCalls.push(args)
    return { stdout: JPEG_FRAME, stderr: Buffer.alloc(0) }
  }
  const settings = { openrouterApiKey: 'sk-or-test', thumbnailModel: 'google/gemini-3.1-flash-image', thumbnailPrompt: 'Title={title} Pitch={pitch} Format={format} Keep={unknown}' }
  const output = {
    job_id: 'x', source_video_title: 'Stream', metrics: { requested_settings: { aspect_ratio: '9:16' } },
    clips: [{ clip_index: 1, s3_url: `file://${clip}`, duration_ms: 40000, summary: 'I tried 5 AI models', tags: ['ai'], idea_id: 'idea-02' }]
  }
  const generator = loadModule('main/thumbnail-generator.ts', {
    child_process: { execFile },
    './settings-store': { loadSettings: () => settings },
    './file-manager': { getJobOutput: async (dir) => (dir === runDir ? output : null) },
    './review-store': { readSavedReview: () => ({ ideas: [{ id: 'idea-02', title: 'AI test', pitch: 'One model wins by far', description: 'Long description' }] }) },
    './http-response': loadModule('main/http-response.ts'),
    './tools': { resolveBinary: () => 'ffmpeg' },
    './security': { isWithinDirectory: (child, parent) => !path.relative(parent, child).startsWith('..') },
    './logger': { logger: { info() {}, warn() {}, error() {} } },
    '../shared/thumbnail-prompt': loadModule('shared/thumbnail-prompt.ts')
  }, {
    fetch: async (url, options) => {
      requests.push({ url, options, body: JSON.parse(options.body) })
      return respond(url, requests.length)
    }
  })
  const waitFor = async (predicate) => {
    for (let i = 0; i < 1000 && !predicate(); i++) await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return { library, runDir, clip, requests, ffmpegCalls, settings, generator, waitFor, cleanup: () => fs.rmSync(library, { recursive: true, force: true }) }
}

test('a queued clip sends three frames and the filled prompt, then saves the image beside the clip', async () => {
  const ctx = setup(() => Response.json({ data: [{ b64_json: PNG.toString('base64'), media_type: 'image/png' }], usage: { cost: 0.04 } }))
  try {
    const queued = await ctx.generator.queueThumbnail(ctx.clip, ctx.library)
    assert.equal(queued.status, 'pending')
    await ctx.waitFor(() => fs.existsSync(path.join(ctx.runDir, 'clip_01.thumbnail.png')))
    const state = await ctx.generator.thumbnailStatus(ctx.clip, ctx.library)
    assert.equal(state.status, 'ready')
    assert.equal(state.path, path.join(ctx.runDir, 'clip_01.thumbnail.png'))
    assert.equal(state.costUsd, 0.04)
    assert.deepEqual(fs.readFileSync(state.path), PNG)

    assert.equal(ctx.ffmpegCalls.length, 3, 'frames at 25%, 50% and 75%')
    assert.deepEqual(ctx.ffmpegCalls.map((args) => args[args.indexOf('-ss') + 1]), ['10.00', '20.00', '30.00'])
    const [request] = ctx.requests
    assert.equal(request.url, 'https://openrouter.ai/api/v1/images')
    assert.equal(request.options.redirect, 'error')
    assert.equal(request.options.headers.Authorization, 'Bearer sk-or-test')
    assert.equal(request.body.model, 'google/gemini-3.1-flash-image')
    assert.equal(request.body.aspect_ratio, '9:16')
    assert.equal(request.body.input_references.length, 3)
    assert.match(request.body.input_references[0].image_url.url, /^data:image\/jpeg;base64,/)
    assert.match(request.body.prompt, /^Title=I tried 5 AI models Pitch=One model wins by far Format=vertical 9:16/)
    assert.match(request.body.prompt, /Keep=\{unknown\}$/, 'unknown placeholders stay visible')
    assert.equal(fs.readdirSync(ctx.runDir).some((name) => name.endsWith('.tmp')), false)
  } finally { ctx.cleanup() }
})

test('models served only through chat completions are retried there', async () => {
  const ctx = setup((url) => url.endsWith('/images')
    ? Response.json({ error: { message: 'Model not supported on this endpoint' } }, { status: 404 })
    : Response.json({ choices: [{ message: { images: [{ image_url: { url: `data:image/png;base64,${PNG.toString('base64')}` } }] } }], usage: { cost: 0.03 } }))
  try {
    await ctx.generator.queueThumbnail(ctx.clip, ctx.library)
    await ctx.waitFor(() => ctx.requests.length === 2 && fs.existsSync(path.join(ctx.runDir, 'thumbnails.json')) &&
      JSON.parse(fs.readFileSync(path.join(ctx.runDir, 'thumbnails.json'), 'utf8')).clips['clip_01.mp4'].status !== 'pending')
    assert.equal(ctx.requests[1].url, 'https://openrouter.ai/api/v1/chat/completions')
    assert.deepEqual(ctx.requests[1].body.modalities, ['image', 'text'])
    assert.equal(ctx.requests[1].body.messages[0].content.length, 4, 'prompt plus three frames')
    assert.equal((await ctx.generator.thumbnailStatus(ctx.clip, ctx.library)).status, 'ready')
  } finally { ctx.cleanup() }
})

test('provider errors and non-image replies fail the clip without writing a file; a failed redo keeps the old image', async () => {
  let reply = () => Response.json({ error: { message: 'Invalid API key' } }, { status: 401 })
  const ctx = setup(() => reply())
  const settled = async () => {
    await ctx.waitFor(() => {
      try { return JSON.parse(fs.readFileSync(path.join(ctx.runDir, 'thumbnails.json'), 'utf8')).clips['clip_01.mp4'].status !== 'pending' } catch { return false }
    })
    return ctx.generator.thumbnailStatus(ctx.clip, ctx.library)
  }
  try {
    await ctx.generator.queueThumbnail(ctx.clip, ctx.library)
    let state = await settled()
    assert.equal(state.status, 'failed')
    assert.match(state.error, /Invalid API key/)
    assert.equal(ctx.requests.length, 1, 'an auth error is not retried on another endpoint')

    reply = () => Response.json({ data: [{ b64_json: Buffer.from('<html>not an image</html>').toString('base64') }] })
    await ctx.generator.queueThumbnail(ctx.clip, ctx.library)
    state = await settled()
    assert.equal(state.status, 'failed')
    assert.match(state.error, /not an image/)
    assert.equal(fs.readdirSync(ctx.runDir).some((name) => name.includes('thumbnail.')), false)

    fs.writeFileSync(path.join(ctx.runDir, 'clip_01.thumbnail.jpg'), JPEG_FRAME)
    reply = () => Response.json({ error: { message: 'Rate limited' } }, { status: 429 })
    await ctx.generator.queueThumbnail(ctx.clip, ctx.library)
    state = await settled()
    assert.equal(state.status, 'ready', 'the earlier thumbnail stays')
    assert.match(state.error, /Rate limited/)
  } finally { ctx.cleanup() }
})

test('only rendered clips inside the library can get a thumbnail, and a stale pending state reads as interrupted', async () => {
  const ctx = setup(() => Response.json({ data: [] }))
  try {
    const outside = path.join(os.tmpdir(), `clip_01-${process.pid}.mp4`)
    await assert.rejects(ctx.generator.queueThumbnail(path.join(ctx.runDir, 'source.mp4'), ctx.library), /Not a rendered clip/)
    await assert.rejects(ctx.generator.queueThumbnail(42, ctx.library), /Not a rendered clip/)
    fs.writeFileSync(outside, 'x')
    try { await assert.rejects(ctx.generator.queueThumbnail(outside, ctx.library)) } finally { fs.rmSync(outside, { force: true }) }
    assert.equal(ctx.requests.length, 0)

    assert.equal(await ctx.generator.thumbnailStatus(ctx.clip, ctx.library), null, 'never requested')
    fs.writeFileSync(path.join(ctx.runDir, 'thumbnails.json'), JSON.stringify({ version: 1, clips: { 'clip_01.mp4': { status: 'pending', updatedAt: 'x' } } }))
    const state = await ctx.generator.thumbnailStatus(ctx.clip, ctx.library)
    assert.equal(state.status, 'failed')
    assert.match(state.error, /Interrupted/)
  } finally { ctx.cleanup() }
})

test('ideas without a ticked thumbnail are skipped when a round finishes', async () => {
  const ctx = setup(() => Response.json({ data: [{ b64_json: PNG.toString('base64') }] }))
  try {
    await ctx.generator.queueThumbnailsForIdeas(ctx.runDir, ['idea-09'], ctx.library)
    assert.equal(fs.existsSync(path.join(ctx.runDir, 'thumbnails.json')), false)
    await ctx.generator.queueThumbnailsForIdeas(ctx.runDir, ['idea-02'], ctx.library)
    await ctx.waitFor(() => fs.existsSync(path.join(ctx.runDir, 'clip_01.thumbnail.png')))
    assert.equal(ctx.requests.length, 1)
  } finally { ctx.cleanup() }
})

test('a crash while making one thumbnail does not stop the next one', async () => {
  let blockStatus = true
  const ctx = setup(() => {
    // Simulate the run folder changing mid-request: the status file can no longer be written.
    if (blockStatus) {
      fs.rmSync(path.join(ctx.runDir, 'thumbnails.json'), { force: true })
      fs.mkdirSync(path.join(ctx.runDir, 'thumbnails.json'))
      return Response.json({ error: { message: 'boom' } }, { status: 500 })
    }
    return Response.json({ data: [{ b64_json: PNG.toString('base64') }] })
  })
  try {
    await ctx.generator.queueThumbnail(ctx.clip, ctx.library)
    await ctx.waitFor(() => ctx.requests.length === 1)
    await new Promise((resolve) => setTimeout(resolve, 100))
    blockStatus = false
    fs.rmSync(path.join(ctx.runDir, 'thumbnails.json'), { recursive: true, force: true })

    await ctx.generator.queueThumbnail(ctx.clip, ctx.library)
    await ctx.waitFor(() => fs.existsSync(path.join(ctx.runDir, 'clip_01.thumbnail.png')))
    assert.equal(ctx.requests.length, 2, 'the queue kept running after the failed status write')
    assert.equal((await ctx.generator.thumbnailStatus(ctx.clip, ctx.library)).status, 'ready')
  } finally { ctx.cleanup() }
})

test('the user\'s own picture replaces the thumbnail; files that are not pictures are refused', async () => {
  const ctx = setup(() => Response.json({ data: [] }))
  try {
    fs.writeFileSync(path.join(ctx.runDir, 'clip_01.thumbnail.png'), PNG)
    const picked = path.join(ctx.library, 'my-cover.jpg')
    fs.writeFileSync(picked, JPEG_FRAME)
    const state = ctx.generator.setCustomThumbnail(ctx.clip, picked, ctx.library)
    assert.equal(state.status, 'ready')
    assert.equal(state.model, 'custom')
    assert.equal(state.path, path.join(ctx.runDir, 'clip_01.thumbnail.jpg'))
    assert.equal(fs.existsSync(path.join(ctx.runDir, 'clip_01.thumbnail.png')), false, 'the old thumbnail is replaced')
    assert.equal((await ctx.generator.thumbnailStatus(ctx.clip, ctx.library)).model, 'custom')

    const text = path.join(ctx.library, 'notes.png')
    fs.writeFileSync(text, 'not really a picture')
    assert.throws(() => ctx.generator.setCustomThumbnail(ctx.clip, text, ctx.library), /PNG, JPEG or WebP/)
    assert.deepEqual(fs.readFileSync(path.join(ctx.runDir, 'clip_01.thumbnail.jpg')), JPEG_FRAME, 'a refused file changes nothing')
    assert.throws(() => ctx.generator.setCustomThumbnail(path.join(ctx.runDir, 'source.mp4'), picked, ctx.library), /Not a rendered clip/)
  } finally { ctx.cleanup() }
})
