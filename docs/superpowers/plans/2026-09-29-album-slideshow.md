# Event Album and Slideshow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each event gets a secret-link album of every print. It shows as a grid, lets people open and save any photo, and plays a full-screen slideshow. The same page runs online (Vercel) and on the booth PC's second screen with no internet.

**Architecture:**
- booth-agent keeps a manifest `captures/<event>/albums/<token>.json` in the public bucket up to date. The sync worker marks the album dirty when a print uploads, and an `AlbumPublisher` rewrites the manifest from the Supabase `captures` table.
- For the local screen, the agent serves the same list from the outbox at `GET /album.json`, and the page's files from `download/` at `/album/`.
- One static page, `download/album.html`, reads either source.

**Tech Stack:** TypeScript/Express/supabase-js (agent), vanilla ES modules (page), React (kiosk operator panel), PowerShell (launcher), vitest.

**Spec:** `docs/superpowers/specs/2026-09-29-album-slideshow-design.md`

## Global Constraints

- Work from the worktree root `C:/Users/User/Documents/booth-agent-wt/album` (branch `feat/album-slideshow`). This branch builds on `feat/guest-download-page`; the page files live in its `download/` subfolder.
- No new npm dependency. No build step for `download/`.
- Album token format: `^[A-Za-z0-9_-]{16,}$`. Project ref (`p`) format: `^[a-z0-9]{20}$`. Event id format: `^[A-Za-z0-9_-]+$`.
- Manifest key: `<event.id>/albums/<token>.json` in the `captures` bucket, uploaded with `contentType: "application/json"`, `cacheControl: "10"`, `upsert: true`. Body: `{ "updatedAt": "<iso>", "photos": [{ "id": "<uuid>", "takenAt": "<iso>" }] }`.
- Online manifest URL: `<project>/storage/v1/object/public/captures/<event>/albums/<album>.json?t=<now>`. Online photo URL: `<project>/storage/v1/object/public/captures/<event>/<id>.jpg`. Here `<project>` is `https://<p>.supabase.co`, or `SUPABASE_URL` when there is no `p`.
- Local manifest URL: `/album.json?token=<token>&t=<now>`. Local photo URL: `/captures/<id>/image?variant=composite&token=<token>`.
- The manifest is polled every 15000 ms and a slide shows for 6000 ms. A failed manifest write is retried no sooner than 15000 ms later.
- The copy is exactly:
  - `invalid`: "This link doesn't look right."
  - `missing`: "No photos here yet - this album fills up as the booth prints."
  - `empty`: "No photos yet."
  - footer: "Photos by Kachak Productions"
  - Save button: "Save / Share"
- `/health` `album`: `{ enabled, photoCount, lastWrittenAt, lastError }`. The alert code is `album-write-failed` (warn).
- Commit messages end with a blank line and then exactly `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## File map

| File | Task | Role |
|---|---|---|
| `download/photo.js` | 1 | + `p` parameter, `parseProject`, `projectUrl`; exports `EVENT`, `UUID` |
| `download/share.js` (new) | 1 | `sharePhoto(file)`: the share sheet, or a download |
| `download/main.js` | 1 | uses `share.js` |
| `tests/download.test.ts`, `tests/share.test.ts` (new) | 1 | tests |
| `download/album-logic.js` (new), `tests/album.test.ts` (new) | 2 | album link, URLs, manifest merge, next slide |
| `download/album.html`, `download/album.js` (new) | 3 | the album page |
| `src/config/schema.ts` | 4 | `album.token` |
| `src/album/albumPublisher.ts` (new), `tests/album.publisher.test.ts` (new) | 4 | dirty tracking, write, retry, status |
| `src/supabase/albumStorage.ts` (new), `tests/album.storage.test.ts` (new) | 5 | the Supabase `AlbumBackend` |
| `src/outbox/syncWorker.ts`, `src/index.ts`, `tests/outbox.album.test.ts` (new) | 5 | the hooks and wiring |
| `src/outbox/outboxStore.ts`, `src/server/routes.ts`, `src/server/http.ts`, `src/server/context.ts`, `src/health/healthReport.ts`, `src/index.ts` | 6 | `/album.json`, `/album/*`, `/health` album |
| `tests/album.routes.test.ts`, `tests/album.health.test.ts` (new) | 6 | tests |
| `kiosk/src/agent.ts`, `kiosk/src/Operator.tsx` | 7 | the Status tab ALBUM card |
| `kiosk/start-slideshow.ps1` (new), `download/README.md`, `kiosk/README.md` | 7 | the launcher and docs |

---

### Task 1: Project parameter and shared Save / Share

**Files:**
- Modify: `download/photo.js`, `download/main.js`, `tests/download.test.ts`
- Create: `download/share.js`, `tests/share.test.ts`

**Interfaces:**
- Produces, from `download/photo.js`:
  - `export const EVENT: RegExp` and `export const UUID: RegExp`;
  - `parseProject(params: URLSearchParams): string | null | undefined` (null when absent, undefined when malformed);
  - `projectUrl(link: { project: string | null }): string`;
  - `parseLink` now returns `{ event, id, name, project }`.
- Produces, from `download/share.js`: `sharePhoto(file: File): Promise<void>`.

- [ ] **Step 1: Update the download tests (failing).** In `tests/download.test.ts`:
  - change the import line to

```ts
import { LATER_AFTER_MS, imageUrl, parseLink, projectUrl, shareFileName, waitingState } from "../download/photo.js";
```

  - in `it("reads event, id and name", ...)` change the expected object to `{ event: "gigsmore-launch-2026", id: ID, name: "Gigsmore Launch", project: null }`;
  - in `it("rejects a missing or malformed event or id", ...)` add these two entries to the array: `` `?event=evt&id=${ID}&p=NOT-A-REF` `` and `` `?event=evt&id=${ID}&p=abc` ``;
  - change the two `{ event: "gigsmore-launch-2026", id: ID, name: null }` literals (in `imageUrl` and `shareFileName`) to `{ event: "gigsmore-launch-2026", id: ID, name: null, project: null }`;
  - add at the end:

```ts
describe("project", () => {
  it("reads p as the Supabase project ref", () => {
    expect(parseLink(`?event=evt&id=${ID}&p=abcdefghijklmnopqrst`)?.project).toBe("abcdefghijklmnopqrst");
  });

  it("points at p's project, or the default without it", () => {
    expect(projectUrl({ project: "abcdefghijklmnopqrst" })).toBe("https://abcdefghijklmnopqrst.supabase.co");
    expect(projectUrl({ project: null })).toBe("https://pbtnvpykoueiizsvjwlo.supabase.co");
    expect(imageUrl({ event: "evt", id: ID, name: null, project: "abcdefghijklmnopqrst" }, 7)).toBe(
      `https://abcdefghijklmnopqrst.supabase.co/storage/v1/object/public/captures/evt/${ID}.jpg?t=7`
    );
  });
});
```

- [ ] **Step 2: Write `tests/share.test.ts`.**

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { sharePhoto } from "../download/share.js";

const file = new File([new Uint8Array([1, 2, 3])], "kachak-evt-12345678.jpg", { type: "image/jpeg" });

/** Stands in for document.createElement("a") and records each download click. */
function stubDownload() {
  const clicks: Array<{ href: string; download: string }> = [];
  vi.stubGlobal("document", {
    createElement: () => {
      const a = { href: "", download: "", click: () => clicks.push({ href: a.href, download: a.download }) };
      return a;
    },
  });
  return clicks;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sharePhoto", () => {
  it("uses the share sheet when it takes files", async () => {
    const share = vi.fn(async () => {});
    vi.stubGlobal("navigator", { canShare: () => true, share });
    const clicks = stubDownload();
    await sharePhoto(file);
    expect(share).toHaveBeenCalledWith({ files: [file] });
    expect(clicks).toEqual([]);
  });

  it("does nothing more when the guest cancels", async () => {
    vi.stubGlobal("navigator", { canShare: () => true, share: async () => { throw new DOMException("cancelled", "AbortError"); } });
    const clicks = stubDownload();
    await sharePhoto(file);
    expect(clicks).toEqual([]);
  });

  it("downloads when sharing fails for another reason", async () => {
    vi.stubGlobal("navigator", { canShare: () => true, share: async () => { throw new DOMException("busy", "InvalidStateError"); } });
    const clicks = stubDownload();
    await sharePhoto(file);
    expect(clicks).toHaveLength(1);
    expect(clicks[0].download).toBe("kachak-evt-12345678.jpg");
  });

  it("downloads when the browser can't share files", async () => {
    vi.stubGlobal("navigator", {});
    const clicks = stubDownload();
    await sharePhoto(file);
    expect(clicks).toHaveLength(1);
  });
});
```

- [ ] **Step 3: Run them to see them fail.** Run `npx vitest run tests/download.test.ts tests/share.test.ts`. Expected: FAIL. `projectUrl` is not exported, `project` is missing from the parsed link, and `../download/share.js` does not exist.

- [ ] **Step 4: Update `download/photo.js`.** Replace the two regex constants and `parseLink`/`imageUrl` so the file reads, from the constants onwards:

```js
export const EVENT = /^[A-Za-z0-9_-]+$/;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROJECT = /^[a-z0-9]{20}$/;

