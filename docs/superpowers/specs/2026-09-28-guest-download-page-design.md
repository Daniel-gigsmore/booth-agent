# Guest download page: scan the QR, save the print

Status: approved in chat on 2026-09-28, one section at a time.

## Goal

The kiosk's Done screen shows a QR code once `VITE_DOWNLOAD_URL` is set, and today it is unset. This adds the page that code opens.

The guest scans the code and sees the photo that was just printed, with a **Save / Share** button, on a small page in Kachak's look. The booth stays offline-first: the page copes with a photo that hasn't finished uploading yet.

## Decisions

| Question | Decision |
|---|---|
| Hosting | Vercel for now: a static site built from this repo's `download/` folder. It is plain static files, so moving to another host or a custom domain later only means redeploying them. The kiosk's `VITE_DOWNLOAD_URL` is then rebuilt, and codes already handed out keep pointing at the old address. |
| What the page shows | The Kachak logo, the event name, the print composite and a Save / Share button, plus a footer line "Photos by Kachak Productions". There are no social links yet; they come later. |
| How the page reaches the photo | The `captures` bucket becomes **public**, and the anon read policies are dropped. The page builds the object's public URL from the event id and the capture id. It holds no key. |

### Why a public bucket

Today anon has `SELECT` on `public.captures` and on `storage.objects` in the `captures` bucket. A page would have to ship the anon key, and anyone holding that key could list and download every guest's photo from every event.

A public bucket serves an object only by its exact path; listing still needs a `SELECT` policy, and there will be none. The path contains the capture's random UUID, so only someone given the QR code can open that photo.

The alternatives were considered and rejected:
- keep the anon policies and ship the key: it exposes everything;
- an Edge Function that issues signed URLs: stricter, but one more deployed piece for little gain over unguessable UUID paths.

## Which image the page gets

`uploadCaptureToSupabase` stores a capture at `<event_id>/<captureId>.jpg` (the source file's extension; both originals and composites are `.jpg`).

The first shot's row owns the composite. The kiosk's Done screen uses that same id (`captureIds[0]`). The outbox may upload the raw original first, but it re-uploads to the **same key** as soon as `composite_path` exists (see `NEEDS_UPLOAD_SQL` in `src/outbox/outboxStore.ts`). The composite exists before printing starts, and the guest only scans after the print. Offline, only the composite is ever uploaded. So the page shows the composite in practice, and no agent change is needed.

## The page

### Files

All in a new `download/` folder beside `kiosk/`, with no build step and no new dependency:

| File | Role |
|---|---|
| `download/index.html` | Markup and styles: the kiosk's colour tokens and fonts, plus the kiosk's text logo (an orange dot and "KACHAK"). |
| `download/photo.js` | Pure logic, an ES module: parse the URL, validate it, build the image URL, and decide what to show. It is unit-tested. |
| `download/main.js` | Browser wiring: loads the image, retries, and handles Save / Share. |

- The fonts come from Google Fonts: Bricolage Grotesque for display and Manrope for body, the same families the kiosk bundles.
- The colours are copied from `kiosk/src/styles.css` `:root`: `--bg #15121a`, `--surface #211c28`, `--text #f5efe6`, `--muted #b9afc2`, `--accent #ff6a45`, `--on-accent #1a0f0b`.
- The layout is phone-first: a single column, with the photo at full width.

### URL

```
https://<site>/?event=<event_id>&name=<event display name>&id=<captureId>
```

- `event` (required): the Supabase path prefix, e.g. `gigsmore-launch-2026`. It must match `^[A-Za-z0-9_-]+$`.
- `id` (required): a UUID (`8-4-4-4-12` hex, case-insensitive).
- `name` (optional): shown as the page's event title. When it is missing, the page shows no title line.

The kiosk needs no code change, because `config.downloadUrl` already substitutes `{captureId}`. The operator sets, for example:

```
VITE_DOWNLOAD_URL=https://<site>/?event=gigsmore-launch-2026&name=Gigsmore%20Launch&id={captureId}
```

The image URL is `https://pbtnvpykoueiizsvjwlo.supabase.co/storage/v1/object/public/captures/<event>/<id>.jpg`. The Supabase project URL is a constant in `photo.js`; it is public, not a secret.

### States

| State | When | Shows |
|---|---|---|
| `invalid` | `event` or `id` is missing or malformed | "This link doesn't look right." No request is made. |
| `loading` | the first attempt is in flight | The skeleton. |
| `uploading` | an attempt failed (404 or network error) and less than 2 minutes have passed since the page opened | "Your photo is still uploading - hang on…". It retries every 5 s. |
| `later` | still failing after 2 minutes | "It's taking a while. This link keeps working - open it again later." It keeps retrying every 5 s. |
| `ready` | the image loaded | The photo and the Save / Share button. |

Every attempt appends `?t=<Date.now()>` to the image URL, so a cached 404 (or a stale cached image) is never reused.

### Save / Share

- The page fetches the image as a blob and makes a `File` named `kachak-<event>-<first 8 of id>.jpg`.
- If `navigator.canShare?.({ files: [file] })` is true, it calls `navigator.share({ files: [file] })`. That opens the phone's share sheet, which offers Save to Photos, WhatsApp and so on.
- Otherwise it downloads the file with a temporary `<a download>`.
- A share the guest cancels (`AbortError`) is ignored.

## Supabase change

A new migration, `supabase/migrations/20260928000000_public_capture_bucket.sql`:

```sql
update storage.buckets set public = true where id = 'captures';
drop policy if exists "anon can read capture files" on storage.objects;
drop policy if exists "anon can read captures" on public.captures;
```

booth-agent uses the service-role key, which bypasses RLS, so uploads and the `captures` upsert are unaffected. The kiosk never talks to Supabase.

The user runs this SQL in the Supabase dashboard's SQL Editor. It is committed so the repo matches the live project.

## Rollout

1. The user runs the migration SQL.
2. The user creates a Vercel project from this repo with root directory `download/`, no build command and no framework. It deploys on every push to master.
3. Check it with an already-synced capture from 25 Sep: the photo shows and Save / Share works. Check a made-up UUID too: it shows `uploading`.
4. Set `VITE_DOWNLOAD_URL` in `C:\BoothAgent\kiosk\.env.local` and rebuild the kiosk. The Done screen then shows the QR code.

`kiosk/.env.example` gets a full example URL in its comment.

## Testing

- `tests/download.test.ts` (vitest, and so in CI) covers `photo.js`:
  - URL parsing and validation: missing or malformed `event`/`id`, and `name` optional;
  - the image URL with a cache-buster;
  - the state after N failed attempts over elapsed time: `uploading`, then `later` at 2 minutes;
  - the share filename.
- A hand check in a browser:
  - a real synced photo displays;
  - Save / Share works (desktop download; a phone share sheet if one is available);
  - an unknown id shows `uploading` and retries;
  - a bad link shows `invalid`;
  - a phone-width layout.

## Out of scope

- Instagram or website links (to be added later);
- downloading the individual original shots (the agent uploads only the composite for the first shot's row);
- a custom domain;
- analytics;
- photo expiry or deletion.
