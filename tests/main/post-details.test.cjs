const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')

function load(file, mocks = {}) {
  const source = fs.readFileSync(path.join(__dirname, '../../src', file), 'utf8')
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const module = { exports: {} }
  vm.runInNewContext(js, { module, exports: module.exports, require: (id) => mocks[id] ?? require(id), URL, Intl, Date, Set, Buffer, process })
  return module.exports
}

const zernio = load('shared/zernio.ts')
const shared = load('shared/zernio-posts.ts')
const payload = load('main/zernio/posts-payload.ts', {
  './client': { sanitizeProviderText: (value) => typeof value === 'string' ? value : undefined },
  '../../shared/zernio': zernio,
  '../../shared/zernio-posts': shared
})
const store = load('main/zernio/posts-store.ts', {
  '../../shared/zernio': zernio,
  '../../shared/zernio-posts': shared,
  './workspace-cache': { quarantineUnbound() {}, readableCache: () => true }
})

const ACCOUNT = 'a'.repeat(24)
const TIKTOK = 'b'.repeat(24)

function request(overrides = {}) {
  return {
    attemptId: 'test-attempt-1234', clipPath: '/library/run/clip_00.mp4', clipTitle: 'Why agents need tests', durationMs: 12000,
    caption: 'Why agents need tests\n\n#ai #claudecode', thumbnailPath: '/library/run/clip_00.thumbnail.png',
    targets: [{ platform: 'youtube', accountId: ACCOUNT }, { platform: 'instagram', accountId: 'c'.repeat(24) }],
    timing: { mode: 'now' },
    options: {
      youtube: { title: 'Why agents need tests', visibility: 'unlisted', madeForKids: false, categoryId: '28', tags: ['claude code', 'ai tools'] },
      instagram: { shareToFeed: false }
    },
    ...overrides
  }
}

test('a post keeps what was sent: caption, thumbnail, YouTube and Instagram choices', () => {
  const details = payload.postDetailsFrom(request(), true, ['Zernio: caption trimmed'])
  assert.equal(details.caption, 'Why agents need tests\n\n#ai #claudecode')
  assert.equal(details.thumbnailPath, '/library/run/clip_00.thumbnail.png')
  assert.deepEqual({ ...details.youtube, tags: [...details.youtube.tags] }, { title: 'Why agents need tests', visibility: 'unlisted', madeForKids: false, categoryId: '28', tags: ['claude code', 'ai tools'] })
  assert.deepEqual({ ...details.instagram }, { shareToFeed: false })
  assert.equal(details.tiktok, null)
  assert.deepEqual([...details.warnings], ['Zernio: caption trimmed'])
})

test('the thumbnail is only recorded when it was really sent, and only options of chosen platforms are kept', () => {
  assert.equal(payload.postDetailsFrom(request(), false).thumbnailPath, null)
  assert.equal(payload.postDetailsFrom(request({ thumbnailPath: null }), true).thumbnailPath, null)
  const instagramOnly = payload.postDetailsFrom(request({ targets: [{ platform: 'instagram', accountId: 'c'.repeat(24) }] }), true)
  assert.equal(instagramOnly.youtube, null, 'YouTube options of an Instagram-only post are not shown')
})

test('TikTok choices, own account text and long captions are summarized safely', () => {
  const details = payload.postDetailsFrom(request({
    caption: 'x'.repeat(shared.POST_DETAILS_CAPTION_MAX + 50),
    targets: [{ platform: 'tiktok', accountId: TIKTOK, customContent: 'Short own text' }],
    options: { tiktok: { draft: false, madeWithAi: true, consent: true, accounts: { [TIKTOK]: { privacyLevel: 'PUBLIC_TO_EVERYONE' } } } }
  }), false)
  assert.equal(details.caption.length, shared.POST_DETAILS_CAPTION_MAX)
  assert.ok(details.caption.endsWith('…'))
  assert.deepEqual({ ...details.accountCaptions }, { [TIKTOK]: 'Short own text' })
  assert.deepEqual({ ...details.tiktok, privacy: { ...details.tiktok.privacy } }, { draft: false, madeWithAi: true, privacy: { [TIKTOK]: 'PUBLIC_TO_EVERYONE' } })
  const many = payload.postDetailsFrom(request(), true, Array.from({ length: 12 }, (_, i) => `notice ${i} ${'y'.repeat(400)}`))
  assert.equal(many.warnings.length, shared.POST_DETAILS_MAX_WARNINGS)
  assert.ok(many.warnings.every((warning) => warning.length <= 300))
})

function record(extra = {}) {
  return {
    id: 'd'.repeat(24), clipPath: '/library/run/clip_00.mp4', clipTitle: 'Why agents need tests',
    targets: [{ platform: 'youtube', accountId: ACCOUNT, handle: '@channel', status: 'published', error: null, url: 'https://youtube.com/shorts/y8JqcMabc12', inbox: false }],
    scheduledFor: null, timezone: null, status: 'published', error: null,
    createdAt: '2026-10-01T10:00:00.000Z', uploadedAt: '2026-10-01T09:59:00.000Z', refreshedAt: '2026-10-01T10:01:00.000Z', ...extra
  }
}

test('details survive saving and loading the post history', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vlasiichukclip-post-details-'))
  try {
    const history = new store.PostsStore(path.join(dir, 'posts.json'))
    const details = payload.postDetailsFrom(request(), true, ['A notice'])
    history.save(record({ details }), record({ id: 'e'.repeat(24), createdAt: '2026-09-01T10:00:00.000Z' }))
    const [newer, older] = history.list()
    assert.equal(newer.details.caption, details.caption)
    assert.equal(newer.details.thumbnailPath, '/library/run/clip_00.thumbnail.png')
    assert.deepEqual([...newer.details.youtube.tags], ['claude code', 'ai tools'])
    assert.deepEqual([...newer.details.warnings], ['A notice'])
    assert.equal(older.details, null, 'posts made before details were recorded still load, without them')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('damaged details drop only the details, never the post', () => {
  for (const bad of ['text', 42, [], { caption: 5 }, { caption: 'x'.repeat(shared.POST_DETAILS_CAPTION_MAX + 1) }]) {
    const parsed = store.parsePostRecord(record({ details: bad }))
    assert.ok(parsed, 'the post survives a damaged details field')
    assert.equal(parsed.details, null)
  }
  const parsed = store.parsePostRecord(record({ details: {
    caption: 'ok', thumbnailPath: 7, accountCaptions: { 'not an id': 'x', [ACCOUNT]: 'fine' },
    youtube: { title: 'T', visibility: 'public', madeForKids: 'yes', categoryId: '../x', tags: ['a', 5, 'b'] },
    tiktok: { draft: 1, privacy: { [ACCOUNT]: 'SELF_ONLY', [TIKTOK]: 3 } }, warnings: ['w', 9]
  } }))
  assert.equal(parsed.details.thumbnailPath, null)
  assert.deepEqual({ ...parsed.details.accountCaptions }, { [ACCOUNT]: 'fine' })
  assert.deepEqual({ ...parsed.details.youtube, tags: [...parsed.details.youtube.tags] }, { title: 'T', visibility: 'public', madeForKids: false, categoryId: null, tags: ['a', 'b'] })
  assert.deepEqual({ ...parsed.details.tiktok, privacy: { ...parsed.details.tiktok.privacy } }, { draft: false, madeWithAi: false, privacy: { [ACCOUNT]: 'SELF_ONLY' } })
  assert.deepEqual([...parsed.details.warnings], ['w'])
})