/** `?event=<event_id>&name=<display name>&id=<captureId>[&p=<project ref>]`; null when anything is missing or malformed. */
export function parseLink(search) {
  const params = new URLSearchParams(search);
  const event = params.get("event");
  const id = params.get("id");
  if (!event || !EVENT.test(event) || !id || !UUID.test(id)) return null;
  const project = parseProject(params);
  if (project === undefined) return null;
  const name = params.get("name")?.trim();
  return { event, id, name: name || null, project };
}

/** `p`, the Supabase project ref of an event with its own project: null when absent, undefined when malformed. */
export function parseProject(params) {
  const p = params.get("p");
  if (p === null) return null;
  return PROJECT.test(p) ? p : undefined;
}

/** The link's Supabase project: `p` when given, else SUPABASE_URL. */
export function projectUrl(link) {
  return link.project ? `https://${link.project}.supabase.co` : SUPABASE_URL;
}

/** The composite's public URL; `now` busts any cached 404 or stale image. */
export function imageUrl(link, now) {
  return `${projectUrl(link)}/storage/v1/object/public/captures/${link.event}/${link.id}.jpg?t=${now}`;
}
```

  Keep `waitingState` and `shareFileName` unchanged below it. Also change the comment above `SUPABASE_URL` to:

```js
// The default project. An event with its own Supabase project passes `p=<project ref>`
// in the link instead (see download/README.md).
```

- [ ] **Step 5: Create `download/share.js`.**

```js
// Save / Share for a photo, used by the download page and the album.

/** The phone's share sheet when it can take files, otherwise a plain download. A cancelled share is not an error. */
export async function sharePhoto(file) {
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return;
    } catch (err) {
      if (err?.name === "AbortError") return;
      // Share failed for another reason: fall back to a plain download.
    }
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(file);
  a.download = file.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}
```

- [ ] **Step 6: Use it in `download/main.js`.** Add `import { sharePhoto } from "./share.js";` under the existing import. Then replace the whole `share()` function with:

```js
async function share() {
  if (!file) return;
  const button = document.getElementById("share");
  button.disabled = true;
  try {
    await sharePhoto(file);
  } finally {
    button.disabled = false;
  }
}
```

- [ ] **Step 7: Run the tests.** Run `npx vitest run tests/download.test.ts tests/share.test.ts`. Expected: PASS. Then run `npx vitest run` (everything passes) and `npm run typecheck` (clean).

- [ ] **Step 8: Commit.**

```bash
git add download/photo.js download/share.js download/main.js tests/download.test.ts tests/share.test.ts
git commit -F- <<'EOF'
feat(download): optional project ref in links, shared Save / Share

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 2: Album page logic (`album-logic.js`)

**Files:**
- Create: `download/album-logic.js`, `tests/album.test.ts`

**Interfaces:**
- Consumes, from Task 1: `EVENT`, `UUID`, `parseProject`, `projectUrl` from `./photo.js`.
- Produces, from `download/album-logic.js`:
  - `POLL_MS = 15000`, `SLIDE_MS = 6000`;
  - `parseAlbumLink(search)` returns `{ source: "online", event, album, name, project, play }`, `{ source: "local", token, name, play }` or `null`;
  - `manifestUrl(link, now: number): string`, `photoUrl(link, id: string): string`, `albumFileName(link, id: string): string`;
  - `manifestIds(manifest: unknown): string[]`, `newIds(known: string[], ids: string[]): string[]`;
  - `nextSlide(order: string[], queue: string[], current: string | null): { current: string | null, queue: string[] }`.

- [ ] **Step 1: Write the failing tests.** Create `tests/album.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { albumFileName, manifestIds, manifestUrl, newIds, nextSlide, parseAlbumLink, photoUrl } from "../download/album-logic.js";

const ID1 = "080984fe-674a-469b-83c6-493f9bf2d3d5";
const ID2 = "1b2c3d4e-0000-4000-8000-000000000002";
const ID3 = "1b2c3d4e-0000-4000-8000-000000000003";
const TOKEN = "Abc123_-Abc123_-xyz";
const DEFAULT = "https://pbtnvpykoueiizsvjwlo.supabase.co/storage/v1/object/public/captures";

describe("parseAlbumLink", () => {
  it("reads an online link", () => {
    expect(parseAlbumLink(`?event=gigsmore-launch-2026&name=Gigsmore%20Launch&album=${TOKEN}`)).toEqual({
      source: "online", event: "gigsmore-launch-2026", album: TOKEN, name: "Gigsmore Launch", project: null, play: false,
    });
  });

  it("reads p and play", () => {
    expect(parseAlbumLink(`?event=evt&album=${TOKEN}&p=abcdefghijklmnopqrst&play=1`)).toMatchObject({
      project: "abcdefghijklmnopqrst", play: true,
    });
  });

  it("reads a local link", () => {
    expect(parseAlbumLink("?local=1&token=s3cret&name=Gigsmore&play=1")).toEqual({
      source: "local", token: "s3cret", name: "Gigsmore", play: true,
    });
  });

  it("rejects missing or malformed values", () => {
    for (const search of [
      `?album=${TOKEN}`,
      "?event=evt",
      "?event=evt&album=tooshort",
      `?event=../x&album=${TOKEN}`,
      `?event=evt&album=${TOKEN}&p=NOT-A-REF`,
      `?event=evt&album=${TOKEN}&p=abc`,
      "?local=1",
      "",
    ]) {
      expect(parseAlbumLink(search), search).toBeNull();
    }
  });
});

describe("URLs", () => {
  it("builds online manifest and photo URLs on the default project", () => {
    const link = parseAlbumLink(`?event=evt&album=${TOKEN}`);
    expect(manifestUrl(link, 42)).toBe(`${DEFAULT}/evt/albums/${TOKEN}.json?t=42`);
    expect(photoUrl(link, ID1)).toBe(`${DEFAULT}/evt/${ID1}.jpg`);
  });

  it("uses p as the project", () => {
    const link = parseAlbumLink(`?event=evt&album=${TOKEN}&p=abcdefghijklmnopqrst`);
    expect(photoUrl(link, ID1)).toBe(`https://abcdefghijklmnopqrst.supabase.co/storage/v1/object/public/captures/evt/${ID1}.jpg`);
  });

  it("builds local URLs against the agent, carrying the token", () => {
    const link = parseAlbumLink("?local=1&token=a%26b");
    expect(manifestUrl(link, 42)).toBe("/album.json?token=a%26b&t=42");
    expect(photoUrl(link, ID1)).toBe(`/captures/${ID1}/image?variant=composite&token=a%26b`);
  });

  it("names saved files after the event, or 'album' locally", () => {
    expect(albumFileName(parseAlbumLink(`?event=evt&album=${TOKEN}`), ID1)).toBe("kachak-evt-080984fe.jpg");
    expect(albumFileName(parseAlbumLink("?local=1&token=x"), ID1)).toBe("kachak-album-080984fe.jpg");
  });
});

describe("manifestIds", () => {
  it("returns the ids in order and drops anything malformed", () => {
    expect(manifestIds({ updatedAt: "x", photos: [{ id: ID1 }, { id: "../evil" }, null, { id: ID2 }, { nope: 1 }] })).toEqual([ID1, ID2]);
  });

  it("is empty for a manifest that isn't one", () => {
    expect(manifestIds(null)).toEqual([]);
    expect(manifestIds({ photos: "no" })).toEqual([]);
  });
});

describe("newIds", () => {
  it("returns the ids not seen before, in manifest order", () => {
    expect(newIds([ID1], [ID1, ID2, ID3])).toEqual([ID2, ID3]);
    expect(newIds([ID1, ID2], [ID1, ID2])).toEqual([]);
  });
});

describe("nextSlide", () => {
  it("plays new arrivals first", () => {
    expect(nextSlide([ID1, ID2, ID3], [ID3], ID1)).toEqual({ current: ID3, queue: [] });
  });

  it("otherwise moves on through the album and loops", () => {
    expect(nextSlide([ID1, ID2], [], ID1)).toEqual({ current: ID2, queue: [] });
    expect(nextSlide([ID1, ID2], [], ID2)).toEqual({ current: ID1, queue: [] });
  });

  it("starts at the top when nothing is showing yet", () => {
    expect(nextSlide([ID1, ID2], [], null)).toEqual({ current: ID1, queue: [] });
  });

  it("has nothing to show for an empty album", () => {
    expect(nextSlide([], [], null)).toEqual({ current: null, queue: [] });
  });
});
```

- [ ] **Step 2: Run them to see them fail.** Run `npx vitest run tests/album.test.ts`. Expected: FAIL, because `../download/album-logic.js` does not exist.

- [ ] **Step 3: Write `download/album-logic.js`.**

```js
// Pure logic for the album page (album.html + album.js). No DOM here, so vitest can test it.
import { EVENT, UUID, parseProject, projectUrl } from "./photo.js";

export const POLL_MS = 15000;
export const SLIDE_MS = 6000;

const ALBUM = /^[A-Za-z0-9_-]{16,}$/;

/**
 * Online: `?event=<event_id>&album=<token>[&name=][&p=][&play=1]`.
 * Local, served by booth-agent: `?local=1&token=<agent shared secret>[&name=][&play=1]`.
 * Null when anything required is missing or malformed.
 */
