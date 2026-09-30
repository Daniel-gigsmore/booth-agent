# Guest download page

The page the kiosk's Done-screen QR code opens. It shows the guest's printed photo with a **Save / Share** button, and waits and retries while the booth is still uploading it.

The design is in `docs/superpowers/specs/2026-09-28-guest-download-page-design.md`.

## URL

```
https://<site>/?event=<event_id>&name=<display name>&id=<captureId>
```

Set this in the kiosk's `.env.local` with `{captureId}`, `{eventId}` and `{eventName}` as placeholders, then rebuild the kiosk. The kiosk fills in the event from booth-agent, so switching events in the Events tab needs no rebuild:

```
VITE_DOWNLOAD_URL=https://<site>/?event={eventId}&name={eventName}&id={captureId}
```

`event` must equal the active event's id: photos are stored at `captures/<event id>/<captureId>.jpg`. A link with a fixed `event=` still works, but after a switch guests' QR codes point at that fixed event (the Events tab warns about it).

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

Every event created from the kiosk's Events tab gets a secret token automatically (24 characters of `A-Z a-z 0-9 _ -`), kept in booth-agent's `<dataDir>/events.json`. The first event is seeded from `event` and `album.token` in `booth.config.json` on first start; an event migrated without a token has no album (stop the service and add `albumToken` to that event in `events.json`, or create a new event, which gets one).

The agent writes `captures/<event id>/albums/<token>.json` on the next sync pass after the event is switched to or created, and again after each print uploads. `/health` shows `album`, and so does the ALBUM card in the operator panel's Status tab.

Removing a token stops the agent updating the manifest, but does **not** kill a link already sent - the old file is just left as-is in storage. To actually kill a link, stop the service, change that event's `albumToken` in `events.json` (any 16+ character `A-Z a-z 0-9 _ -` string; `node -e "console.log(require('crypto').randomBytes(18).toString('base64url'))"` makes one), and start it again: the agent writes a new manifest under the new token and deletes the old one. Never edit `events.json` while the service runs - it never re-reads the file and overwrites it on its next write.

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

It opens `http://127.0.0.1:7070/album/album.html?local=1&play=1&token=<agent secret>` full-screen on the second screen. Photos come straight from the booth, so they show up as soon as they're printed. Use `-Screen <n>` to pick a different screen. Exit with Alt+F4. The first click on the slideshow puts the page itself in full screen (you may see no change); the next click stops it. A window opened from the operator panel closes instead.

## Local preview

```
npx serve download -l 5500
```

Open `http://localhost:5500/?event=<event_id>&id=<a synced captureId>`.
