# Guest Download Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A static page that the kiosk's QR code opens. It shows the guest's printed photo with a Save / Share button and copes with a photo that is still uploading.

**Architecture:** Plain static files in a new `download/` folder: HTML, one pure-logic ES module and one browser-wiring module, with no build step. Vercel serves them. The page reads the composite straight from the Supabase `captures` bucket's public URL, which a new migration makes public while it drops the anon read policies. The kiosk only needs its `VITE_DOWNLOAD_URL` set.

**Tech Stack:** Vanilla HTML/CSS/JS (ES modules), vitest for `photo.js`, Supabase Storage public objects, Vercel static hosting.

**Spec:** `docs/superpowers/specs/2026-09-28-guest-download-page-design.md`

## Global Constraints

- The page URL is `?event=<event_id>&name=<display name>&id=<captureId>`. `event` must match `^[A-Za-z0-9_-]+$`, `id` must be a UUID (8-4-4-4-12 hex, case-insensitive), and `name` is optional.
- The image URL is `https://pbtnvpykoueiizsvjwlo.supabase.co/storage/v1/object/public/captures/<event>/<id>.jpg`. Every attempt appends `?t=<Date.now()>`.
- There are 5 states: `invalid`, `loading`, `uploading`, `later` and `ready`. It retries every 5000 ms, and `later` starts once 120000 ms have passed since the page opened.
- The copy is exactly:
  - `invalid`: "This link doesn't look right."
  - `uploading`: "Your photo is still uploading - hang on…"
  - `later`: "It's taking a while. This link keeps working - open it again later."
  - footer: "Photos by Kachak Productions"
  - button: "Save / Share"
- The share filename is `kachak-<event>-<first 8 chars of id>.jpg`. The page uses `navigator.share({ files })` when `navigator.canShare({ files })` is true, and an `<a download>` otherwise. It ignores `AbortError`.
- The colours are `--bg #15121a`, `--surface #211c28`, `--text #f5efe6`, `--muted #b9afc2`, `--accent #ff6a45` and `--on-accent #1a0f0b`. The fonts are Bricolage Grotesque (display) and Manrope (body) from Google Fonts. The logo is an orange dot plus "KACHAK", as in the kiosk.
- No new npm dependency and no build step for `download/`.
- Commit messages end with a blank line and then exactly `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## File map

| File | Role |
|---|---|
| `download/photo.js` (new) | Pure logic: `parseLink`, `imageUrl`, `waitingState`, `shareFileName` and constants |
| `tests/download.test.ts` (new) | vitest for `photo.js` |
| `download/index.html` (new) | Markup, styles, fonts, the 5 state blocks |
| `download/main.js` (new) | Browser wiring: load with retry, Save / Share |
| `supabase/migrations/20260928000000_public_capture_bucket.sql` (new) | Bucket public, drop the 2 anon policies |
| `download/README.md` (new) | What the page is, the URL format, the Vercel setup and a local preview |
| `kiosk/.env.example` | A full `VITE_DOWNLOAD_URL` example |

---

### Task 1: Page logic (`photo.js`) with tests

**Files:**
- Create: `download/photo.js`
- Test: `tests/download.test.ts`

**Interfaces:**
- Produces (named exports from `download/photo.js`):
  - `SUPABASE_URL: string`, `RETRY_MS = 5000`, `LATER_AFTER_MS = 120000`
  - `parseLink(search: string): { event: string, id: string, name: string | null } | null`
  - `imageUrl(link, now: number): string`
  - `waitingState(elapsedMs: number): "uploading" | "later"`
  - `shareFileName(link): string`

- [ ] **Step 1: Write the failing tests.** Create `tests/download.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { LATER_AFTER_MS, imageUrl, parseLink, shareFileName, waitingState } from "../download/photo.js";

const ID = "080984fe-674a-469b-83c6-493f9bf2d3d5";

