# Event switching: design

Date: 2026-09-30. Status: approved in chat.

## Problem

The booth's event is fixed in `booth.config.json` (`event.id`, `event.name`, `album.token`), and the kiosk bakes the event name (`VITE_EVENT_NAME`) and the event id (inside `VITE_DOWNLOAD_URL`) into its build. Starting a new event means hand-editing config and env files and rebuilding. The operator wants to pick an existing event or start a new one from the kiosk's operator panel.

## Decisions (from the operator)

- All events share the current Supabase project. Each event is a folder in the `captures` bucket, as today. No per-event Supabase project.
- Each event remembers its own name, date, album link (token) and session settings (layout, countdowns, attract album switch).
- Approach A: booth-agent keeps the event list in its data dir; the kiosk reads the active event from the agent. Rejected: the kiosk rewriting `booth.config.json` (it holds the service-role key and hand edits), and a kiosk-only list (the agent would tag captures with the wrong event).
- Not in scope (YAGNI): deleting or renaming events, per-event Supabase projects.

## Data: `<dataDir>/events.json`

```json
{
  "activeId": "gigsmore-launch-2026",
  "events": [
    {
      "id": "gigsmore-launch-2026",
      "name": "Gigsmore Launch",
      "date": "2026-09-30",
      "albumToken": "…",
      "session": { "templateId": "overlay-test", "firstCountdownSeconds": 3, "betweenShotsSeconds": 3, "attractSlideshow": true }
    }
  ]
}
```

- A new module `src/session/eventStore.ts` owns the file: load (with a zod schema), `active()`, `list()`, `create({ name, date })`, `activate(id)`, `updateActiveSession(settings)`. Every write rewrites the whole file (write to a temp file, then rename, so a crash never leaves half a file).
- `session` uses the existing `SessionSettingsSchema`. `session.json` is no longer read or written after migration; it stays on disk untouched.
- **Migration.** When `events.json` is missing, the store creates it from what the booth uses today: `config.event.id` and `config.event.name`, `config.album.token`, and `readSessionSettings(dataDir)`, with today's date. Existing captures, the album link and the manifest therefore stay the same. After that, `config.event` and `config.album` are only the seed and are otherwise ignored; the config schema is unchanged, so existing config files still load.
- **Unreadable file.** If `events.json` exists but can't be parsed, the agent logs an error and falls back to the migration result in memory without overwriting the file, so an operator can fix it by hand. `/health` reports it (see below).
- **New event id.** `slug(name) + "-" + date`, where slug lowercases, turns every run of characters outside `a-z0-9` into `-` and trims dashes. An empty slug (for example a Chinese-only name) becomes `event`. A clash with an existing id gets `-2`, `-3` and so on. Example: "TUMI Launch" on 2026-10-05 is `tumi-launch-2026-10-05`.
- **New event's album token.** `crypto.randomBytes(18).toString("base64url")`, which matches the existing token pattern.
- **New event's session.** A copy of the active event's session, so the operator starts from what the booth is set up for.
- **Name and date validation.** The name is trimmed, 1 to 80 characters. The date is `YYYY-MM-DD` and defaults to today (booth PC local time).

## Agent

Everything that reads `config.event` or `album.token` or `session.json` today reads the active event instead:

- **Captures** are tagged with the active event's id when taken. Each capture keeps its own `event_id` in the outbox, so photos still queued when the operator switches upload into their own event's folder.
- **Compositing** fills `{event}` with the active event's name.
- **Session settings** routes (`GET`/`POST /session`, the in-use check in `POST /templates/:id/delete`, `POST /attract-slideshow`) read and write the active event's `session`.
- **`/album-info`** and **`/album.json`** (the kiosk's own album list) use the active event and its token.
- **`/health`** gains `eventName` and `eventDate` next to `eventId`, and an `events-file-unreadable` error alert when `events.json` could not be parsed.
- **Preflight** checks the active event's id instead of `config.event.id`.

### Album publisher

Today the publisher only knows one target (event + token). With several events it has to keep each event's album right:

- `markDirty(eventId)` adds the event to a dirty set. The sync worker passes the uploaded row's `event_id`; `POST /print` passes the capture's event.
- `publishIfDirty()` writes the manifest for every dirty event that has a token (looked up in the event store), then removes that event's other manifests, as today.
- Activating an event marks it dirty, so a new event's album link works straight away (an empty album) and a revisited event is refreshed.
- Retry and quiet-logging stay as they are. `getStatus()` reports the active event's album, as `/health` does today.

### API

All routes need the shared secret, like the rest.

- `GET /events` → `{ activeId, events: [{ id, name, date, photoCount }] }`, newest date first. `photoCount` is the event's printed captures (`listAlbumPrints`). Tokens are not listed; `/album-info` still gives the active one.
- `POST /events` with `{ name, date? }` → creates the event, makes it active, and returns it (201). 400 on a bad name or date.
- `POST /events/:id/activate` → makes it active (200), 404 for an unknown id.

Switching is only offered in the operator panel, so it never happens mid-session.

## Kiosk

- **Event name from the agent.** `config.eventName` and `config.eventDate` (from `VITE_EVENT_NAME`/`VITE_EVENT_DATE`) are replaced by `/health`'s `eventName` and `eventDate` everywhere it's shown: the Attract pill, the sample strips, the album screen, the layout editor's `{event}` sample text and the operator header. `VITE_EVENT_NAME` and `VITE_EVENT_DATE` are dropped from `.env.example`.
- **Download URL.** `VITE_DOWNLOAD_URL` supports `{eventId}` and `{eventName}` placeholders alongside `{captureId}`, filled from `/health`. A URL without them keeps working as before (for the event it names).
- **Events tab** in the operator panel (next to Album):
  - the list, newest first: name, date, photo count, a marker on the active one, and a "Switch" button on the others;
  - "New event": a name field and a date field (default today) and "Create", which creates and switches.
  - After a switch or create, the kiosk reloads the page, so every screen (and the attract slideshow's cached prints) starts over on the new event.

## Error handling

- Create/activate failures show the agent's message in the tab; the active event is unchanged.
- A failed `events.json` write returns 500 and leaves the in-memory state as it was, so memory and disk never disagree.

## Testing

- `eventStore`: migration from config + `session.json`; create (id slug, empty slug, clash suffix, token format, session copy, becomes active); activate (unknown id); round-trip through the file; an unreadable file falls back without overwriting.
- Album publisher: dirty events each get their own manifest with their own token; activating marks the event dirty; status follows the active event.
- Routes: `/events` list/create/activate including 400/404; a capture after a switch is tagged with the new event; `{event}` in compositing uses the new name; session settings follow the active event.
- Kiosk: `npm run build`; download URL placeholder filling as a unit test; the Events tab checked in the browser at 1280×800.

## Deploy

1. Build the agent; the user restarts the service. The first start writes `events.json` from the current config.
2. Update `C:\BoothAgent\kiosk\.env.local`: `VITE_DOWNLOAD_URL` uses `e={eventId}&name={eventName}` instead of the fixed event (backup first), and `VITE_EVENT_NAME` can go.
3. Deploy and build the kiosk as usual, then reload it.
