# Posts page rebuild: Zernio-style planner inside vClip

Goal: plan, draft, schedule, queue, edit and review posts without leaving the app.
Zernio stays the publishing backend; the app becomes the front end.

Branch: start `feat/posts-planner` from `feat/thumbnails-cold-open-posting`
(it is not merged yet and already has the thumbnail, tags and YouTube helpers this work needs).

## Constraints that shape the design

- **Zernio deletes unpublished uploads after 7 days** (`UPLOAD_RETENTION_MS` in
  `src/shared/zernio-posts.ts`). So:
  - Drafts are stored **locally** (clip path, caption, options) and the clip is uploaded only
    when you press Schedule, Now or Queue. A Zernio-side draft with media would break after a week.
  - Zernio can schedule at most about 6.5 days ahead. A date further out is saved as a local
    "planned" post. The app uploads it about 6 days before its time, and only while the app is
    running (the automation scheduler works the same way). The UI says this clearly.
- **Editing depends on status.** For scheduled posts, `PUT /v1/posts/{id}` changes the text, time and accounts.
  For published posts, `POST /v1/posts/{id}/edit` changes the text only, on X, Facebook, LinkedIn and YouTube.
  It doesn't work for Instagram or TikTok. The UI must state this per platform.
- **Best time to post** uses `GET /v1/analytics/best-time`, which needs Zernio's Analytics add-on.
  Without it the call returns 403 with `requiresAddon`. It ranks weekday and hour slots (UTC) by
  *your own* past engagement, so it needs post history. The fallback is manual queue slots.
- **The composer is `PostDialog.tsx` (1443 lines).** We extend it, we don't rewrite it. It holds the TikTok
  consent and privacy rules, the YouTube title, tags and category, and the per-platform clip and caption checks.

## Phase 1: Data layer

- [x] Confirm `PostRecord.id` equals Zernio's post id for every record (`posts.ts` around line 557). The join below depends on it.
- [x] `ZernioClient.listPosts({ page, limit, status, platform, profileId, fromDate, toDate, search, sortBy })` → `GET /v1/posts`.
- [x] `ZernioClient.getPost(id)` (already existed) → `GET /v1/posts/{id}` (content, platforms, per-platform URL, media and thumbnail URLs, errors).
- [x] Merge layer in main (`listRemotePosts`, `listedPostItem`; library deep-link fields still open): remote posts joined with local `PostRecord`s by id, so posts made from the app also carry `clipPath`, the thumbnail and `jobOutputDir`/`clipIndex`.
      Posts made on zernio.com appear too, flagged as `origin: 'zernio'` and without local file buttons.
- [x] Extend `PostRecord` (done as `details`: caption, thumbnail, per-platform options; `profileId`/`jobOutputDir`/`clipIndex` still open) (new fields optional so old history still loads): `caption`, `options`, `profileId`, `thumbnailPath`, `jobOutputDir`, `clipIndex`, `origin`.
      Fill them in `publish()` for new posts.
- [ ] Local drafts store: `userData/post-drafts-<workspace>.json` holding `{ id, clipPath, caption, targets, options, timing?, createdAt, updatedAt }`, with IPC to list, save and delete.
- [ ] Tests: client parsing (`tests/zernio/client.test.cjs`), merge logic, draft store round-trip, old-history migration.

## Phase 2: List view (matches screenshot 3)

- [x] Toolbar: source filter (App posts / All Zernio posts), status, platform, profile, date range, text search.
- [x] Sort menu built on Zernio's `sortBy`: scheduled newest and oldest, created newest and oldest, status, platform.
- [ ] View switcher: list ↔ calendar (moved to Phase 5; filters are already remembered), with the choice remembered in `localStorage`.
- [x] Table columns: thumbnail, content (first line), platform icons, date, status badge, profile.
      Optional later columns: likes, comments, views (see Phase 6).
- [x] Paging: "Show more" (local) and "Load more" (Zernio, 50 per page) (limit ≤ 500).
- [x] Keep the current polling, cancel, retry and dismiss behaviour from `PostsPage.tsx`.
- [x] Header buttons (Create post opens the Library until the Phase 4 composer exists; Open Zernio goes to zernio.com/dashboard): **Create post**, **Open in Zernio** (fixed, allow-listed URL in `src/shared/brand.ts`; check the real dashboard path first), Refresh.

