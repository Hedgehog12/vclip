const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')
const { fileLinksAvailable } = require('../support/symlinks.cjs')

function load(file, mocks = {}) {
  const source = fs.readFileSync(path.join(__dirname, '../../src', file), 'utf8')
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const module = { exports: {} }
  vm.runInNewContext(js, { module, exports: module.exports, require: (id) => mocks[id] ?? require(id), URL, Set, Map, process, Buffer, console })
  return module.exports
}

const videoSource = load('shared/video-source.ts')
const jobOutput = load('shared/job-output.ts')
const jobs = load('shared/jobs.ts')
const fileIdentity = load('main/file-identity.ts')
const runHistory = load('main/run-history.ts', { '../shared/video-source': videoSource, './file-identity': fileIdentity })
const reviewStore = load('main/review-store.ts', { './run-history': runHistory, '../shared/jobs': jobs, './file-identity': fileIdentity })
const fileManager = load('main/file-manager.ts', {
  electron: { app: { getPath: () => os.tmpdir() } },
  '../shared/job-output': jobOutput,
  './run-history': runHistory,
  './review-store': reviewStore,
  './file-identity': fileIdentity,
  './tools': { resolveBinary: () => 'ffprobe' }
})

const ID = '0f6b3c1e-8a2d-4b7e-9c11-2a3b4c5d6e7f'

function library() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vclip-review-'))
  return { root, run: path.join(root, ID), cleanup: () => fs.rmSync(root, { recursive: true, force: true }) }
}

function idea(n, extra = {}) {
  return {
    idea_id: `idea-0${n}`, rank: n, recommended: n <= 2, rendered: false, clip_index: null,
    start_time_ms: n * 60000, end_time_ms: n * 60000 + 30000, summary: `Idea ${n}`, pitch: `Pitch ${n}.`,
    excerpt: `words ${n}`, scores: { hook: 8, standalone: 7, bogus: 1 }, virality_score: 0.75, tags: ['a'],
    skip_ranges_ms: [[n * 60000 + 5000, n * 60000 + 15000]], ...extra
  }
}

const hookAt = (n, from, to, text = 'Never let it write for you.') => ({
  hook_start_ms: n * 60000 + from, hook_end_ms: n * 60000 + to, hook_text: text
})

function writeReview(run, ideas, source = { path: path.join(run, 'source.mp4'), downloaded: true, size_bytes: 11 }) {
  fs.writeFileSync(path.join(run, 'review.json'), JSON.stringify({
    version: 1, job_id: ID, source, metadata: { title: 'My stream' }, recommended_count: 2, ideas
  }))
}

test('run records move through review, render rounds, and back to review when a round fails or is cancelled', () => {
  const { root, cleanup } = library()
  try {
    runHistory.createRunRecord(root, ID, 'https://www.youtube.com/watch?v=abc123def45', { videoUrl: 'https://www.youtube.com/watch?v=abc123def45', autoClipCount: false })
    assert.equal(runHistory.beginRenderRound(root, ID), null, 'a running analysis cannot render')
    runHistory.finishRunRecord(root, ID, 'awaiting_approval')
    let record = runHistory.readRunRecord(root, ID)
    assert.equal(record.status, 'awaiting_approval')
    assert.equal(record.request.autoClipCount, false)

    assert.equal(runHistory.beginRenderRound(root, ID), 'awaiting_approval')
    runHistory.finishRunRecord(root, ID, 'failed', 'Clip rendering failed.', { failureCode: 'render.failed' })
    record = runHistory.readRunRecord(root, ID)
    assert.equal(record.status, 'awaiting_approval', 'a failed round returns to review')
    assert.equal(record.errorMessage, 'Clip rendering failed.')
    assert.equal(record.resumeStatus, null)

    runHistory.beginRenderRound(root, ID)
    runHistory.finishRunRecord(root, ID, 'cancelled')
    assert.equal(runHistory.readRunRecord(root, ID).status, 'awaiting_approval', 'a cancelled round returns to review')

    runHistory.beginRenderRound(root, ID)
    runHistory.finishRunRecord(root, ID, 'completed')
    assert.equal(runHistory.readRunRecord(root, ID).status, 'completed')
    assert.equal(runHistory.beginRenderRound(root, ID), 'completed', 'a done job can render more ideas')
    runHistory.finishRunRecord(root, ID, 'failed', 'Clip rendering failed.')
    assert.equal(runHistory.readRunRecord(root, ID).status, 'completed')

    assert.equal(runHistory.saveDecisions(root, ID, { 'idea-01': 'approved', 'idea-02': 'rejected' }), true)
    assert.equal(runHistory.saveDecisions(root, ID, { '../x': 'approved' }), false)
    assert.deepEqual({ ...runHistory.readRunRecord(root, ID).decisions }, { 'idea-01': 'approved', 'idea-02': 'rejected' })
    runHistory.discardRunRecord(root, ID)
    assert.equal(runHistory.readRunRecord(root, ID).status, 'completed', 'only a waiting job can be discarded')
  } finally { cleanup() }
})