describe("parseLink", () => {
  it("reads event, id and name", () => {
    expect(parseLink(`?event=gigsmore-launch-2026&name=Gigsmore%20Launch&id=${ID}`))
      .toEqual({ event: "gigsmore-launch-2026", id: ID, name: "Gigsmore Launch" });
  });

  it("treats a missing or blank name as null", () => {
    expect(parseLink(`?event=evt&id=${ID}`)?.name).toBeNull();
    expect(parseLink(`?event=evt&name=%20&id=${ID}`)?.name).toBeNull();
  });

  it("accepts an upper-case UUID", () => {
    expect(parseLink(`?event=evt&id=${ID.toUpperCase()}`)?.id).toBe(ID.toUpperCase());
  });

  it("rejects a missing or malformed event or id", () => {
    for (const search of [
      `?id=${ID}`,
      "?event=evt",
      "?event=evt&id=not-a-uuid",
      `?event=evt&id=${ID}x`,
      `?event=../other&id=${ID}`,
      `?event=a%2Fb&id=${ID}`,
      "",
    ]) {
      expect(parseLink(search), search).toBeNull();
    }
  });
});

describe("imageUrl", () => {
  it("is the public object URL with a cache-buster", () => {
    expect(imageUrl({ event: "gigsmore-launch-2026", id: ID, name: null }, 1234)).toBe(
      `https://pbtnvpykoueiizsvjwlo.supabase.co/storage/v1/object/public/captures/gigsmore-launch-2026/${ID}.jpg?t=1234`
    );
  });
});

describe("waitingState", () => {
  it("is uploading for the first two minutes, then later", () => {
    expect(waitingState(0)).toBe("uploading");
    expect(waitingState(LATER_AFTER_MS - 1)).toBe("uploading");
    expect(waitingState(LATER_AFTER_MS)).toBe("later");
    expect(waitingState(10 * 60_000)).toBe("later");
  });
});

describe("shareFileName", () => {
  it("names the file after the event and the id's first 8 characters", () => {
    expect(shareFileName({ event: "gigsmore-launch-2026", id: ID, name: null })).toBe("kachak-gigsmore-launch-2026-080984fe.jpg");
  });
});
```

- [ ] **Step 2: Run them to see them fail.** Run `npx vitest run tests/download.test.ts` from the repo root. Expected: FAIL, because `../download/photo.js` does not exist.

- [ ] **Step 3: Write `download/photo.js`.**

```js
// Pure logic for the guest download page (index.html + main.js). No DOM here, so vitest can test it.

export const SUPABASE_URL = "https://pbtnvpykoueiizsvjwlo.supabase.co";
export const RETRY_MS = 5000;
export const LATER_AFTER_MS = 120000;

const EVENT = /^[A-Za-z0-9_-]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `?event=<event_id>&name=<display name>&id=<captureId>`; null when event or id is missing or malformed. */
export function parseLink(search) {
  const params = new URLSearchParams(search);
  const event = params.get("event");
  const id = params.get("id");
  if (!event || !EVENT.test(event) || !id || !UUID.test(id)) return null;
  const name = params.get("name")?.trim();
  return { event, id, name: name || null };
}

/** The composite's public URL; `now` busts any cached 404 or stale image. */
export function imageUrl(link, now) {
  return `${SUPABASE_URL}/storage/v1/object/public/captures/${link.event}/${link.id}.jpg?t=${now}`;
}

/** What to show after a failed attempt, by time since the page opened. */
export function waitingState(elapsedMs) {
  return elapsedMs < LATER_AFTER_MS ? "uploading" : "later";
}

export function shareFileName(link) {
  return `kachak-${link.event}-${link.id.slice(0, 8)}.jpg`;
}
```

- [ ] **Step 4: Run the tests and see them pass.** Run `npx vitest run tests/download.test.ts`. Expected: PASS (7 tests). Then run `npx vitest run` and `npm run typecheck`. Expected: everything passes, and the typecheck is clean (`tests/` is excluded from `tsc`).

- [ ] **Step 5: Commit.**

```bash
git add download/photo.js tests/download.test.ts
git commit -F- <<'EOF'
feat(download): link parsing, image URL and wait states for the guest page

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 2: The page (`index.html` + `main.js`)

**Files:**
- Create: `download/index.html`, `download/main.js`

**Interfaces:**
- Consumes, from Task 1: `parseLink`, `imageUrl`, `waitingState`, `shareFileName` and `RETRY_MS` from `./photo.js`.
- Produces: a `body[data-state]` attribute set to one of `invalid | loading | uploading | later | ready`. The controller's browser check reads it.