## Phase 3: Post details popup

- [ ] Row click opens a `PostDetailsDialog` showing exactly what was sent: full caption, each platform's
      status, error and public link, schedule time and time zone, YouTube title, tags, category and visibility, the TikTok options, and the thumbnail preview.
- [ ] Buttons:
  - [ ] **Open in Library**: navigate to the run and clip. This needs a deep link, because `onNavigate(page)` takes only a page name today.
        Extend it to `onNavigate('library', { outputDir, clipIndex })`, and make `LibraryPage` open that run and scroll to the clip.
  - [ ] **Show clip in folder** and **Show thumbnail in folder** via the existing `shell:showItemInFolder`
        (it already accepts paths inside the output directory).
  - [ ] **Open on <platform>** for each target (the existing `openPostLink`).
  - [ ] **Open in Zernio** for this post.
  - [ ] **Edit**: scheduled → open the composer prefilled (PUT). Published → caption-only edit where supported, with an explanation where it isn't.
  - [ ] Reschedule, cancel, retry and duplicate as a new draft.

## Phase 4: Composer and drafts (matches screenshot 1)

- [x] Make `PostDialog` work without a preselected clip: add a **media picker** that lists the clips of finished runs
      (from `history`) with thumbnail, title and duration, plus search.
- [x] Profile filter above the account list (shown with more than one profile); Queue uses the selected accounts' profile.
- [x] Publishing mode segmented control: **Schedule · Now · Queue · Draft**.
  - [ ] Schedule past 6.5 days → "planned locally" with automatic upload later: NOT done. A draft can hold a later time ("Planned for …"), but it is posted by hand.
  - [x] Queue: show the profile's next slot (`/v1/queue/next-slot`). Reject it if it falls outside the 7-day window. Send `queuedFromProfile`.
  - [x] Draft: **Save draft** writes only to the local store, with no upload.
- [x] Open a draft from the Drafts panel (calendar comes in Phase 5) → composer prefilled → finish → Schedule, Now or Queue → the draft is removed when it succeeds.
- [x] Autosave the open composer to its draft (debounced) so nothing is lost on close.
- [x] Entry points: the Posts page "Create post" button and the Library clip "Post" button (which can now also save a draft). Calendar day click: Phase 5.

## Phase 5: Calendar view (matches screenshot 2)

- [ ] Month grid with week start Sun or Mon, Today, and a month picker. Each cell shows time, platform icon and title, then "+N more".
- [ ] Shows scheduled, published, failed, local drafts with a time, and locally planned posts, each styled distinctly.
- [ ] Click an item → details popup. Click an empty day → composer prefilled with that date.
- [ ] Optional later: week view, and drag to reschedule (scheduled posts only, still within the 7-day window).
- [ ] Fetch by visible range (`fromDate`/`toDate`).

## Phase 6: Queue and best time

- [ ] Queue settings panel (per profile): list, add, edit and remove weekly slots via `/v1/queue/slots` (GET, POST, PUT, DELETE), and preview the next slots via `/v1/queue/preview`.
- [ ] "Suggest best times" button: call `/v1/analytics/best-time` for the profile and platform, convert UTC to local, and offer the top slots as queue slots.
      On 403 `requiresAddon`, say that the Analytics add-on is needed and that slots can be set by hand.
- [ ] Optional: metric columns (likes, comments, views) and the "Most engagement" sort, via `/v1/analytics`. Also requires the add-on.

## Phase 7: Automations page (open, needs a decision)

The request names this page but doesn't say what should change. What we know so far:
- Posts created by automations already land in the same history and will show in the new list and calendar.
- Automation daily times overlap with Zernio queues. One option is to let an automation post through the profile's queue (`queuedFromProfile`) instead of its own times.
- [ ] Decide with the user what is "not usable" there before redesigning it.

## Verification

- [ ] `npm test` (unit), plus the Zernio e2e suites with the mock server (`tests/zernio/support/mock-zernio.cjs`, extended for list, get, queue and best-time).
- [ ] Manual run: create a draft → reopen → queue it → see it in the calendar → open details → show in folder → open in Library.