export function parseAlbumLink(search) {
  const params = new URLSearchParams(search);
  const name = params.get("name")?.trim() || null;
  const play = params.get("play") === "1";
  if (params.get("local") === "1") {
    const token = params.get("token");
    return token ? { source: "local", token, name, play } : null;
  }
  const event = params.get("event");
  const album = params.get("album");
  if (!event || !EVENT.test(event) || !album || !ALBUM.test(album)) return null;
  const project = parseProject(params);
  if (project === undefined) return null;
  return { source: "online", event, album, name, project, play };
}

/** Where the list of photos is; `now` busts any cached copy. */
export function manifestUrl(link, now) {
  if (link.source === "local") return `/album.json?token=${encodeURIComponent(link.token)}&t=${now}`;
  return `${projectUrl(link)}/storage/v1/object/public/captures/${link.event}/albums/${link.album}.json?t=${now}`;
}

export function photoUrl(link, id) {
  if (link.source === "local") {
    return `/captures/${encodeURIComponent(id)}/image?variant=composite&token=${encodeURIComponent(link.token)}`;
  }
  return `${projectUrl(link)}/storage/v1/object/public/captures/${link.event}/${id}.jpg`;
}

export function albumFileName(link, id) {
  return `kachak-${link.source === "online" ? link.event : "album"}-${id.slice(0, 8)}.jpg`;
}

/** The photo ids in a manifest, in order. Anything malformed is dropped rather than breaking the page. */
export function manifestIds(manifest) {
  if (!manifest || !Array.isArray(manifest.photos)) return [];
  return manifest.photos.map((photo) => photo?.id).filter((id) => typeof id === "string" && UUID.test(id));
}

/** The ids in `ids` that aren't in `known`, in `ids` order. */
export function newIds(known, ids) {
  const seen = new Set(known);
  return ids.filter((id) => !seen.has(id));
}

/**
 * The slideshow's next photo. Photos that arrived while it was playing (`queue`) go first, in arrival
 * order; otherwise it moves on from `current` through `order`, looping, and starts at the top when
 * `current` is null or no longer in the album.
 */
export function nextSlide(order, queue, current) {
  if (queue.length > 0) return { current: queue[0], queue: queue.slice(1) };
  if (order.length === 0) return { current: null, queue };
  return { current: order[(order.indexOf(current) + 1) % order.length], queue };
}
```

- [ ] **Step 4: Run the tests.** Run `npx vitest run tests/album.test.ts`. Expected: PASS (15 tests). Then run `npx vitest run`: everything passes.

- [ ] **Step 5: Commit.**

```bash
git add download/album-logic.js tests/album.test.ts
git commit -F- <<'EOF'
feat(album): link parsing, URLs and slideshow order for the album page

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 3: The album page (`album.html` + `album.js`)

**Files:**
- Create: `download/album.html`, `download/album.js`

**Interfaces:**
- Consumes, from Task 1: `sharePhoto` from `./share.js`. From Task 2: `POLL_MS`, `SLIDE_MS`, `albumFileName`, `manifestIds`, `manifestUrl`, `newIds`, `nextSlide`, `parseAlbumLink` and `photoUrl` from `./album-logic.js`.
- Produces:
  - `body[data-state]` set to one of `invalid | loading | missing | empty | ready`;
  - `body.playing` while the slideshow runs;
  - the element ids `grid`, `play`, `viewer`, `save`, `show`.

  The controller's browser check reads these.

