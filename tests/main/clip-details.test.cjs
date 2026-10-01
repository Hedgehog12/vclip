const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const vm = require('node:vm')
const ts = require('typescript')

function loadModule(file, mocks = {}) {
  const source = fs.readFileSync(path.join(__dirname, '../../src', file), 'utf8')
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const module = { exports: {} }
  vm.runInNewContext(js, { module, exports: module.exports, require: (id) => mocks[id] ?? require(id), URL, Set, Map, process, Buffer })
  return module.exports
}

const jobOutput = loadModule('shared/job-output.ts')

function setup() {
  const library = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vlasiichukclip-details-')))
  const runDir = path.join(library, 'run')
  fs.mkdirSync(runDir)
  const clip = path.join(runDir, 'clip_01.mp4')
  fs.writeFileSync(clip, 'video')
  const clipEntry = (index, file) => ({ clip_index: index, s3_url: `file://${file}`, duration_ms: 1000, start_time_ms: 0, end_time_ms: 1000, virality_score: 0.5, summary: `Clip ${index}`, tags: [], description: 'Engine text', chapters: [] })
  const output = { job_id: 'run', engine_extra: { kept: true }, clips: [clipEntry(0, path.join(runDir, 'clip_00.mp4')), clipEntry(1, clip)] }
  fs.writeFileSync(path.join(runDir, 'job_output.json'), JSON.stringify(output))
  const details = loadModule('main/clip-details.ts', {
    '../shared/job-output': jobOutput,
    './thumbnail-generator': {
      resolveRunClip: (value) => {
        if (typeof value !== 'string' || !/clip_\d{2,}\.mp4$/.test(value)) throw new Error('Not a rendered clip')
        return { canonical: value, runDir: path.dirname(value), name: path.basename(value) }
      }
    }
  })
  return { library, runDir, clip, details, read: () => JSON.parse(fs.readFileSync(path.join(runDir, 'job_output.json'), 'utf8')), cleanup: () => fs.rmSync(library, { recursive: true, force: true }) }
}

test('editing a clip changes only its title and description and keeps the rest of the run', () => {
  const ctx = setup()
  try {
    const updated = ctx.details.updateClipDetails(ctx.clip, { title: '  I tested 5 AI models  ', description: 'Line one\r\nLine two' }, ctx.library)
    assert.equal(updated.summary, 'I tested 5 AI models')
    assert.equal(updated.description, 'Line one\nLine two')
    const saved = ctx.read()
    assert.equal(saved.clips[1].summary, 'I tested 5 AI models')
    assert.equal(saved.clips[0].summary, 'Clip 0', 'other clips are untouched')
    assert.deepEqual(saved.engine_extra, { kept: true }, 'fields the app does not know are kept')
    assert.deepEqual(saved.clips[1].chapters, [])

    ctx.details.updateClipDetails(ctx.clip, { title: 'Short', description: '   ' }, ctx.library)
    assert.equal(ctx.read().clips[1].description, null, 'an emptied description is cleared')
    assert.equal(fs.readdirSync(ctx.runDir).some((name) => name.endsWith('.tmp')), false)
  } finally { ctx.cleanup() }
})

test('invalid edits are refused and leave the file as it was', () => {
  const ctx = setup()
  try {
    const before = fs.readFileSync(path.join(ctx.runDir, 'job_output.json'), 'utf8')
    assert.throws(() => ctx.details.updateClipDetails(ctx.clip, { title: '  ', description: '' }, ctx.library), /Give the clip a title/)
    assert.throws(() => ctx.details.updateClipDetails(ctx.clip, { title: 'x'.repeat(201), description: '' }, ctx.library), /at most 200/)
    assert.throws(() => ctx.details.updateClipDetails(ctx.clip, { title: 'ok', description: 'x'.repeat(5001) }, ctx.library), /at most 5000/)
    assert.throws(() => ctx.details.updateClipDetails(ctx.clip, { title: 'ok\0', description: '' }, ctx.library), /Invalid title/)
    assert.throws(() => ctx.details.updateClipDetails(ctx.clip, null, ctx.library), /Invalid title/)
    assert.throws(() => ctx.details.updateClipDetails(path.join(ctx.runDir, 'clip_07.mp4'), { title: 'ok', description: '' }, ctx.library), /not part of a finished run/)
    assert.equal(fs.readFileSync(path.join(ctx.runDir, 'job_output.json'), 'utf8'), before)
  } finally { ctx.cleanup() }
})
