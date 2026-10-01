const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')

function load(file, mocks = {}) {
  const source = fs.readFileSync(path.join(__dirname, '../../src', file), 'utf8')
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const module = { exports: {} }
  vm.runInNewContext(js, { module, exports: module.exports, require: (id) => mocks[id] ?? require(id), URL, Intl, Date, Set, Buffer })
  return module.exports
}

const zernio = load('shared/zernio.ts')
const shared = load('shared/zernio-posts.ts')
const payload = load('main/zernio/posts-payload.ts', {
  './client': { sanitizeProviderText: (value) => typeof value === 'string' ? value : undefined },
  '../../shared/zernio': zernio,
  '../../shared/zernio-posts': shared
})
const jobOutput = load('shared/job-output.ts')

test('YouTube tags are cleaned, deduplicated and kept within YouTube limits', () => {
  assert.deepEqual([...shared.youtubeTagsFrom(['#Claude Code', 'claude code', '  ai   tools ', '', 'a<b', 'x'.repeat(101), 'git'])], ['Claude Code', 'ai tools', 'git'])
  assert.deepEqual([...shared.parseTagList('claude code, ai tools\ngit')], ['claude code', ' ai tools', 'git'])
  const many = shared.youtubeTagsFrom(Array.from({ length: 40 }, (_, i) => `keyword number ${i}`))
  assert.ok(many.length <= shared.YOUTUBE_TAGS_MAX_COUNT)
  assert.ok(many.join(',').length <= shared.YOUTUBE_TAGS_MAX_CHARS)
  const long = shared.youtubeTagsFrom(Array.from({ length: 10 }, (_, i) => `${'k'.repeat(90)}${i}`))
  assert.ok(long.join(',').length <= 500 && long.length === 5)
})

test('a post sends the tags and category, and the request parser accepts what the dialog builds', () => {
  const request = payload.parsePostClipRequest({
    attemptId: 'test-attempt-1234', clipPath: '/tmp/clip.mp4', clipTitle: 'A clip', durationMs: 12000, caption: 'A caption',
    targets: [{ platform: 'youtube', accountId: 'abc123' }], timing: { mode: 'now' },
    options: { youtube: { title: 'A clip', visibility: 'public', madeForKids: false, categoryId: '28', tags: shared.youtubeTagsFrom(['claude code', 'ai tools']) } }
  })
  const body = payload.buildCreatePostBody(request, { publicUrl: 'https://media.example.test/clip.mp4' })
  assert.deepEqual([...body.tags], ['claude code', 'ai tools'])
  assert.equal(body.platforms[0].platformSpecificData.categoryId, '28')
})

test('the clip keeps the category the planner chose, and nothing else', () => {
  const clip = (youtube_category) => ({ clip_index: 0, s3_url: 'file:///x/clip_00.mp4', duration_ms: 1, start_time_ms: 0, end_time_ms: 1, virality_score: 0.5, tags: [], youtube_category })
  assert.equal(jobOutput.parseJobOutput({ clips: [clip('28')] }).clips[0].youtube_category, '28')
  assert.equal(jobOutput.parseJobOutput({ clips: [clip('../x')] }).clips[0].youtube_category, null)
  assert.ok(shared.YOUTUBE_CATEGORIES.some((category) => category.id === shared.DEFAULT_YOUTUBE_CATEGORY))
})

test('a posted YouTube link opens the matching YouTube Studio page, and nothing else does', () => {
  const studio = 'https://studio.youtube.com/video/y8JqcMabc12/edit'
  assert.equal(payload.youtubeStudioUrl('https://youtube.com/shorts/y8JqcMabc12'), studio)
  assert.equal(payload.youtubeStudioUrl('https://www.youtube.com/watch?v=y8JqcMabc12&t=3'), studio)
  assert.equal(payload.youtubeStudioUrl('https://youtu.be/y8JqcMabc12'), studio)
  for (const url of ['https://evil.test/shorts/y8JqcMabc12', 'http://youtube.com/shorts/y8JqcMabc12', 'https://youtube.com/shorts/short', 'https://youtube.com/shorts/y8JqcMabc12/../x', null]) {
    assert.equal(payload.youtubeStudioUrl(url), null, String(url))
  }
})