test('a waiting job shows in history with its ideas left; an interrupted render round returns to review', async () => {
  const { root, run, cleanup } = library()
  try {
    runHistory.createRunRecord(root, ID, 'https://www.youtube.com/watch?v=abc123def45', { videoUrl: 'https://www.youtube.com/watch?v=abc123def45' })
    runHistory.finishRunRecord(root, ID, 'awaiting_approval')
    fs.writeFileSync(path.join(run, 'source.mp4'), 'source data')
    writeReview(run, [idea(1), idea(2), idea(3, { rendered: true, clip_index: 0 })])
    runHistory.saveDecisions(root, ID, { 'idea-02': 'rejected' })

    let [entry] = await fileManager.getJobHistory(root)
    assert.equal(entry.status, 'awaiting_approval')
    assert.equal(entry.videoTitle, 'My stream')
    assert.equal(entry.ideasLeft, 1, 'rendered and rejected ideas are not left')
    assert.equal(entry.sourceKept, true)

    runHistory.beginRenderRound(root, ID)
    ;[entry] = await fileManager.getJobHistory(root, new Set([ID]))
    assert.equal(entry.status, 'running')
    ;[entry] = await fileManager.getJobHistory(root, new Set())
    assert.equal(entry.status, 'awaiting_approval', 'a crash during a round returns to review')
  } finally { cleanup() }
})

test('the review is built from sanitized ideas and never trusts the source path written in review.json', () => {
  const { root, run, cleanup } = library()
  try {
    runHistory.createRunRecord(root, ID, '/videos/mine.mp4', { videoUrl: path.join(root, 'elsewhere.mp4'), autoClipCount: true })
    runHistory.finishRunRecord(root, ID, 'awaiting_approval')
    writeReview(run, [idea(2), idea(1), { idea_id: '../../evil', start_time_ms: 0, end_time_ms: 1 }],
      { path: path.join(os.homedir(), 'secret.mp4'), downloaded: true, size_bytes: 1 })
    let review = reviewStore.buildJobReview(root, ID, false)
    assert.deepEqual(Array.from(review.ideas, (i) => i.id), ['idea-01', 'idea-02'], 'sorted by rank, invalid ideas dropped')
    assert.deepEqual({ ...review.ideas[0].scores }, { hook: 8, standalone: 7 })
    assert.equal(review.sourcePath, null, 'no source.* in the run folder, so nothing to play')
    assert.equal(review.autoClipCount, true)
    fs.writeFileSync(path.join(run, 'source.webm'), 'x')
    review = reviewStore.buildJobReview(root, ID, true)
    assert.equal(review.sourcePath, path.join(run, 'source.webm'))
    assert.equal(review.busy, true)

    // A job made from the user's own file plays that file, as recorded when the job started.
    writeReview(run, [idea(1)], { path: '/anything', downloaded: false, size_bytes: 1 })
    assert.equal(reviewStore.buildJobReview(root, ID, false).sourcePath, null, 'the recorded file does not exist')
    fs.writeFileSync(path.join(root, 'elsewhere.mp4'), 'mine')
    assert.equal(reviewStore.buildJobReview(root, ID, false).sourcePath, path.join(root, 'elsewhere.mp4'))
  } finally { cleanup() }
})

