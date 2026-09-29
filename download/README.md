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

## New Supabase project?

Each event may get its own fresh Supabase project (see the main README's "Supabase schema setup"). If this event does:

1. Set `SUPABASE_URL` in `download/photo.js` to the same value as `supabase.url` in `booth.config.json`.
2. Run both migrations in order against the new project's SQL Editor: `20260814000000_captures.sql`, then `20260928000000_public_capture_bucket.sql`.
3. Push to `master` to redeploy this page.

## Links for an event with its own Supabase project

Both pages take `p=<project ref>` (the 20-letter id in `https://<ref>.supabase.co`), so a new project needs no code change: add `&p=<ref>` to the kiosk's `VITE_DOWNLOAD_URL` and to the album link. Without `p` the pages use `SUPABASE_URL` in `photo.js`.

## Event album

Every print from an event, as a grid with Save / Share and a full-screen slideshow. The page is `album.html` in this folder, and booth-agent keeps its photo list up to date.

### Turn it on

Add a secret token (at least 16 characters of `A-Z a-z 0-9 _ -`) to booth-agent's `booth.config.json`. Generate one with:

```
node -e "console.log(require('crypto').randomBytes(18).toString('base64url'))"
```

```json
"album": { "token": "<random token>" }
```

The agent writes `captures/<event.id>/albums/<token>.json` on the next sync pass (about 2 s after `booth.config.json` is saved), and again after each print uploads. `/health` shows `album`, and so does the ALBUM card in the operator panel's Status tab.

Removing the token stops the agent updating the manifest, but does **not** kill a link already sent - the old file is just left as-is in storage. To actually kill a link, change the token: the agent writes a new manifest under the new token and deletes the old one.

The album is only as private as the token: it stays unguessable purely because `20260928000000_public_capture_bucket.sql` removed anon's read/list policies on the `captures` bucket, so never add a SELECT policy on `storage.objects` for it.

### Online link (send this to the client)

```
https://<site>/album.html?event=<event_id>&name=<display name>&album=<token>[&p=<project ref>]
```

Add `&play=1` to start straight in the slideshow, e.g. on a venue TV with internet. New prints appear within about 20 s.

### Booth screen (no internet)

With a TV or projector plugged into the booth PC, use **Slideshow on second screen** in the kiosk's operator Album tab. If Chrome won't place the window, run:

```
powershell -NoProfile -ExecutionPolicy Bypass -File C:\BoothAgent\kiosk\start-slideshow.ps1
```

It opens `http://127.0.0.1:7070/album/album.html?local=1&play=1&token=<agent secret>` full-screen on the second screen. Photos come straight from the booth, so they show up as soon as they're printed. Use `-Screen <n>` to pick a different screen. Exit with Alt+F4. If the slideshow window isn't full screen, click it once; the next click stops the slideshow.

## Local preview

```
npx serve download -l 5500
```

Open `http://localhost:5500/?event=<event_id>&id=<a synced captureId>`.
