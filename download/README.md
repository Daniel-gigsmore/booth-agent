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

## Local preview

```
npx serve download -l 5500
```

Open `http://localhost:5500/?event=<event_id>&id=<a synced captureId>`.
