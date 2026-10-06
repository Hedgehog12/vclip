const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { buildApp, launchApp } = require('../zernio/support/electron-app.cjs')

const REVIEW_A = '11111111-1111-4111-8111-111111111111'
const REVIEW_B = '22222222-2222-4222-8222-222222222222'
const NEW_JOB = '33333333-3333-4333-8333-333333333333'

function entry(jobId, title) {
  return {
    jobId, date: new Date().toISOString(), videoTitle: title, clipCount: 0, status: 'awaiting_approval',
    outputDir: `/tmp/${jobId}`, totalCostUsd: null, finishedAt: null, durationMs: null, errorMessage: null, ideasLeft: 5, sourceKept: true
  }
}

function snapshot(status, revision, step) {
  return {
    id: NEW_JOB, revision, status, percent: status === 'queued' ? 0 : 12, step, clipsDone: 0, clipsTotal: 0,
    error: null, errorHint: null, failureCode: null, failureStage: null, httpStatus: null, output: null,
    outputDir: `/tmp/${NEW_JOB}`, queuedAt: new Date().toISOString(), startedAt: status === 'queued' ? null : new Date().toISOString(), finishedAt: null,
    request: { videoUrl: 'https://www.youtube.com/watch?v=newjob12345', maxClips: null, autoClipCount: true, durationRanges: null, aspectRatio: '9:16', layoutStyle: 'auto', layoutVision: true, pacing: 'tight', includeCaptions: true, captionPreset: 'pop', startTimeSeconds: null, endTimeSeconds: null, bannerPlatform: null, bannerChannelUrl: null }
  }
}

test('a new job shows on the Jobs page from the moment it starts, next to jobs waiting for review', { timeout: 120000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vclip-jobs-e2e-'))
  const appDir = buildApp()
  console.log('built')
  const session = await launchApp({ appDir, userDataDir: path.join(root, 'user-data') })
  t.after(async () => { await session.close(); fs.rmSync(root, { recursive: true, force: true }) })
  const { app, page } = session
  console.log('launched')
  page.setDefaultTimeout(15000)
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))

  // Two earlier runs wait for review on disk. The new job exists only live.
  await app.evaluate(({ ipcMain }, history) => {
    ipcMain.removeHandler('history:list')
    ipcMain.handle('history:list', () => history)
  }, [entry(REVIEW_A, 'Stream one'), entry(REVIEW_B, 'Stream two')])
  await page.reload()
  console.log('reloaded')
  await page.getByRole('button', { name: /^Jobs/ }).first().click()
  console.log('on jobs')
  await page.getByText('Needs your review').waitFor()
  console.log('review list shown')

  // What the main process sends when a job is created and while it analyzes.
  const send = (job) => app.evaluate(({ BrowserWindow }, job) => BrowserWindow.getAllWindows()[0].webContents.send('jobs:update', job), job)
  await send(snapshot('queued', 0, 'Waiting for a free slot'))
  await send(snapshot('pending', 1, 'Starting…'))
  await send(snapshot('downloading', 2, 'Downloading video'))

  const active = page.getByRole('region', { name: 'Active jobs' })
  await active.waitFor({ timeout: 5000 })
  assert.match(await active.innerText(), /Downloading/)
  assert.deepEqual(errors, [])
})

test('the real start path lists the job while it runs, with jobs waiting for review', { timeout: 240000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vclip-jobs-real-'))
  const appDir = buildApp()
  // The dev layout: the bridge and engine sit next to out/.
  for (const name of ['bridge', 'engine']) {
    const link = path.join(appDir, name)
    if (!fs.existsSync(link)) fs.symlinkSync(path.resolve(__dirname, '../..', name), link, 'junction')
  }
  const session = await launchApp({ appDir, userDataDir: path.join(root, 'user-data') })
  t.after(async () => { await session.close(); fs.rmSync(root, { recursive: true, force: true }) })
  const { app, page } = session
  page.setDefaultTimeout(15000)
  await app.evaluate(({ ipcMain }, history) => {
    ipcMain.removeHandler('history:list')
    ipcMain.handle('history:list', () => history)
  }, [entry(REVIEW_A, 'Stream one'), entry(REVIEW_B, 'Stream two')])
  await page.reload()
  await page.evaluate(() => window.vclip.settings.replaceApiKey('openrouterApiKey', 'sk-or-test-not-real'))
  await page.getByRole('button', { name: /^Jobs/ }).first().click()
  await page.getByText('Needs your review').waitFor()
  const started = await page.evaluate(() => window.vclip.job.start({
    videoUrl: 'https://www.youtube.com/watch?v=aaaaaaaaaaa', maxClips: null, autoClipCount: true, durationRanges: null, aspectRatio: '9:16',
    layoutStyle: 'auto', layoutVision: true, pacing: 'tight', includeCaptions: true, captionPreset: 'pop', startTimeSeconds: null,
    endTimeSeconds: null, bannerPlatform: null, bannerChannelUrl: null
  }))
  console.log('start result', JSON.stringify(started))
  assert.ok(started.jobId, started.error)
  const active = page.getByRole('region', { name: 'Active jobs' })
  await active.waitFor({ timeout: 5000 })
  console.log('active:', (await active.innerText()).replace(/\s+/g, ' '))
})

test('opening Jobs from the sidebar shows the list with the new job, not the job looked at last', { timeout: 120000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vclip-jobs-focus-'))
  const appDir = buildApp()
  const session = await launchApp({ appDir, userDataDir: path.join(root, 'user-data') })
  t.after(async () => { await session.close(); fs.rmSync(root, { recursive: true, force: true }) })
  const { app, page } = session
  page.setDefaultTimeout(15000)
  await app.evaluate(({ ipcMain }, history) => {
    ipcMain.removeHandler('history:list')
    ipcMain.handle('history:list', () => history)
  }, [entry(REVIEW_A, 'Stream one'), entry(REVIEW_B, 'Stream two')])
  await page.reload()
  const send = (job) => app.evaluate(({ BrowserWindow }, job) => BrowserWindow.getAllWindows()[0].webContents.send('jobs:update', job), job)
  const nav = (name) => page.getByRole('navigation').getByRole('button', { name: new RegExp(`^${name}`) }).first().click()

  // Earlier in the session: a render round the user opened and watched until it waited for review again.
  const earlier = { ...snapshot('rendering', 0, 'Rendering'), id: REVIEW_A }
  await nav('Jobs')
  await send(earlier)
  await page.getByRole('region', { name: 'Active jobs' }).getByRole('button', { name: /youtube/ }).first().click()
  await send({ ...earlier, status: 'awaiting_approval', revision: 1, step: 'Waiting for your approval' })

  // Later: a new video from Create, then Jobs from the sidebar.
  await nav('Create')
  await send(snapshot('downloading', 0, 'Downloading video'))
  await nav('Jobs')
  const active = page.getByRole('region', { name: 'Active jobs' })
  await active.waitFor({ timeout: 5000 })
  assert.match(await active.innerText(), /Downloading/)
  await page.getByText('Needs your review').waitFor()
})