- [ ] **Step 1: Create `download/index.html`.**

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="robots" content="noindex">
  <title>Your Kachak photo</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:wght@700;800&family=Manrope:wght@400;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #15121a; --surface: #211c28; --text: #f5efe6; --muted: #b9afc2;
      --accent: #ff6a45; --on-accent: #1a0f0b;
      --display: "Bricolage Grotesque", "Manrope", sans-serif;
      --body: "Manrope", system-ui, sans-serif;
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; background: var(--bg); color: var(--text); font-family: var(--body); }
    body { min-height: 100dvh; display: flex; flex-direction: column; align-items: center; padding: 24px 16px; gap: 20px; }
    main { width: 100%; max-width: 560px; display: flex; flex-direction: column; gap: 20px; flex-grow: 1; }
    .logo { display: flex; align-items: center; gap: 10px; font-family: var(--display); font-weight: 800; font-size: 20px; letter-spacing: 0.06em; }
    .logo-dot { width: 12px; height: 12px; border-radius: 50%; background: var(--accent); }
    h1 { margin: 0; font-family: var(--display); font-weight: 800; font-size: 28px; line-height: 1.1; }
    h1:empty { display: none; }
    .state { display: none; }
    body[data-state="invalid"] #state-invalid,
    body[data-state="loading"] #state-loading,
    body[data-state="uploading"] #state-uploading,
    body[data-state="later"] #state-later,
    body[data-state="ready"] #state-ready { display: flex; }
    .card { flex-direction: column; gap: 16px; align-items: center; justify-content: center; text-align: center;
            min-height: 260px; padding: 24px; border-radius: 20px; background: var(--surface); color: var(--muted); font-size: 18px; line-height: 1.4; }
    .spinner { width: 36px; height: 36px; border-radius: 50%; border: 4px solid var(--muted); border-top-color: var(--accent); animation: spin 1s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    #state-ready { flex-direction: column; gap: 16px; }
    #photo { width: 100%; border-radius: 12px; background: var(--surface); }
    button { font: 700 20px var(--body); padding: 18px; border: 0; border-radius: 999px; background: var(--accent); color: var(--on-accent); cursor: pointer; }
    button:disabled { opacity: 0.6; }
    footer { color: var(--muted); font-size: 14px; }
  </style>
  <script type="module" src="./main.js"></script>
</head>
<body data-state="loading">
  <main>
    <div class="logo"><span class="logo-dot"></span>KACHAK</div>
    <h1 id="event-name"></h1>

    <div id="state-invalid" class="state card">This link doesn't look right.</div>
    <div id="state-loading" class="state card"><div class="spinner"></div></div>
    <div id="state-uploading" class="state card"><div class="spinner"></div>Your photo is still uploading - hang on…</div>
    <div id="state-later" class="state card"><div class="spinner"></div>It's taking a while. This link keeps working - open it again later.</div>
    <div id="state-ready" class="state">
      <img id="photo" alt="Your photo">
      <button id="share" type="button">Save / Share</button>
    </div>
  </main>
  <footer>Photos by Kachak Productions</footer>
</body>
</html>
```

- [ ] **Step 2: Create `download/main.js`.**

```js
import { RETRY_MS, imageUrl, parseLink, shareFileName, waitingState } from "./photo.js";

const show = (state) => { document.body.dataset.state = state; };
const link = parseLink(location.search);
const openedAt = Date.now();
let file = null;

async function attempt() {
  try {
    const res = await fetch(imageUrl(link, Date.now()), { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    file = new File([blob], shareFileName(link), { type: "image/jpeg" });
    document.getElementById("photo").src = URL.createObjectURL(blob);
    show("ready");
  } catch {
    // Not uploaded yet (the booth syncs when it's online), or the network blinked.
    show(waitingState(Date.now() - openedAt));
    setTimeout(attempt, RETRY_MS);
  }
}

async function share() {
  if (!file) return;
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
    } catch (err) {
      if (err?.name !== "AbortError") throw err;
    }
    return;
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(file);
  a.download = file.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

if (!link) {
  show("invalid");
} else {
  if (link.name) {
    document.getElementById("event-name").textContent = link.name;
    document.title = `${link.name} · Your Kachak photo`;
  }
  document.getElementById("share").addEventListener("click", () => void share());
  void attempt();
}
```

- [ ] **Step 3: Run the tests.** Run `npx vitest run` from the repo root. Expected: PASS. Nothing here is unit-tested; this step confirms nothing broke.

- [ ] **Step 4: Check by hand (the controller does this).** Serve the folder with `npx serve download -l 5500` (npx fetches it; it is not a project dependency), or with any static server, and open these:
  1. `http://localhost:5500/?event=evt&id=bad`: the page shows "This link doesn't look right." and makes no request to supabase.co.
  2. `http://localhost:5500/?event=gigsmore-launch-2026&name=Gigsmore%20Launch&id=00000000-0000-4000-8000-000000000000`: the title reads "Gigsmore Launch", the page shows the uploading spinner, and it requests again every 5 s. The bucket is private until Task 3's SQL runs, so real photos also show `uploading` for now.
  3. At phone width (375 px) there is no horizontal scroll, and the footer sits at the bottom.

- [ ] **Step 5: Commit.**

```bash
git add download/index.html download/main.js
git commit -F- <<'EOF'
feat(download): guest page shows the print with Save / Share and waits for uploads

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 3: Supabase migration, README and kiosk env example

**Files:**
- Create: `supabase/migrations/20260928000000_public_capture_bucket.sql`, `download/README.md`
- Modify: `kiosk/.env.example` (the `VITE_DOWNLOAD_URL` comment)

**Interfaces:**
- Consumes: the page URL format from Task 2 (Global Constraints).

- [ ] **Step 1: Create the migration.** `supabase/migrations/20260928000000_public_capture_bucket.sql`:

```sql
-- The guest download page (download/) opens a single photo by its exact
-- public URL: captures/<event_id>/<captureId>.jpg. A public bucket serves an
-- object only by exact path; listing needs a SELECT policy, and after this
-- migration anon has none. The capture id is a random UUID, so only someone
-- given the QR code can open that photo.
--
-- The two anon policies from 20260814000000_captures.sql are dropped: with
-- them, anyone holding the anon key could list and download every capture.
-- booth-agent uses the service-role key, which bypasses RLS, so its uploads
-- and the captures upsert are unaffected.

update storage.buckets set public = true where id = 'captures';

drop policy if exists "anon can read capture files" on storage.objects;
drop policy if exists "anon can read captures" on public.captures;
```

- [ ] **Step 2: Create `download/README.md`.**

````markdown
# Guest download page

The page the kiosk's Done-screen QR code opens. It shows the guest's printed photo with a **Save / Share** button, and waits and retries while the booth is still uploading it.

The design is in `docs/superpowers/specs/2026-09-28-guest-download-page-design.md`.

## URL

```
https://<site>/?event=<event_id>&name=<display name>&id=<captureId>
```

Set this in the kiosk's `.env.local` with `{captureId}` as the placeholder, then rebuild the kiosk:

```
VITE_DOWNLOAD_URL=https://<site>/?event=gigsmore-launch-2026&name=Gigsmore%20Launch&id={captureId}
```

`event` must equal booth-agent's `event.id`: photos are stored at `captures/<event.id>/<captureId>.jpg`.

## One-time setup

1. In Supabase, open **SQL Editor** and run `supabase/migrations/20260928000000_public_capture_bucket.sql`. It makes the `captures` bucket public and removes anon's list and read access.
2. In Vercel, add a new project from this GitHub repo:
   - **Root Directory**: `download`;
   - **Framework Preset**: Other;
   - no build command; the output directory is the root itself.

   Each push to `master` then redeploys it.

## Local preview

```
npx serve download -l 5500
```

Open `http://localhost:5500/?event=<event_id>&id=<a synced captureId>`.
````

- [ ] **Step 3: Update `kiosk/.env.example`.** Replace the two lines

```
# Guest download page. {captureId} is replaced per photo. Leave empty to hide the QR code.
VITE_DOWNLOAD_URL=
```

with

```
# Guest download page (see download/README.md). {captureId} is replaced per photo. Leave empty to hide the QR code.
# e.g. https://<site>/?event=gigsmore-launch-2026&name=Gigsmore%20Launch&id={captureId}
VITE_DOWNLOAD_URL=
```

- [ ] **Step 4: Run the tests.** Run `npx vitest run`. Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add supabase/migrations/20260928000000_public_capture_bucket.sql download/README.md kiosk/.env.example
git commit -F- <<'EOF'
feat(download): public capture bucket migration, setup README and kiosk env example

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

## After the last task

- Push and open the PR. The deploy is not code: the user runs the SQL and sets up Vercel (`download/README.md`).
- Then check with a synced capture from 25 Sep, set `VITE_DOWNLOAD_URL` in `C:\BoothAgent\kiosk\.env.local`, and rebuild the kiosk.
