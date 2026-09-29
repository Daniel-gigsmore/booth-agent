# Event album and slideshow

Status: approved in chat on 2026-09-29, in two sections. Builds on the guest download page (`docs/superpowers/specs/2026-09-28-guest-download-page-design.md`, PR #63).

## Goal

Clients sometimes want every photo from their event, not just one guest's. This gives each event an **album**: one secret link that shows every print from the event as a grid, lets people open and save any one, and plays them as a full-screen slideshow.

The same page runs in two places:
- **Online**, from the Vercel site: sent to the client after the event, or opened on a venue screen with internet. New prints appear a few seconds after they upload.
- **On the booth PC**, served by booth-agent, for a big screen cabled to the booth's second HDMI output. It needs no internet, and a print shows up as soon as it's composited.

## Decisions

| Question | Decision |
|---|---|
| Where | Both: an online album after the event and a live screen at the venue. The live screen can use the online page (venue has internet) or the booth's HDMI output (no internet). |
| Who can see the whole album | Whoever holds the event's secret album link. The operator sends it to the client. Changing the token kills the old link. |
| What it shows | Prints only (the composite each guest got), one per session. No individual shots. |
| Album features | A thumbnail grid; tap one for a large view with Save / Share; a Play button for a full-screen slideshow. |
| How the page gets the list | A **manifest file** that booth-agent writes into the public bucket at a path containing the secret token. The page holds no key, anon still has no policies, and a new Supabase project needs no extra setup. |
| One project per event | Still the practice (confirmed 2026-09-29). Both pages accept an optional `p=<project ref>` so a new project only needs a new link, not a code change and redeploy. |

Rejected:
- a `security definer` RPC `album_photos(event, token)`: the page would ship the anon key, and each new project needs one more SQL step;
- an Edge Function: one more thing to deploy for every event's project.

## Manifest (booth-agent)

### Config

`booth.config.json` gets an optional block:

```json
"album": { "token": "<random, at least 16 chars of [A-Za-z0-9_-]>" }
```

With no `album.token`, nothing in this section runs and the agent behaves exactly as today. The token is read from `configStore.current` each time, so a change takes effect on the config hot-reload without a restart.

### When it is written

- The album is marked **dirty** when the sync worker successfully uploads a print. That is a row whose uploaded source is its composite (`sourcePath === row.composite_path`, which is also when `print_size` is set on the Supabase row). Uploading a raw original doesn't mark it.
- The album is also dirty at startup and after the token changes, so a write lost before a restart, or a new token, is caught up.
- At the end of a sync tick, if the album is dirty and a token is set, the agent writes the manifest. On success it clears dirty. On failure it stays dirty and the next tick retries. A failure never affects photo uploads.

### What is written

The agent queries Supabase with the service-role client:

```
select id, taken_at from captures
where event_id = <event.id> and print_size is not null
order by taken_at
```

and uploads to the bucket at `<event.id>/albums/<token>.json` with `upsert: true`, `contentType: application/json` and `cacheControl: "10"`:

```json
{ "updatedAt": "2026-09-29T10:00:00.000Z", "photos": [{ "id": "<uuid>", "takenAt": "<iso>" }] }
```

Querying Supabase rather than the local outbox means the album is complete even if the local data folder was reset, and it only ever lists prints that are really in the bucket. Because a row only gets `print_size` when its composite uploads, a raw original can never appear in the album.

After a successful write, the agent lists `<event.id>/albums/` and removes every object except `<token>.json`. That is how a token change revokes the old link. A failed removal is logged and retried after the next write; it never re-marks the album dirty.

### Health

`/health` gains:

```json
"album": { "enabled": true, "photoCount": 42, "lastWrittenAt": "<iso>|null", "lastError": "<string>|null" }
```

With `enabled: false` the other fields are null. A write failure raises the alert `album-write-failed` (warn), using the same 60 s quiet window as the other repeated warnings; it clears after the next successful write. The operator panel's Status tab shows one line: the photo count and last write, or the error.

## Local source (booth-agent)

- `GET /album.json`: requires the shared secret, like every data route. It returns the same shape as the manifest, built from the local outbox: rows for the current `event.id` with a non-null `composite_path`, ordered by `taken_at`. It works with no album token and no internet.
- Images come from the existing `GET /captures/:id/image?variant=composite`.
- `GET /album/*` serves the repo's `download/` folder as static files, **without** the shared secret. These are only page code, with no data, and the same exception pattern as `/layout-import` is used. The data routes above still need the token, which the page appends as `?token=`.

## The album page

### Files

In `download/`, no build step and no new dependency:

| File | Role |
|---|---|
| `album.html` | Markup and styles, with the same tokens, fonts and logo as `index.html`. |
| `album-logic.js` | Pure, unit-tested: parse the link, build the manifest and image URLs for each source, merge a fresh manifest into the play queue. |
| `album.js` | Browser wiring: load and poll the manifest, grid, large view, slideshow. |
| `share.js` | `sharePhoto(file)` moved out of `main.js` (share sheet, then download fallback, AbortError ignored, button guard stays in the caller). `main.js` and `album.js` both import it. |
| `photo.js` | Gains the optional `p` parameter (below) and a `projectUrl(link)` helper that both pages use. |

### URLs

Online:

```
https://<site>/album.html?event=<event_id>&name=<display name>&album=<token>[&p=<project ref>][&play=1]
```

Local (on the booth PC):

```
http://127.0.0.1:7070/album/album.html?local=1&token=<agent shared secret>[&name=<display name>][&play=1]
```

- `event`: `^[A-Za-z0-9_-]+$`, required online and unused locally.
- `album`: `^[A-Za-z0-9_-]{16,}$`, required online.
- `p`: `^[a-z0-9]{20}$`, optional. It makes the project URL `https://<p>.supabase.co`; without it the page uses the existing `SUPABASE_URL` constant. `index.html` (the single-photo page) accepts it too, so the kiosk's `VITE_DOWNLOAD_URL` can carry it.
- `local=1`: the manifest is `/album.json?token=<token>` and images are `/captures/<id>/image?variant=composite&token=<token>`. `token` is required with `local=1`.
- `play=1`: start straight in the slideshow (for a screen with nobody to tap Play).

Online, the manifest is `<project>/storage/v1/object/public/captures/<event>/albums/<album>.json?t=<now>` and the images are the same public URLs the download page uses.

### Behaviour

- **Grid:** thumbnails in taken order, newest last. It shows the same image files; there are no separate thumbnails.
- **Large view:** tapping a photo opens it with **Save / Share** (via `share.js`, file named with `shareFileName`), plus previous, next and close.
- **Slideshow:** the Play button (or `play=1`) goes full screen where the browser allows it and shows each print for 6 s, fading between them and looping. Tap or Esc leaves it. The cursor hides after 3 s without movement.
- **Polling:** the manifest is re-fetched every 15 s. Photos not seen before are appended to the grid and **queued to play next** in the slideshow, so a new print shows within about 15 + 6 s of its manifest update. A failed refresh keeps the current list and playing never stops.
- **Image errors:** a print that fails to load is skipped in the slideshow and retried on the next loop.

### States

| State | When | Shows |
|---|---|---|
| `invalid` | the link is malformed | "This link doesn't look right." No request is made. |
| `loading` | the first manifest fetch is in flight | A spinner. |
| `missing` | the manifest isn't there (any non-ok status) | "No photos here yet - this album fills up as the booth prints." It retries every 15 s. |
| `empty` | the manifest has no photos | "No photos yet." It keeps polling. |
| `ready` | at least one photo | The grid (or the slideshow when playing). |

The copy stays with the existing footer "Photos by Kachak Productions".

## Second screen launcher

A new `kiosk/start-slideshow.ps1`, beside `start-kiosk.ps1`:
- it reads `agent.sharedSecret`, `agent.port` and `event.name` from `booth.config.json` (the path is a parameter defaulting to the booth's);
- it starts Chrome with `--kiosk`, its own `--user-data-dir` (`%LOCALAPPDATA%\KachakSlideshow`), `--no-first-run` and `--window-position=<x>,0`;
- `x` comes from a `-Screen` parameter (default 1, the second monitor) resolved with `System.Windows.Forms.Screen`;
- it opens the local URL with `play=1`.

The secret ends up in the local Chrome process's command line and URL. That is no wider than today: the kiosk bundle in `C:\BoothAgent\kiosk\dist` already contains it, and the agent listens on loopback only.

## Testing

- **Agent (vitest):**
  - a print upload marks the album dirty and the tick writes the manifest; an original-only upload doesn't;
  - the manifest holds only this event's prints, in `taken_at` order;
  - a failed write keeps it dirty, the next tick rewrites it, and uploads carry on;
  - other files in `albums/` are removed after a write;
  - with no `album.token` nothing is queried or written;
  - dirty at startup and after a token change;
  - `/album.json` needs the secret and returns the right shape from the outbox;
  - `/album/album.html` is served without the secret, and a path outside `download/` can't be reached;
  - `/health` `album` fields and the `album-write-failed` alert.
- **Page logic (vitest, `tests/album.test.ts`):** link parsing for both sources, including `p`, `local`, `play` and the bad values; manifest and image URLs for both sources; `projectUrl` with and without `p`; merging a new manifest (new ids queued next, known ids untouched, order kept).
- **Hand check:**
  - the local album on the booth PC: grid, large view, slideshow, a new print appearing mid-show;
  - a phone-width layout;
  - `start-slideshow.ps1` on the second screen;
  - online, after the SQL and Vercel setup from PR #63: the album link, and a token change killing the old link.

## Rollout

1. Merge PR #63 first (this branch builds on it), then this PR.
2. Add `album.token` to `booth.config.json`. Claude generates the value. Stop the service, build, start it (no new dependencies).
3. Deploy the kiosk (the Status tab line).
4. After the next sync, check the online album link. Send the client `https://<site>/album.html?event=<id>&name=<name>&album=<token>&p=<ref>`.
5. For a cabled screen, run `start-slideshow.ps1` on the booth PC.

## Out of scope

- showing the album link and a QR code in the operator panel (the link format is in `download/README.md`);
- a zip download of the whole album;
- individual shots;
- several booths writing one event's album;
- hiding or deleting single photos from the album;
- separate thumbnail files.