- [ ] **Step 1: Create `download/album.html`.**

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="robots" content="noindex">
  <title>Kachak album</title>
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
    main { width: 100%; max-width: 1200px; display: flex; flex-direction: column; gap: 20px; flex-grow: 1; }
    header { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
    .logo { display: flex; align-items: center; gap: 10px; font-family: var(--display); font-weight: 800; font-size: 20px; letter-spacing: 0.06em; }
    .logo-dot { width: 12px; height: 12px; border-radius: 50%; background: var(--accent); }
    h1 { margin: 0; font-family: var(--display); font-weight: 800; font-size: 28px; line-height: 1.1; }
    h1:empty { display: none; }
    button { font: 700 18px var(--body); padding: 14px 24px; border: 0; border-radius: 999px; background: var(--accent); color: var(--on-accent); cursor: pointer; }
    button:disabled { opacity: 0.6; }
    button.quiet { background: var(--bg); color: var(--text); }
    #play { display: none; }
    body[data-state="ready"] #play { display: block; }
    .state { display: none; }
    body[data-state="invalid"] #state-invalid,
    body[data-state="loading"] #state-loading,
    body[data-state="missing"] #state-missing,
    body[data-state="empty"] #state-empty { display: flex; }
    body[data-state="ready"] #grid { display: grid; }
    .card { flex-direction: column; gap: 16px; align-items: center; justify-content: center; text-align: center;
            min-height: 260px; padding: 24px; border-radius: 20px; background: var(--surface); color: var(--muted); font-size: 18px; line-height: 1.4; }
    .spinner { width: 36px; height: 36px; border-radius: 50%; border: 4px solid var(--muted); border-top-color: var(--accent); animation: spin 1s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    #grid { grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 12px; }
    .thumb { padding: 0; aspect-ratio: 1; border-radius: 12px; overflow: hidden; background: var(--surface); }
    .thumb img { display: block; width: 100%; height: 100%; object-fit: contain; }
    dialog { width: min(100vw, 900px); max-width: 100vw; max-height: 100dvh; padding: 16px; border: 0; border-radius: 20px; background: var(--surface); color: var(--text); }
    dialog::backdrop { background: rgba(0, 0, 0, 0.8); }
    #viewer-photo { display: block; width: 100%; max-height: 70dvh; object-fit: contain; border-radius: 12px; background: var(--bg); }
    .viewer-bar { display: flex; gap: 12px; justify-content: space-between; margin-top: 16px; }
    #show { display: none; position: fixed; inset: 0; z-index: 10; background: #000; }
    body.playing { overflow: hidden; }
    body.playing #show { display: block; }
    #show img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; opacity: 0; transition: opacity 0.8s; }
    #show img.on { opacity: 1; }
    #show.idle { cursor: none; }
    footer { color: var(--muted); font-size: 14px; }
  </style>
  <script type="module" src="./album.js"></script>
</head>
<body data-state="loading">
  <main>
    <header>
      <div class="logo"><span class="logo-dot"></span>KACHAK</div>
      <button id="play" type="button">▶ Play</button>
    </header>
    <h1 id="event-name"></h1>

    <div id="state-invalid" class="state card" role="status" aria-live="polite">This link doesn't look right.</div>
    <div id="state-loading" class="state card"><div class="spinner"></div></div>
    <div id="state-missing" class="state card" role="status" aria-live="polite">No photos here yet - this album fills up as the booth prints.</div>
    <div id="state-empty" class="state card" role="status" aria-live="polite">No photos yet.</div>
    <div id="grid" class="state"></div>
  </main>
  <footer>Photos by Kachak Productions</footer>

  <dialog id="viewer">
    <img id="viewer-photo" alt="Selected photo">
    <div class="viewer-bar">
      <button id="prev" class="quiet" type="button" aria-label="Previous photo">‹</button>
      <button id="save" type="button">Save / Share</button>
      <button id="next" class="quiet" type="button" aria-label="Next photo">›</button>
      <button id="close" class="quiet" type="button" aria-label="Close">✕</button>
    </div>
  </dialog>

  <div id="show" aria-hidden="true">
    <img id="slide-a" alt="">
    <img id="slide-b" alt="">
  </div>
</body>
</html>
```

- [ ] **Step 2: Create `download/album.js`.**

```js
import { POLL_MS, SLIDE_MS, albumFileName, manifestIds, manifestUrl, newIds, nextSlide, parseAlbumLink, photoUrl } from "./album-logic.js";
import { sharePhoto } from "./share.js";

const $ = (id) => document.getElementById(id);
const show = (state) => { document.body.dataset.state = state; };
const link = parseAlbumLink(location.search);

let order = []; // every photo id, in taken order
let queue = []; // photos that arrived while the page was open; the slideshow plays these next
let loaded = false; // a manifest has been read at least once

// --- The list of photos ---------------------------------------------------

async function poll() {
  try {
    const res = await fetch(manifestUrl(link, Date.now()), { cache: "no-store", signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const ids = manifestIds(await res.json());
    const added = newIds(order, ids);
    if (loaded) queue.push(...added);
    order = ids;
    loaded = true;
    for (const id of added) $("grid").append(thumb(id));
    show(order.length > 0 ? "ready" : "empty");
  } catch {
    // Not written yet, or the network blinked: keep whatever is showing (and playing).
    if (!loaded) show("missing");
  }
  setTimeout(poll, POLL_MS);
}

function thumb(id) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "thumb";
  const img = document.createElement("img");
  img.loading = "lazy";
  img.alt = "Photo";
  img.src = photoUrl(link, id);
  button.append(img);
  button.addEventListener("click", () => void openViewer(order.indexOf(id)));
  return button;
}

// --- One photo, with Save / Share -----------------------------------------

let viewing = -1;
let viewerFile = null;
let viewerUrl = null;

async function openViewer(index) {
  if (index < 0 || index >= order.length) return;
  viewing = index;
  const id = order[index];
  viewerFile = null;
  $("save").disabled = true;
  if (!$("viewer").open) $("viewer").showModal();
  try {
    // Loaded as a blob up front so Save / Share can hand it straight to the share sheet:
    // iOS only allows sharing right after the tap, not after a download.
    const res = await fetch(photoUrl(link, id), { signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    if (order[viewing] !== id) return; // moved on meanwhile
    if (viewerUrl) URL.revokeObjectURL(viewerUrl);
    viewerUrl = URL.createObjectURL(blob);
    $("viewer-photo").src = viewerUrl;
    viewerFile = new File([blob], albumFileName(link, id), { type: "image/jpeg" });
    $("save").disabled = false;
  } catch {
    // Show it straight from the network; Save stays off.
    if (order[viewing] === id) $("viewer-photo").src = photoUrl(link, id);
  }
}

function step(delta) {
  if (order.length > 0) void openViewer((viewing + delta + order.length) % order.length);
}

async function save() {
  if (!viewerFile) return;
  $("save").disabled = true;
  try {
    await sharePhoto(viewerFile);
  } finally {
    $("save").disabled = false;
  }
}

// --- Slideshow ------------------------------------------------------------

let current = null;
let front = 0; // which of #slide-a / #slide-b is showing
let slideTimer;
let idleTimer;

function play() {
  document.body.classList.add("playing");
  // Only works from a tap; with play=1 the screen's kiosk-mode browser is already full screen.
  document.documentElement.requestFullscreen?.().catch(() => {});
  wake();
  advance();
}

function stop() {
  document.body.classList.remove("playing");
  clearTimeout(slideTimer);
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
}

function advance() {
  clearTimeout(slideTimer);
  if (!document.body.classList.contains("playing")) return;
  ({ current, queue } = nextSlide(order, queue, current));
  if (!current) {
    slideTimer = setTimeout(advance, SLIDE_MS); // nothing to show yet
    return;
  }
  const slides = [$("slide-a"), $("slide-b")];
  const next = slides[1 - front];
  const reveal = () => {
    next.classList.add("on");
    slides[front].classList.remove("on");
    front = 1 - front;
    slideTimer = setTimeout(advance, SLIDE_MS);
  };
  const url = new URL(photoUrl(link, current), location.href).href;
  if (next.src === url && next.complete && next.naturalWidth > 0) {
    reveal(); // already loaded: an album of one or two photos
    return;
  }
  next.onload = reveal;
  next.onerror = () => { slideTimer = setTimeout(advance, 1000); }; // skip it; it comes round again next loop
  next.src = url;
}

function wake() {
  $("show").classList.remove("idle");
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => $("show").classList.add("idle"), 3000);
}

if (!link) {
  show("invalid");
} else {
  if (link.name) {
    $("event-name").textContent = link.name;
    document.title = `${link.name} · Kachak album`;
  }
  $("play").addEventListener("click", play);
  $("show").addEventListener("click", stop);
  $("show").addEventListener("mousemove", wake);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") stop(); });
  document.addEventListener("fullscreenchange", () => { if (!document.fullscreenElement) stop(); });
  $("prev").addEventListener("click", () => step(-1));
  $("next").addEventListener("click", () => step(1));
  $("close").addEventListener("click", () => $("viewer").close());
  $("save").addEventListener("click", () => void save());
  if (link.play) play();
  void poll();
}
```

- [ ] **Step 3: Run the tests.** Run `npx vitest run` from the repo root. Expected: PASS. Nothing here is unit-tested; this step confirms nothing broke.

- [ ] **Step 4: Check by hand (the controller does this).** Before Task 6 there is no agent route, so the controller serves `download/` together with a stub `album.json` and stub images from a scratch server, and checks:
  1. `album.html?event=evt&album=bad`: shows `invalid` and makes no request.
  2. With the stub manifest: the grid, the viewer (prev/next/close, Save enabled after load), and Play, which runs the slideshow, fades, and stops on Esc or a click.
  3. Add an id to the stub manifest mid-show: it plays next within 15 + 6 s and appears in the grid.
  4. At 375 px wide there is no horizontal scroll.

- [ ] **Step 5: Commit.**

```bash
git add download/album.html download/album.js
git commit -F- <<'EOF'
feat(album): album page with grid, Save / Share and a live slideshow

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 4: Album config and `AlbumPublisher`

**Files:**
- Modify: `src/config/schema.ts` (after the `event` block)
- Create: `src/album/albumPublisher.ts`, `tests/album.publisher.test.ts`

**Interfaces:**
- Produces:
  - `BoothConfig["album"]` is `{ token?: string }` and defaults to `{}`.
  - From `src/album/albumPublisher.ts`:
    - `ALBUM_RETRY_MS = 15_000`;
    - types `AlbumPhoto { id: string; takenAt: string }`, `AlbumManifest { updatedAt: string; photos: AlbumPhoto[] }`, `AlbumBackend`, `AlbumTarget { eventId: string; token: string | undefined }` and `AlbumStatus { enabled: boolean; photoCount: number | null; lastWrittenAt: string | null; lastError: string | null }`;
    - `class AlbumPublisher { constructor(backend, target: () => AlbumTarget, now?: () => number); markDirty(): void; publishIfDirty(): Promise<void>; getStatus(): AlbumStatus }`.
  - `AlbumBackend` is:

```ts
export interface AlbumBackend {
  listPrints(eventId: string): Promise<AlbumPhoto[]>;
  writeManifest(eventId: string, token: string, manifest: AlbumManifest): Promise<void>;
  removeOtherManifests(eventId: string, keepToken: string): Promise<void>;
}
```

- [ ] **Step 1: Write the failing tests.** Create `tests/album.publisher.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { ALBUM_RETRY_MS, AlbumBackend, AlbumManifest, AlbumPhoto, AlbumPublisher } from "../src/album/albumPublisher";
import { BoothConfigSchema } from "../src/config/schema";

class FakeBackend implements AlbumBackend {
  prints: AlbumPhoto[] = [];
  listed: string[] = [];
  written: Array<{ eventId: string; token: string; manifest: AlbumManifest }> = [];
  cleaned: Array<{ eventId: string; keepToken: string }> = [];
  failWrites = 0;
  failCleanup = false;
  onList: (() => void) | null = null;

  async listPrints(eventId: string): Promise<AlbumPhoto[]> {
    this.listed.push(eventId);
    this.onList?.();
    return this.prints;
  }
  async writeManifest(eventId: string, token: string, manifest: AlbumManifest): Promise<void> {
    if (this.failWrites > 0) {
      this.failWrites -= 1;
      throw new Error("offline");
    }
    this.written.push({ eventId, token, manifest });
  }
  async removeOtherManifests(eventId: string, keepToken: string): Promise<void> {
    if (this.failCleanup) throw new Error("list failed");
    this.cleaned.push({ eventId, keepToken });
  }
}

const TOKEN = "tok-0123456789abcdef";

function setup(token: string | undefined = TOKEN) {
  const backend = new FakeBackend();
  let now = 1_000_000;
  const target = { eventId: "evt", token };
  const publisher = new AlbumPublisher(backend, () => target, () => now);
  return { backend, publisher, target, advance: (ms: number) => { now += ms; } };
}

describe("AlbumPublisher", () => {
  it("writes once at startup, then only when marked dirty", async () => {
    const { backend, publisher } = setup();
    await publisher.publishIfDirty();
    await publisher.publishIfDirty();
    expect(backend.written).toHaveLength(1);
    publisher.markDirty();
    await publisher.publishIfDirty();
    expect(backend.written).toHaveLength(2);
  });

  it("writes this event's prints, stamped with the time, and reports it", async () => {
    const { backend, publisher } = setup();
    backend.prints = [{ id: "a", takenAt: "2026-09-29T10:00:00.000Z" }];
    await publisher.publishIfDirty();
    const at = new Date(1_000_000).toISOString();
    expect(backend.listed).toEqual(["evt"]);
    expect(backend.written[0]).toEqual({ eventId: "evt", token: TOKEN, manifest: { updatedAt: at, photos: backend.prints } });
    expect(publisher.getStatus()).toEqual({ enabled: true, photoCount: 1, lastWrittenAt: at, lastError: null });
  });

  it("retries a failed write, but no sooner than ALBUM_RETRY_MS", async () => {
    const { backend, publisher, advance } = setup();
    backend.failWrites = 1;
    await publisher.publishIfDirty();
    expect(publisher.getStatus().lastError).toBe("offline");
    await publisher.publishIfDirty();
    expect(backend.listed).toHaveLength(1);
    advance(ALBUM_RETRY_MS);
    await publisher.publishIfDirty();
    expect(backend.written).toHaveLength(1);
    expect(publisher.getStatus().lastError).toBeNull();
  });

  it("removes other manifests after a write; a failed cleanup doesn't undo the write", async () => {
    const { backend, publisher } = setup();
    await publisher.publishIfDirty();
    expect(backend.cleaned).toEqual([{ eventId: "evt", keepToken: TOKEN }]);

    const other = setup();
    other.backend.failCleanup = true;
    await other.publisher.publishIfDirty();
    await other.publisher.publishIfDirty();
    expect(other.backend.written).toHaveLength(1);
    expect(other.publisher.getStatus().lastError).toBeNull();
  });

  it("keeps a print that lands during a write for the next pass", async () => {
    const { backend, publisher } = setup();
    backend.onList = () => {
      backend.onList = null;
      publisher.markDirty();
    };
    await publisher.publishIfDirty();
    await publisher.publishIfDirty();
    expect(backend.written).toHaveLength(2);
  });

  it("rewrites when the token changes", async () => {
    const { backend, publisher, target } = setup();
    await publisher.publishIfDirty();
    target.token = "new-0123456789abcdef";
    await publisher.publishIfDirty();
    expect(backend.written.map((w) => w.token)).toEqual([TOKEN, "new-0123456789abcdef"]);
  });

  it("does nothing without a token", async () => {
    const { backend, publisher } = setup(undefined);
    await publisher.publishIfDirty();
    expect(backend.listed).toEqual([]);
    expect(publisher.getStatus()).toEqual({ enabled: false, photoCount: null, lastWrittenAt: null, lastError: null });
  });
});

describe("album config", () => {
  const album = BoothConfigSchema.shape.album;

  it("is optional and defaults to no token", () => {
    expect(album.parse(undefined)).toEqual({});
  });

  it("takes a token of at least 16 URL-safe characters", () => {
    expect(album.parse({ token: TOKEN })).toEqual({ token: TOKEN });
    expect(() => album.parse({ token: "short" })).toThrow();
    expect(() => album.parse({ token: "has spaces in it, too long" })).toThrow();
  });
});
```

- [ ] **Step 2: Run them to see them fail.** Run `npx vitest run tests/album.publisher.test.ts`. Expected: FAIL, because `../src/album/albumPublisher` does not exist.

- [ ] **Step 3: Add the config.** In `src/config/schema.ts`, directly after the closing `}),` of the `event: z.object({...})` block, add:

```ts
  album: z
    .object({
      // The secret in the event album's link (download/README.md). While it is
      // unset the agent writes no album manifest at all.
      token: z.string().regex(/^[A-Za-z0-9_-]{16,}$/).optional(),
    })
    .default({}),
```

- [ ] **Step 4: Write `src/album/albumPublisher.ts`.**

```ts
import { createLogger } from "../util/logger";

const log = createLogger("album");

/** A failed write is retried no sooner than this, so an offline booth isn't calling Supabase every tick. */
export const ALBUM_RETRY_MS = 15_000;
/** The same failure is logged at most this often. */
const REPEAT_QUIET_MS = 60_000;

export interface AlbumPhoto {
  id: string;
  takenAt: string;
}

export interface AlbumManifest {
  updatedAt: string;
  photos: AlbumPhoto[];
}

/** Where the manifest lives. The real one is Supabase (src/supabase/albumStorage.ts); tests use a fake. */
export interface AlbumBackend {
  /** This event's prints, oldest first. */
  listPrints(eventId: string): Promise<AlbumPhoto[]>;
  writeManifest(eventId: string, token: string, manifest: AlbumManifest): Promise<void>;
  /** Removes every manifest in the event's albums/ folder except `<keepToken>.json`. */
  removeOtherManifests(eventId: string, keepToken: string): Promise<void>;
}

export interface AlbumTarget {
  eventId: string;
  token: string | undefined;
}

export interface AlbumStatus {
  enabled: boolean;
  photoCount: number | null;
  lastWrittenAt: string | null;
  lastError: string | null;
}

/**
 * Keeps `captures/<event>/albums/<token>.json`, the list the album page reads, in step with the
 * prints in Supabase. The sync worker calls markDirty() when a print uploads and publishIfDirty()
 * at the end of every tick. A write that fails stays dirty and is retried. Nothing here throws into
 * the sync worker: an album that can't be written must never hold up photo uploads.
 */
export class AlbumPublisher {
  // Dirty from the start, so a write lost before a restart is caught up.
  private dirty = true;
  private target: string | null = null;
  private retryAt = 0;
  private written: Omit<AlbumStatus, "enabled"> = { photoCount: null, lastWrittenAt: null, lastError: null };
  private lastLogged: { message: string; at: number } | null = null;

  constructor(
    private readonly backend: AlbumBackend,
    private readonly getTarget: () => AlbumTarget,
    private readonly now: () => number = Date.now
  ) {}

  markDirty(): void {
    this.dirty = true;
  }

  async publishIfDirty(): Promise<void> {
    const { eventId, token } = this.getTarget();
    if (!token) return;
    const target = `${eventId}/${token}`;
    if (target !== this.target) {
      // A new token (or event) needs its own manifest right away, and the old one removed.
      this.target = target;
      this.dirty = true;
      this.retryAt = 0;
    }
    if (!this.dirty || this.now() < this.retryAt) return;

    // Cleared before the write, so a print that uploads while it runs marks it dirty again.
    this.dirty = false;
    try {
      const photos = await this.backend.listPrints(eventId);
      const at = new Date(this.now()).toISOString();
      await this.backend.writeManifest(eventId, token, { updatedAt: at, photos });
      this.written = { photoCount: photos.length, lastWrittenAt: at, lastError: null };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.dirty = true;
      this.retryAt = this.now() + ALBUM_RETRY_MS;
      this.written = { ...this.written, lastError: message };
      this.warnQuietly(`Album manifest not written, will retry: ${message}`);
      return;
    }

    try {
      await this.backend.removeOtherManifests(eventId, token);
    } catch (err) {
      // Tried again after the next write; a leftover old manifest is not worth re-dirtying for.
      this.warnQuietly(`Could not remove old album manifests: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  getStatus(): AlbumStatus {
    if (!this.getTarget().token) return { enabled: false, photoCount: null, lastWrittenAt: null, lastError: null };
    return { enabled: true, ...this.written };
  }

  private warnQuietly(message: string): void {
    const now = this.now();
    if (this.lastLogged?.message === message && now - this.lastLogged.at < REPEAT_QUIET_MS) return;
    this.lastLogged = { message, at: now };
    log.warn(message);
  }
}
```

- [ ] **Step 5: Run the tests.** Run `npx vitest run tests/album.publisher.test.ts`. Expected: PASS (9 tests). Then run `npx vitest run` and `npm run typecheck`: all pass and the typecheck is clean. If any existing test builds a full `BoothConfig` literal and now fails typecheck for a missing `album`, add `album: {}` to that literal.

- [ ] **Step 6: Commit.**

```bash
git add src/config/schema.ts src/album/albumPublisher.ts tests/album.publisher.test.ts
git commit -F- <<'EOF'
feat(album): album.token config and the manifest publisher

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 5: Supabase backend, sync worker hooks and wiring

**Files:**
- Create: `src/supabase/albumStorage.ts`, `tests/album.storage.test.ts`, `tests/outbox.album.test.ts`
- Modify: `src/outbox/syncWorker.ts`, `src/index.ts`

**Interfaces:**
- Consumes, from Task 4: `AlbumBackend`, `AlbumPhoto`, `AlbumManifest` and `AlbumPublisher`.
- Produces:
  - `albumManifestKey(eventId: string, token: string): string`, which returns `<eventId>/albums/<token>.json`;
  - `createSupabaseAlbumBackend(client: SupabaseClient, bucket: () => string): AlbumBackend`;
  - `export interface AlbumHooks { markDirty(): void; publishIfDirty(): Promise<void> }` in `syncWorker.ts`;
  - the `SyncWorker` constructor's optional 5th parameter `album?: AlbumHooks`;
  - in `src/index.ts`, a const `albumPublisher`, which Task 6 puts on the context.

- [ ] **Step 1: Write the failing storage tests.** Create `tests/album.storage.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { SupabaseClient } from "@supabase/supabase-js";
import { albumManifestKey, createSupabaseAlbumBackend } from "../src/supabase/albumStorage";

/** Just enough of supabase-js for the album backend, recording each call. */
function fakeClient(opts: { rows?: Array<{ id: string; taken_at: string }>; files?: string[]; queryError?: string; uploadError?: string } = {}) {
  const calls: Record<string, unknown[]> = {};
  const record = (name: string, ...args: unknown[]) => { calls[name] = args; };
  const query = {
    select: (...args: unknown[]) => { record("select", ...args); return query; },
    eq: (...args: unknown[]) => { record("eq", ...args); return query; },
    not: (...args: unknown[]) => { record("not", ...args); return query; },
    order: (...args: unknown[]) => {
      record("order", ...args);
      return Promise.resolve(opts.queryError ? { data: null, error: { message: opts.queryError } } : { data: opts.rows ?? [], error: null });
    },
  };
  const bucket = {
    upload: async (...args: unknown[]) => { record("upload", ...args); return { error: opts.uploadError ? { message: opts.uploadError } : null }; },
    list: async (...args: unknown[]) => { record("list", ...args); return { data: (opts.files ?? []).map((name) => ({ name })), error: null }; },
    remove: async (...args: unknown[]) => { record("remove", ...args); return { error: null }; },
  };
  const client = {
    from: (...args: unknown[]) => { record("from", ...args); return query; },
    storage: { from: (...args: unknown[]) => { record("storage.from", ...args); return bucket; } },
  };
  return { client: client as unknown as SupabaseClient, calls };
}

describe("Supabase album backend", () => {
  it("lists this event's prints, oldest first", async () => {
    const { client, calls } = fakeClient({ rows: [{ id: "a", taken_at: "t1" }, { id: "b", taken_at: "t2" }] });
    const photos = await createSupabaseAlbumBackend(client, () => "captures").listPrints("evt");
    expect(photos).toEqual([{ id: "a", takenAt: "t1" }, { id: "b", takenAt: "t2" }]);
    expect(calls.from).toEqual(["captures"]);
    expect(calls.select).toEqual(["id, taken_at"]);
    expect(calls.eq).toEqual(["event_id", "evt"]);
    expect(calls.not).toEqual(["print_size", "is", null]);
    expect(calls.order).toEqual(["taken_at", { ascending: true }]);
  });

  it("throws when the query fails", async () => {
    const { client } = fakeClient({ queryError: "boom" });
    await expect(createSupabaseAlbumBackend(client, () => "captures").listPrints("evt")).rejects.toThrow("boom");
  });

  it("uploads the manifest as short-cached JSON at the token's key", async () => {
    const { client, calls } = fakeClient();
    const manifest = { updatedAt: "now", photos: [{ id: "a", takenAt: "t1" }] };
    await createSupabaseAlbumBackend(client, () => "captures").writeManifest("evt", "tok-0123456789abcdef", manifest);
    expect(calls["storage.from"]).toEqual(["captures"]);
    const [key, body, options] = calls.upload as [string, Buffer, object];
    expect(key).toBe("evt/albums/tok-0123456789abcdef.json");
    expect(JSON.parse(body.toString("utf8"))).toEqual(manifest);
    expect(options).toEqual({ contentType: "application/json", cacheControl: "10", upsert: true });
  });

  it("throws when the upload fails", async () => {
    const { client } = fakeClient({ uploadError: "denied" });
    await expect(
      createSupabaseAlbumBackend(client, () => "captures").writeManifest("evt", "t", { updatedAt: "now", photos: [] })
    ).rejects.toThrow("denied");
  });

  it("removes every other manifest in the album folder", async () => {
    const { client, calls } = fakeClient({ files: ["old-0123456789abcdef.json", "tok-0123456789abcdef.json"] });
    await createSupabaseAlbumBackend(client, () => "captures").removeOtherManifests("evt", "tok-0123456789abcdef");
    expect(calls.list).toEqual(["evt/albums"]);
    expect(calls.remove).toEqual([["evt/albums/old-0123456789abcdef.json"]]);
  });

  it("removes nothing when only the current manifest is there", async () => {
    const { client, calls } = fakeClient({ files: ["tok-0123456789abcdef.json"] });
    await createSupabaseAlbumBackend(client, () => "captures").removeOtherManifests("evt", "tok-0123456789abcdef");
    expect(calls.remove).toBeUndefined();
  });

  it("builds the manifest key", () => {
    expect(albumManifestKey("evt", "tok")).toBe("evt/albums/tok.json");
  });
});
```

- [ ] **Step 2: Write the failing sync worker tests.** Create `tests/outbox.album.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { createInMemoryOutboxDb } from "../src/outbox/db";
import { OutboxStore } from "../src/outbox/outboxStore";
import { AlbumHooks, SyncWorker, UploadFn } from "../src/outbox/syncWorker";
import { EventBus } from "../src/events/eventBus";

function makeWorker(uploadFn: UploadFn) {
  const store = new OutboxStore(createInMemoryOutboxDb());
  const album = { dirtyMarks: 0, publishes: 0 };
  const hooks: AlbumHooks = {
    markDirty: () => { album.dirtyMarks += 1; },
    publishIfDirty: async () => { album.publishes += 1; },
  };
  const worker = new SyncWorker(
    store,
    uploadFn,
    { initialBackoffMs: 10, maxBackoffMs: 50, backoffMultiplier: 2, batchSize: 100 },
    new EventBus(),
    hooks
  );
  return { store, album, worker };
}

const uploadsSource: UploadFn = async (row) => ({
  storagePath: `evt/${row.id}.jpg`,
  sourcePath: row.composite_path ?? row.original_path,
});

function insert(store: OutboxStore, id: string, composite: boolean) {
  store.insertCapture({ id, eventId: "evt", source: "webcam", originalPath: `/tmp/${id}.jpg`, takenAt: new Date().toISOString() });
  if (composite) store.setCompositePath(id, `/tmp/${id}-print.jpg`, "4x6");
}

describe("SyncWorker album hooks", () => {
  it("marks the album dirty when a print uploads", async () => {
    const { store, album, worker } = makeWorker(uploadsSource);
    insert(store, "print", true);
    await worker.tick();
    expect(album.dirtyMarks).toBe(1);
  });

  it("doesn't mark it for a raw original", async () => {
    const { store, album, worker } = makeWorker(uploadsSource);
    insert(store, "raw", false);
    await worker.tick();
    expect(album.dirtyMarks).toBe(0);
  });

  it("doesn't mark it when the upload fails", async () => {
    const { store, album, worker } = makeWorker(async () => { throw new Error("offline"); });
    insert(store, "print", true);
    await worker.tick();
    expect(album.dirtyMarks).toBe(0);
  });

  it("gives the album a chance to publish on every tick, even an idle one", async () => {
    const { album, worker } = makeWorker(uploadsSource);
    await worker.tick();
    await worker.tick();
    expect(album.publishes).toBe(2);
  });
});
```

- [ ] **Step 3: Run them to see them fail.** Run `npx vitest run tests/album.storage.test.ts tests/outbox.album.test.ts`. Expected: FAIL. `../src/supabase/albumStorage` does not exist, and `AlbumHooks` is not exported and never called.

- [ ] **Step 4: Write `src/supabase/albumStorage.ts`.**

```ts
import { SupabaseClient } from "@supabase/supabase-js";
import { AlbumBackend, AlbumManifest, AlbumPhoto } from "../album/albumPublisher";

/** The album manifest sits beside the event's photos: `<event>/albums/<token>.json`. */
export function albumManifestKey(eventId: string, token: string): string {
  return `${eventId}/albums/${token}.json`;
}

/**
 * The album manifest in Supabase. It reads the `captures` table rather than the local outbox so
 * the album is complete even if this PC's data folder was reset, and lists only prints that are
 * really in the bucket: a row only gets print_size once its composite has uploaded.
 */
export function createSupabaseAlbumBackend(client: SupabaseClient, bucket: () => string): AlbumBackend {
  return {
    async listPrints(eventId: string): Promise<AlbumPhoto[]> {
      const { data, error } = await client
        .from("captures")
        .select("id, taken_at")
        .eq("event_id", eventId)
        .not("print_size", "is", null)
        .order("taken_at", { ascending: true });
      if (error) throw new Error(`album query failed: ${error.message}`);
      return ((data ?? []) as Array<{ id: string; taken_at: string }>).map((row) => ({ id: row.id, takenAt: row.taken_at }));
    },

    async writeManifest(eventId: string, token: string, manifest: AlbumManifest): Promise<void> {
      const { error } = await client.storage
        .from(bucket())
        .upload(albumManifestKey(eventId, token), Buffer.from(JSON.stringify(manifest), "utf8"), {
          contentType: "application/json",
          cacheControl: "10",
          upsert: true,
        });
      if (error) throw new Error(`album upload failed: ${error.message}`);
    },

    async removeOtherManifests(eventId: string, keepToken: string): Promise<void> {
      const folder = `${eventId}/albums`;
      const { data, error } = await client.storage.from(bucket()).list(folder);
      if (error) throw new Error(`album list failed: ${error.message}`);
      const stale = (data ?? []).map((file) => file.name).filter((name) => name !== `${keepToken}.json`);
      if (stale.length === 0) return;
      const { error: removeError } = await client.storage.from(bucket()).remove(stale.map((name) => `${folder}/${name}`));
      if (removeError) throw new Error(`album cleanup failed: ${removeError.message}`);
    },
  };
}
```

- [ ] **Step 5: Add the hooks to `src/outbox/syncWorker.ts`.**
  - After the `UploadFn` type, add:

```ts
/**
 * The event album (src/album/albumPublisher.ts). A print upload marks it dirty, and every tick
 * gives it a chance to rewrite its manifest. Optional so the worker runs the same without one.
 */
export interface AlbumHooks {
  markDirty(): void;
  publishIfDirty(): Promise<void>;
}
```

  - Add a 5th constructor parameter after `eventBus`: `private readonly album?: AlbumHooks`.
  - In `tick()`, after the `for (const row of batch)` loop and before `this.emitStatus();`, add:

```ts
      await this.album?.publishIfDirty();
```

  - In `syncOne`, directly after `this.store.markSynced(row.id, storagePath, sourcePath);`, add:

```ts
      // Only the print belongs in the album: the raw original that goes up first does not.
      if (row.composite_path !== null && sourcePath === row.composite_path) this.album?.markDirty();
```

- [ ] **Step 6: Wire it up in `src/index.ts`.** Add the imports:

```ts
import { AlbumPublisher } from "./album/albumPublisher";
import { createSupabaseAlbumBackend } from "./supabase/albumStorage";
```

  Then replace the `const syncWorker = new SyncWorker(...)` statement with:

```ts
  const albumPublisher = new AlbumPublisher(
    createSupabaseAlbumBackend(supabaseClient, () => configStore.current.supabase.storageBucket),
    () => ({ eventId: configStore.current.event.id, token: configStore.current.album.token })
  );
  const syncWorker = new SyncWorker(
    outboxStore,
    (row) => uploadCaptureToSupabase(supabaseClient, configStore.current.supabase, row),
    config.sync,
    eventBus,
    albumPublisher
  );
```

- [ ] **Step 7: Run the tests.** Run `npx vitest run tests/album.storage.test.ts tests/outbox.album.test.ts`. Expected: PASS (11 tests). Then run `npx vitest run` and `npm run typecheck`: everything passes and the typecheck is clean.

- [ ] **Step 8: Commit.**

```bash
git add src/supabase/albumStorage.ts src/outbox/syncWorker.ts src/index.ts tests/album.storage.test.ts tests/outbox.album.test.ts
git commit -F- <<'EOF'
feat(album): write the album manifest to Supabase as prints upload

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 6: Local album routes and `/health`

**Files:**
- Modify: `src/outbox/outboxStore.ts`, `src/server/routes.ts`, `src/server/http.ts`, `src/server/context.ts`, `src/health/healthReport.ts`, `src/index.ts`
- Create: `tests/album.routes.test.ts`, `tests/album.health.test.ts`

**Interfaces:**
- Consumes, from Task 3: `download/album.html` and `download/album-logic.js` exist. From Task 4: `AlbumStatus` and `AlbumPublisher`. From Task 5: the `albumPublisher` const in `index.ts`.
- Produces:
  - `OutboxStore.listAlbumPrints(eventId: string): Array<{ id: string; takenAt: string }>`;
  - `AgentContext.album: AlbumPublisher`;
  - `GET /album.json` (needs the secret) and `GET /album/*` (static, no secret);
  - `HealthInputs.album?: AlbumStatus` and `HealthReport.album: AlbumStatus`.

- [ ] **Step 1: Write the failing route tests.** Create `tests/album.routes.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { AddressInfo } from "node:net";
import { Server } from "node:http";
import { buildHttpApp } from "../src/server/http";
import { AgentContext } from "../src/server/context";
import { createInMemoryOutboxDb } from "../src/outbox/db";
import { OutboxStore } from "../src/outbox/outboxStore";

const SECRET = "test-secret";
let server: Server;
let base: string;

beforeAll(() => {
  const store = new OutboxStore(createInMemoryOutboxDb());
  const add = (id: string, eventId: string, takenAt: string, composite: boolean) => {
    store.insertCapture({ id, eventId, source: "webcam", originalPath: `/tmp/${id}.jpg`, takenAt });
    if (composite) store.setCompositePath(id, `/tmp/${id}-print.jpg`, "4x6");
  };
  add("b", "evt", "2026-09-29T10:02:00.000Z", true);
  add("a", "evt", "2026-09-29T10:01:00.000Z", true);
  add("raw", "evt", "2026-09-29T10:03:00.000Z", false);
  add("elsewhere", "other-evt", "2026-09-29T10:00:00.000Z", true);
  const ctx = {
    configStore: { current: { agent: { allowedOrigins: [], sharedSecret: SECRET }, event: { id: "evt" } } },
    outboxStore: store,
  } as unknown as AgentContext;
  server = buildHttpApp(ctx).listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
});

describe("GET /album.json", () => {
  it("needs the shared secret", async () => {
    expect((await fetch(`${base}/album.json`)).status).toBe(401);
  });

  it("lists this event's composited captures, oldest first, uncached", async () => {
    const res = await fetch(`${base}/album.json?token=${SECRET}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(typeof body.updatedAt).toBe("string");
    expect(body.photos).toEqual([
      { id: "a", takenAt: "2026-09-29T10:01:00.000Z" },
      { id: "b", takenAt: "2026-09-29T10:02:00.000Z" },
    ]);
  });
});

describe("GET /album/*", () => {
  it("serves the album page without the secret", async () => {
    const res = await fetch(`${base}/album/album.html`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("album.js");
  });

  it("serves its scripts as JavaScript", async () => {
    const res = await fetch(`${base}/album/album-logic.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
  });

  it("answers 404 for a missing file instead of asking for the secret", async () => {
    expect((await fetch(`${base}/album/nope.html`)).status).toBe(404);
  });

  it("never serves anything outside download/", async () => {
    const res = await fetch(`${base}/album/..%2Fpackage.json`);
    expect(res.status).not.toBe(200);
    expect(await res.text()).not.toContain("\"name\": \"booth-agent\"");
  });
});
```

- [ ] **Step 2: Write the failing health tests.** Create `tests/album.health.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildHealthReport, HealthInputs } from "../src/health/healthReport";
import { AlbumStatus } from "../src/album/albumPublisher";

function report(album?: AlbumStatus) {
  const inputs: HealthInputs = {
    camera: {
      activeSource: "canon" as never,
      activeModel: "Canon EOS R100",
      canonConnected: true,
      webcamConnected: false,
      preference: "canon",
      canonDetail: null,
      canonModel: "Canon EOS R100",
      canonSerial: "SN-A",
      low: null,
    },
    canon: { driver: "digicamcontrol", digiCamControlRunning: true },
    hotFolder: { path: "C:\\hot", writable: true },
    stalledPrints: { count: 0, oldestDroppedAt: null, oldestAgeSeconds: null, files: [] },
    printer: { reachable: true, ok: true, status: "STATUS_OK", model: "RX1HS", mediaRemaining: 500, mediaType: "4x6", serialNumber: null, lastUpdatedAt: null, staleMs: 0, error: null, statusFilePath: "x", raw: {} } as never,
    disk: { freeBytes: 500 * 1024 ** 3, totalBytes: 1000 * 1024 ** 3 },
    outbox: { queueDepth: 0, lastSyncAt: null, lastError: null, abandonedCount: 0 },
    eventId: "evt",
    thresholds: { lowDiskWarnBytes: 1, lowMediaWarnPrints: 30, outboxBacklogWarn: 50, expectedMediaType: "4x6" },
    ...(album ? { album } : {}),
  };
  return buildHealthReport(inputs);
}

const albumAlerts = (r: ReturnType<typeof report>) => r.alerts.filter((a) => a.code === "album-write-failed");

describe("/health album", () => {
  it("reports the album as off when there is none", () => {
    expect(report().album).toEqual({ enabled: false, photoCount: null, lastWrittenAt: null, lastError: null });
  });

  it("passes the album status through", () => {
    const album = { enabled: true, photoCount: 42, lastWrittenAt: "2026-09-29T10:00:00.000Z", lastError: null };
    expect(report(album).album).toEqual(album);
    expect(albumAlerts(report(album))).toEqual([]);
  });

  it("warns while the manifest can't be written", () => {
    const r = report({ enabled: true, photoCount: 3, lastWrittenAt: null, lastError: "album upload failed: offline" });
    expect(albumAlerts(r)).toEqual([
      expect.objectContaining({ level: "warn", code: "album-write-failed" }),
    ]);
    expect(albumAlerts(r)[0].message).toContain("album upload failed: offline");
  });
});
```

- [ ] **Step 3: Run them to see them fail.** Run `npx vitest run tests/album.routes.test.ts tests/album.health.test.ts`. Expected: FAIL. `/album.json` and `/album/*` answer 401 or 404, and `report().album` is undefined.

- [ ] **Step 4: Add `listAlbumPrints` to `src/outbox/outboxStore.ts`.** Add it after `getById`:

```ts
  /** This event's composited captures, oldest first: the album on the booth's own screen. */
  listAlbumPrints(eventId: string): Array<{ id: string; takenAt: string }> {
    return this.db
      .prepare(`SELECT id, taken_at AS takenAt FROM captures WHERE event_id = ? AND composite_path IS NOT NULL ORDER BY taken_at`)
      .all(eventId) as Array<{ id: string; takenAt: string }>;
  }
```

- [ ] **Step 5: Add `GET /album.json` in `src/server/routes.ts`.** Add it directly before the `router.get("/captures/:id/image", ...)` block:

```ts
  // The album on a screen cabled to the booth: the same shape as the manifest the agent writes to
  // Supabase, built from the outbox so it works with no internet. Photos come from
  // /captures/:id/image?variant=composite.
  router.get("/album.json", (_req: Request, res: Response) => {
    res.set("Cache-Control", "no-store").json({
      updatedAt: new Date().toISOString(),
      photos: ctx.outboxStore.listAlbumPrints(ctx.configStore.current.event.id),
    });
  });
```

- [ ] **Step 6: Serve `download/` at `/album` in `src/server/http.ts`.**
  - Add `import path from "node:path";` to the imports.
  - Below the `const log = ...` line, add:

```ts
/** The album page's files (repo download/), from both src/server and dist/server. */
const DOWNLOAD_DIR = path.resolve(__dirname, "..", "..", "download");
```

  - Directly before `app.use(sharedSecretAuth(...));`, add:

```ts
  // The album page's own files, so a screen cabled to the booth can show the album with no
  // internet. Page code only, no data: /album.json and the photos it loads still need the secret.
  // Anything else under /album (a missing file, a path escaping the folder) is a plain 404 here,
  // rather than a 401 from auth below or a 500 from the error handler.
  app.use("/album", express.static(DOWNLOAD_DIR, { index: false }));
  app.use("/album", (_req: Request, res: Response) => {
    res.status(404).json({ error: "not found" });
  });
```

- [ ] **Step 7: Add `album` to the context.** In `src/server/context.ts`, add `import { AlbumPublisher } from "../album/albumPublisher";` and this field after `printQueue: PrintQueue;`:

```ts
  /** The event album's manifest writer; /health reports its status. */
  album: AlbumPublisher;
```

  In `src/index.ts`, add `album: albumPublisher,` to the `ctx` object literal, after `printQueue,`.

- [ ] **Step 8: Add the album to the health report.** In `src/health/healthReport.ts`:
  - add `import { AlbumStatus } from "../album/albumPublisher";`;
  - in `HealthInputs`, after `layoutUsesLow?: boolean;`, add:

```ts
  /** The event album. Absent (as in tests of other areas) means no album. */
  album?: AlbumStatus;
```

  - in `HealthReport`, after `outbox: SyncSummary;`, add `album: AlbumStatus;`;
  - in `buildHealthReport`, after the destructuring line, add:

```ts
  const album: AlbumStatus = inputs.album ?? { enabled: false, photoCount: null, lastWrittenAt: null, lastError: null };
```

  - directly after the `outbox-abandoned` alert's `if` block, add:

```ts
  // A warning, never an error: guests' photos still upload and print; only the album link lags.
  if (album.enabled && album.lastError) {
    alerts.push({
      level: "warn",
      code: "album-write-failed",
      message: `The online album isn't updating (${album.lastError}). Photos still upload; it retries on its own.`,
    });
  }
```

  - in the returned object, add `album,` after `outbox,`.

  In `src/server/routes.ts`, in the `/health` handler's `buildHealthReport({...})` argument, add `album: ctx.album.getStatus(),` after `layoutUsesLow,`.

- [ ] **Step 9: Run the tests.** Run `npx vitest run tests/album.routes.test.ts tests/album.health.test.ts`. Expected: PASS (9 tests). Then run `npx vitest run` and `npm run typecheck`: everything passes and the typecheck is clean.

- [ ] **Step 10: Commit.**

```bash
git add src/outbox/outboxStore.ts src/server/routes.ts src/server/http.ts src/server/context.ts src/health/healthReport.ts src/index.ts tests/album.routes.test.ts tests/album.health.test.ts
git commit -F- <<'EOF'
feat(album): local album routes for the booth screen, album status in /health

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 7: Operator Status card, slideshow launcher and docs

**Files:**
- Modify: `kiosk/src/agent.ts`, `kiosk/src/Operator.tsx`, `download/README.md`, `kiosk/README.md`
- Create: `kiosk/start-slideshow.ps1`

**Interfaces:**
- Consumes, from Task 6: `/health` `album: { enabled, photoCount, lastWrittenAt, lastError }`. From Task 2/3: the local URL format.

- [ ] **Step 1: Install the kiosk's dependencies in this worktree** (they aren't installed yet): `npm ci --no-audit --no-fund` in `kiosk/`.

- [ ] **Step 2: Add `album` to the kiosk's `Health` type.** In `kiosk/src/agent.ts`, inside `export interface Health { ... }`, after the `outbox:` line, add:

```ts
  /** The event album. Optional so the panel still works against an agent from before it existed. */
  album?: { enabled: boolean; photoCount: number | null; lastWrittenAt: string | null; lastError: string | null };
```

- [ ] **Step 3: Add the ALBUM card to the Status tab.** In `kiosk/src/Operator.tsx`, directly after the `<Card label="PHOTO SYNC" ... />` element, add:

```tsx
            {h.album?.enabled && (
              <Card label="ALBUM" value={h.album.photoCount !== null ? `${h.album.photoCount} prints` : "Not written yet"}
                ok={!h.album.lastError}
                note={h.album.lastError ? "Not updating, will retry" : h.album.lastWrittenAt ? `Updated ${time(h.album.lastWrittenAt)}` : "Waiting for the first print"} />
            )}
```

- [ ] **Step 4: Check the kiosk builds.** Run `npx tsc --noEmit` and then `npx vitest run` in `kiosk/`. Expected: no type errors and all kiosk tests pass.

- [ ] **Step 5: Create `kiosk/start-slideshow.ps1`.**

```powershell
<#
  Opens the event album as a full-screen slideshow on a second screen (TV,
  projector), straight from booth-agent: no internet needed, and each print
  appears as soon as it is made. See download/README.md.

  Run it on the booth PC with the second screen connected. Exit with Alt+F4.
    -Screen      index into the connected screens; default: the first one that
                 isn't the primary screen
    -ConfigPath  booth-agent's booth.config.json
#>
param(
    [string]$ConfigPath = "$env:USERPROFILE\Documents\booth-agent\booth.config.json",
    [int]$Screen = -1
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms

$Config = Get-Content -Raw $ConfigPath | ConvertFrom-Json
$Port = if ($Config.agent.port) { $Config.agent.port } else { 7070 }
$Name = if ($Config.event.name) { $Config.event.name } else { $Config.event.id }
$Url = "http://127.0.0.1:$Port/album/album.html?local=1&play=1" +
    "&token=$([uri]::EscapeDataString($Config.agent.sharedSecret))" +
    "&name=$([uri]::EscapeDataString($Name))"

$Screens = [System.Windows.Forms.Screen]::AllScreens
if ($Screen -lt 0) {
    $Target = $Screens | Where-Object { -not $_.Primary } | Select-Object -First 1
    if (-not $Target) { throw "Only one screen is connected - plug in the second screen first." }
} elseif ($Screen -lt $Screens.Count) {
    $Target = $Screens[$Screen]
} else {
    throw "Screen $Screen not found - $($Screens.Count) screen(s) connected."
}

$Chrome = "$env:ProgramFiles\Google\Chrome\Application\chrome.exe"
# Its own profile, so it opens a separate kiosk window beside the booth's kiosk.
Start-Process $Chrome -ArgumentList @(
    "--kiosk", "--user-data-dir=$env:LOCALAPPDATA\KachakSlideshow", "--no-first-run",
    "--window-position=$($Target.Bounds.X),$($Target.Bounds.Y)", $Url
)
```

- [ ] **Step 6: Parse-check the script.** Run:

```bash
powershell -NoProfile -Command "[System.Management.Automation.Language.Parser]::ParseFile('kiosk/start-slideshow.ps1', [ref]\$null, [ref]\$errs) | Out-Null; if (\$errs) { \$errs; exit 1 } else { 'parse ok' }"
```

  Expected: `parse ok`. Don't run the script itself; it opens Chrome on the booth.

- [ ] **Step 7: Document it.**
  - Append to `download/README.md`:

````markdown
## Event album

Every print from an event, as a grid with Save / Share and a full-screen slideshow. The page is `album.html` in this folder, and booth-agent keeps its photo list up to date.

### Turn it on

Add a secret token (at least 16 characters of `A-Z a-z 0-9 _ -`) to booth-agent's `booth.config.json`:

```json
"album": { "token": "<random token>" }
```

After the next upload the agent writes `captures/<event.id>/albums/<token>.json`. `/health` shows `album`, and so does the ALBUM card in the operator panel's Status tab. To kill a link you've sent, change the token: the agent writes the new manifest and deletes the old one.

### Online link (send this to the client)

```
https://<site>/album.html?event=<event_id>&name=<display name>&album=<token>[&p=<project ref>]
```

Add `&play=1` to start straight in the slideshow, e.g. on a venue TV with internet. New prints appear within about 20 s.

### Booth screen (no internet)

With a TV or projector plugged into the booth PC, run:

```
powershell -NoProfile -ExecutionPolicy Bypass -File C:\BoothAgent\kiosk\start-slideshow.ps1
```

It opens `http://127.0.0.1:7070/album/album.html?local=1&play=1&token=<agent secret>` full-screen on the second screen. Photos come straight from the booth, so they show up as soon as they're printed. Use `-Screen <n>` to pick a different screen. Exit with Alt+F4.
````

  - Add a section after "New Supabase project?" in `download/README.md`:

```markdown
## Links for an event with its own Supabase project

Both pages take `p=<project ref>` (the 20-letter id in `https://<ref>.supabase.co`), so a new project needs no code change: add `&p=<ref>` to the kiosk's `VITE_DOWNLOAD_URL` and to the album link. Without `p` the pages use `SUPABASE_URL` in `photo.js`.
```

  - In `kiosk/README.md`, add `kiosk\start-slideshow.ps1` to the `Copy-Item` list in the deploy steps, right after `kiosk\start-kiosk.ps1`.

- [ ] **Step 8: Run the tests.** Run `npx vitest run` and `npm run typecheck` from the repo root. Expected: everything passes.

- [ ] **Step 9: Commit.**

```bash
git add kiosk/src/agent.ts kiosk/src/Operator.tsx kiosk/start-slideshow.ps1 download/README.md kiosk/README.md
git commit -F- <<'EOF'
feat(album): operator ALBUM card, second-screen slideshow launcher, docs

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

## After the last task

- The controller checks the whole thing in a browser against a scratch agent (`buildHttpApp` with a real in-memory outbox and sample composites): the local album, and a print appearing mid-slideshow.
- Once PR #63 is merged, rebase this branch onto master, then push and open the PR.
- Deploy:
  1. Merge.
  2. Add `album.token` to `C:\Users\User\Documents\booth-agent\booth.config.json`.
  3. The user stops the service; `git pull`, `npm run build`; the user starts it.
  4. Deploy the kiosk, including `start-slideshow.ps1`.
  5. After the SQL and Vercel setup from PR #63, check the online album link.