test('storage usage splits each run into stream, clips and other files; delete removes only the stream', (t) => {
  const { root, run, cleanup } = library()
  try {
    runHistory.createRunRecord(root, ID, 'https://example.com/v', { videoUrl: 'https://example.com/v' })
    fs.writeFileSync(path.join(run, 'source.mkv'), Buffer.alloc(1000))
    fs.writeFileSync(path.join(run, 'clip_00.mp4'), Buffer.alloc(300))
    fs.writeFileSync(path.join(run, 'clip_00.srt'), Buffer.alloc(20))
    fs.writeFileSync(path.join(run, 'clip_00.youtube.txt'), Buffer.alloc(5))
    fs.writeFileSync(path.join(run, 'clip_00.thumbnail.png'), Buffer.alloc(100))
    fs.writeFileSync(path.join(run, 'transcript.json'), Buffer.alloc(50))
    fs.mkdirSync(path.join(root, 'not-a-job'))
    const outside = path.join(os.tmpdir(), `vclip-outside-${process.pid}.mp4`)
    fs.writeFileSync(outside, Buffer.alloc(99999))
    if (fileLinksAvailable) fs.symlinkSync(outside, path.join(run, 'linked.mp4'))
    else t.diagnostic('File links unavailable; symlink size check skipped')
    try {
      const usage = reviewStore.storageUsage(root, () => false, new Map())
      assert.equal(usage.runs.length, 1)
      const [runUsage] = usage.runs
      assert.equal(runUsage.sourceBytes, 1000)
      assert.equal(runUsage.clipBytes, 425, 'AI thumbnails count as clip files')
      assert.ok(runUsage.otherBytes >= 50 && runUsage.otherBytes < 99999, 'links are not followed')
      assert.equal(usage.sourceBytes, 1000)

      assert.equal(reviewStore.deleteKeptSource(root, ID), true)
      assert.equal(fs.existsSync(path.join(run, 'source.mkv')), false)
      assert.equal(fs.existsSync(path.join(run, 'clip_00.mp4')), true)
      assert.equal(fs.existsSync(outside), true)
      assert.equal(reviewStore.deleteKeptSource(root, ID), false, 'nothing left to delete')
      assert.throws(() => reviewStore.deleteKeptSource(root, '../escape'), /Invalid run identifier/)
    } finally { fs.rmSync(outside, { force: true }) }
  } finally { cleanup() }
})

test('a user file is never counted or deleted as a kept stream', () => {
  const { root, run, cleanup } = library()
  try {
    const mine = path.join(root, 'my-video.mp4')
    fs.writeFileSync(mine, Buffer.alloc(500))
    runHistory.createRunRecord(root, ID, mine, { videoUrl: mine })
    fs.writeFileSync(path.join(run, 'review.json'), '{}')
    const [runUsage] = reviewStore.storageUsage(root, () => false, new Map()).runs
    assert.equal(runUsage.sourceBytes, 0)
    assert.equal(runUsage.sourceIsUserFile, true)
    assert.equal(reviewStore.deleteKeptSource(root, ID), false)
    assert.equal(fs.existsSync(mine), true)
  } finally { cleanup() }
})

test('an idea offers its hook only when the hook lies inside the clip and has words', () => {
  const { root, run, cleanup } = library()
  try {
    runHistory.createRunRecord(root, ID, 'https://example.com/v', { videoUrl: 'https://example.com/v' })
    runHistory.finishRunRecord(root, ID, 'awaiting_approval')
    writeReview(run, [
      idea(1, hookAt(1, 20000, 24500)),
      idea(2, hookAt(2, 20000, 24500, '   ')),
      idea(3, hookAt(3, 40000, 50000)),
      idea(4, { hook_start_ms: 4 * 60000 + 10000, hook_end_ms: 4 * 60000 + 9000, hook_text: 'Backwards.' }),
      idea(5, { hook_start_ms: 'soon', hook_end_ms: null, hook_text: 'Not numbers.' }),
      idea(6)
    ])
    const review = reviewStore.buildJobReview(root, ID, false)
    const byId = Object.fromEntries(review.ideas.map((i) => [i.id, i.hook]))
    assert.deepEqual({ ...byId['idea-01'] }, { startMs: 80000, endMs: 84500, text: 'Never let it write for you.' })
    for (const id of ['idea-02', 'idea-03', 'idea-04', 'idea-05', 'idea-06']) assert.equal(byId[id], null, id)
  } finally { cleanup() }
})
