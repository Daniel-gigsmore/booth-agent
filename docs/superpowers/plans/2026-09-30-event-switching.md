# Event Switching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The operator picks an existing event or starts a new one from the kiosk's operator panel; booth-agent tags captures, composites, albums and session settings with the active event.

**Architecture:** booth-agent keeps `<dataDir>/events.json` (the event list plus the active id) behind a new `EventStore`, migrated on first start from `booth.config.json` and `session.json`. Every route that used `config.event`, `config.album.token` or `session.json` reads the active event instead, and the album publisher tracks dirty albums per event. The kiosk gets the active event from `/health` through a React context, and a new Events tab lists, creates and switches events.

**Tech Stack:** TypeScript, Node (node:sqlite outbox), Express, zod, vitest; kiosk: React 18 + Vite.

**Spec:** `docs/superpowers/specs/2026-09-30-event-switching-design.md`

## Global Constraints

- All events share the one Supabase project in `booth.config.json`; an event is a folder (`<eventId>/…`) in the bucket.
- New event id: `slug(name) + "-" + date`; slug = lowercase, runs of non-`a-z0-9` become `-`, dashes trimmed, empty slug becomes `event`; clashes get `-2`, `-3`, ….
- New album token: `crypto.randomBytes(18).toString("base64url")`; tokens must match `/^[A-Za-z0-9_-]{16,}$/`.
- Name: trimmed, 1–80 characters. Date: `YYYY-MM-DD`, default today in booth PC local time.
- `booth.config.json`'s schema does not change; `config.event` and `config.album` only seed `events.json`.
- `session.json` is never written again (left on disk).
- No deleting or renaming events.
- Run the agent tests with `npx vitest run <file>` from the repo root; the kiosk has no test script, its `*.test.ts` files also run under the root vitest. Kiosk build: `npm run build --prefix kiosk`.
- Match the surrounding code: comments explain why, not what; no new dependencies.

---

## File map

- Create `src/session/eventStore.ts` — the event list, active event, migration, atomic file writes.
- Modify `src/album/albumPublisher.ts` — per-event dirty set; looks tokens up per event.
- Modify `src/outbox/syncWorker.ts` — `AlbumHooks.markDirty(eventId)`.
- Modify `src/server/context.ts` — `events: EventStore` on `AgentContext`.
- Modify `src/index.ts` — open the store, wire the publisher and preflight.
- Modify `src/server/routes.ts` — active event everywhere; `/events` routes.
- Modify `src/health/healthReport.ts` — `eventName`, `eventDate`, `events-file-unreadable` alert.
- Modify `src/startup/preflight.ts` — check the active event id.
- Create `kiosk/src/event.ts` — `EventContext`, `useEvent()`, `fillDownloadUrl()`.
- Create `kiosk/src/EventsTab.tsx` — the operator's Events tab.
- Modify kiosk `agent.ts`, `App.tsx`, `screens.tsx`, `AlbumScreen.tsx`, `LayoutEditor.tsx`, `Operator.tsx`, `.env.example`, `README.md`; root `README.md` (API section).
- Tests: `tests/eventStore.test.ts` (new), `tests/events.routes.test.ts` (new), `tests/album.publisher.test.ts`, the route tests that build an `AgentContext` by hand, `kiosk/src/event.test.ts` (new).

---

### Task 1: EventStore

**Files:**
- Create: `src/session/eventStore.ts`
- Test: `tests/eventStore.test.ts`

**Interfaces:**
- Consumes: `SessionSettings`, `SessionSettingsSchema`, `DEFAULT_SESSION` from `src/session/sessionSettings.ts`; `createLogger` from `src/util/logger.ts`.
- Produces:
  - `interface BoothEvent { id: string; name: string; date: string; albumToken?: string; session: SessionSettings }`
  - `interface EventSeed { id: string; name?: string; albumToken?: string; session: SessionSettings }`
  - `const NewEventSchema` (zod: `{ name: string (trimmed, 1–80), date?: "YYYY-MM-DD" }`)
  - `function eventSlug(name: string): string`
  - `function localDate(d?: Date): string` — `YYYY-MM-DD` in local time
  - `class UnknownEventError extends Error`
  - `class EventStore` with `static open(dataDir: string, seed: EventSeed, today?: string): EventStore`, `readonly loadError: string | null`, `active(): BoothEvent`, `get(id: string): BoothEvent | undefined`, `list(): BoothEvent[]` (newest date first), `create(input: { name: string; date?: string }, today?: string): BoothEvent`, `activate(id: string): BoothEvent`, `updateActiveSession(session: SessionSettings): void`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/eventStore.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventStore, EventSeed, UnknownEventError, eventSlug, NewEventSchema } from "../src/session/eventStore";
import { DEFAULT_SESSION } from "../src/session/sessionSettings";

const TOKEN = "tok-0123456789abcdef";
const SEED: EventSeed = {
  id: "gigsmore-launch-2026",
  name: "Gigsmore Launch",
  albumToken: TOKEN,
  session: { ...DEFAULT_SESSION, templateId: "overlay-test" },
};
let dataDir: string;
const file = () => path.join(dataDir, "events.json");
const onDisk = async () => JSON.parse(await readFile(file(), "utf-8"));

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "booth-events-"));
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe("eventSlug", () => {
  it("lowercases and dashes everything outside a-z0-9", () => {
    expect(eventSlug("  TUMI Launch!! 2.0 ")).toBe("tumi-launch-2-0");
  });
  it("falls back to 'event' when nothing is left (e.g. a Chinese-only name)", () => {
    expect(eventSlug("婚礼")).toBe("event");
  });
});

describe("NewEventSchema", () => {
  it("trims the name and accepts an optional YYYY-MM-DD date", () => {
    expect(NewEventSchema.parse({ name: "  A  " })).toEqual({ name: "A" });
    expect(NewEventSchema.parse({ name: "A", date: "2026-10-05" })).toEqual({ name: "A", date: "2026-10-05" });
  });
  it("rejects a blank or too-long name and a bad date", () => {
    expect(NewEventSchema.safeParse({ name: "   " }).success).toBe(false);
    expect(NewEventSchema.safeParse({ name: "x".repeat(81) }).success).toBe(false);
    expect(NewEventSchema.safeParse({ name: "A", date: "5/10/2026" }).success).toBe(false);
  });
});

describe("EventStore", () => {
  it("creates events.json from the seed on first open", async () => {
    const store = EventStore.open(dataDir, SEED, "2026-09-30");
    const expected = { id: SEED.id, name: "Gigsmore Launch", date: "2026-09-30", albumToken: TOKEN, session: SEED.session };
    expect(store.active()).toEqual(expected);
    expect(store.loadError).toBeNull();
    expect(await onDisk()).toEqual({ activeId: SEED.id, events: [expected] });
  });

  it("uses the id as the name when the seed has none, and leaves out a missing token", () => {
    const store = EventStore.open(dataDir, { id: "evt", session: DEFAULT_SESSION }, "2026-09-30");
    expect(store.active()).toEqual({ id: "evt", name: "evt", date: "2026-09-30", session: DEFAULT_SESSION });
  });

  it("reads an existing file instead of the seed", async () => {
    EventStore.open(dataDir, SEED, "2026-09-30").create({ name: "TUMI", date: "2026-10-05" });
    const reopened = EventStore.open(dataDir, { id: "ignored", session: DEFAULT_SESSION });
    expect(reopened.active().id).toBe("tumi-2026-10-05");
    expect(reopened.list().map((e) => e.id)).toEqual(["tumi-2026-10-05", SEED.id]);
  });

  it("creates a new event: slug id, fresh token, copied session, and makes it active", async () => {
    const store = EventStore.open(dataDir, SEED, "2026-09-30");
    const created = store.create({ name: "TUMI Launch", date: "2026-10-05" });
    expect(created.id).toBe("tumi-launch-2026-10-05");
    expect(created.name).toBe("TUMI Launch");
    expect(created.albumToken).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(created.albumToken).not.toBe(TOKEN);
    expect(created.session).toEqual(SEED.session);
    expect(store.active().id).toBe(created.id);
    expect((await onDisk()).activeId).toBe(created.id);
  });

  it("defaults the date to today and suffixes a clashing id", () => {
    const store = EventStore.open(dataDir, SEED, "2026-09-30");
    expect(store.create({ name: "Party" }, "2026-10-01").id).toBe("party-2026-10-01");
    expect(store.create({ name: "Party" }, "2026-10-01").id).toBe("party-2026-10-01-2");
    expect(store.create({ name: "PARTY!" }, "2026-10-01").id).toBe("party-2026-10-01-3");
  });

  it("lists newest date first", () => {
    const store = EventStore.open(dataDir, SEED, "2026-09-30");
    store.create({ name: "Later", date: "2026-11-01" });
    store.create({ name: "Earlier", date: "2026-01-01" });
    expect(store.list().map((e) => e.date)).toEqual(["2026-11-01", "2026-09-30", "2026-01-01"]);
  });

  it("switches to an existing event and rejects an unknown one", async () => {
    const store = EventStore.open(dataDir, SEED, "2026-09-30");
    store.create({ name: "TUMI", date: "2026-10-05" });
    expect(store.activate(SEED.id).id).toBe(SEED.id);
    expect((await onDisk()).activeId).toBe(SEED.id);
    expect(() => store.activate("nope")).toThrow(UnknownEventError);
    expect(store.active().id).toBe(SEED.id);
  });

  it("saves session changes on the active event only", async () => {
    const store = EventStore.open(dataDir, SEED, "2026-09-30");
    store.create({ name: "TUMI", date: "2026-10-05" });
    store.updateActiveSession({ ...SEED.session, templateId: "default-4r-grid" });
    expect(store.active().session.templateId).toBe("default-4r-grid");
    expect(store.get(SEED.id)!.session.templateId).toBe("overlay-test");
    const disk = await onDisk();
    expect(disk.events.find((e: { id: string }) => e.id === "tumi-2026-10-05").session.templateId).toBe("default-4r-grid");
  });

  it("runs on the seed without touching an unreadable file, and refuses to write", async () => {
    await writeFile(file(), "{ not json");
    const store = EventStore.open(dataDir, SEED, "2026-09-30");
    expect(store.loadError).toMatch(/JSON/);
    expect(store.active().id).toBe(SEED.id);
    expect(() => store.create({ name: "TUMI" })).toThrow(/events\.json/);
    expect(await readFile(file(), "utf-8")).toBe("{ not json");
  });

  it("treats a file whose activeId isn't in the list as unreadable", async () => {
    await writeFile(file(), JSON.stringify({ activeId: "gone", events: [{ id: "a", name: "A", date: "2026-01-01", session: DEFAULT_SESSION }] }));
    expect(EventStore.open(dataDir, SEED).loadError).toMatch(/activeId/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/eventStore.test.ts`
Expected: FAIL — cannot resolve `../src/session/eventStore`.

- [ ] **Step 3: Implement the store**

```ts
// src/session/eventStore.ts
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { SessionSettings, SessionSettingsSchema } from "./sessionSettings";
import { createLogger } from "../util/logger";

const log = createLogger("events");

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * One event the booth has worked: its Supabase folder (id), what guests see (name, date),
 * the secret in its album link, and the session settings it was set up with.
 */
const BoothEventSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  date: z.string().regex(DATE),
  albumToken: z.string().regex(/^[A-Za-z0-9_-]{16,}$/).optional(),
  session: SessionSettingsSchema,
});
export type BoothEvent = z.infer<typeof BoothEventSchema>;

const EventsFileSchema = z
  .object({ activeId: z.string(), events: z.array(BoothEventSchema).min(1) })
  .refine((f) => f.events.some((e) => e.id === f.activeId), { message: "activeId is not one of the events" });
type EventsFile = z.infer<typeof EventsFileSchema>;

/** POST /events. */
export const NewEventSchema = z.object({
  name: z.string().trim().min(1).max(80),
  date: z.string().regex(DATE, "date must be YYYY-MM-DD").optional(),
});

/** What the booth ran on before events.json existed: booth.config.json's event and album token, and session.json. */
export interface EventSeed {
  id: string;
  name?: string;
  albumToken?: string;
  session: SessionSettings;
}

export class UnknownEventError extends Error {}

/** Today on the booth PC's clock, as YYYY-MM-DD. */
export function localDate(d: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The name part of a new event's id. Names with no a-z0-9 at all (e.g. Chinese) become "event". */
export function eventSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "event";
}

/** Temp file then rename, so a crash mid-write never leaves half a file. */
function writeAtomic(filePath: string, data: EventsFile): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  renameSync(tmp, filePath);
}

/**
 * The booth's events and which one is on, in <dataDir>/events.json. Like session.json it lives
 * in the data dir rather than booth.config.json, which the API must never rewrite.
 */
export class EventStore {
  private constructor(
    /** null while events.json is unreadable: the store then never writes. */
    private readonly filePath: string | null,
    private file: EventsFile,
    readonly loadError: string | null
  ) {}

  static open(dataDir: string, seed: EventSeed, today: string = localDate()): EventStore {
    const filePath = path.join(dataDir, "events.json");
    const seeded: EventsFile = {
      activeId: seed.id,
      events: [
        {
          id: seed.id,
          name: seed.name || seed.id,
          date: today,
          ...(seed.albumToken ? { albumToken: seed.albumToken } : {}),
          session: seed.session,
        },
      ],
    };
    if (!existsSync(filePath)) {
      try {
        writeAtomic(filePath, seeded);
        log.info(`Created events.json from booth.config.json (event "${seed.id}")`);
      } catch (err) {
        // A booth that won't boot is worse than one that retries this on the next change.
        log.error("Could not create events.json", err);
      }
      return new EventStore(filePath, seeded, null);
    }
    try {
      return new EventStore(filePath, EventsFileSchema.parse(JSON.parse(readFileSync(filePath, "utf-8"))), null);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`events.json can't be read - running on booth.config.json's event until it is fixed: ${message}`);
      return new EventStore(null, seeded, message);
    }
  }

  active(): BoothEvent {
    return this.file.events.find((e) => e.id === this.file.activeId)!;
  }

  get(id: string): BoothEvent | undefined {
    return this.file.events.find((e) => e.id === id);
  }

  /** Newest date first. */
  list(): BoothEvent[] {
    return [...this.file.events].sort((a, b) => b.date.localeCompare(a.date) || a.name.localeCompare(b.name));
  }

  /** Adds an event and makes it the active one. It starts with the active event's session settings. */
  create(input: { name: string; date?: string }, today: string = localDate()): BoothEvent {
    const name = input.name.trim();
    const date = input.date ?? today;
    const base = `${eventSlug(name)}-${date}`;
    let id = base;
    for (let n = 2; this.get(id); n += 1) id = `${base}-${n}`;
    const event: BoothEvent = {
      id,
      name,
      date,
      albumToken: randomBytes(18).toString("base64url"),
      session: { ...this.active().session },
    };
    this.save({ activeId: id, events: [...this.file.events, event] });
    return event;
  }

  activate(id: string): BoothEvent {
    const event = this.get(id);
    if (!event) throw new UnknownEventError(`no event ${id}`);
    this.save({ ...this.file, activeId: id });
    return event;
  }

  updateActiveSession(session: SessionSettings): void {
    this.save({
      ...this.file,
      events: this.file.events.map((e) => (e.id === this.file.activeId ? { ...e, session } : e)),
    });
  }

  /** Disk first: if the write throws, memory keeps the old state, so the two never disagree. */
  private save(next: EventsFile): void {
    if (!this.filePath) {
      throw new Error(`events.json can't be read (${this.loadError}) - fix or delete it, then restart booth-agent`);
    }
    writeAtomic(this.filePath, next);
    this.file = next;
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/eventStore.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add src/session/eventStore.ts tests/eventStore.test.ts
git commit -m "feat(agent): event store in events.json, migrated from booth.config.json"
```

---

### Task 2: Album publisher keeps each event's album

**Files:**
- Modify: `src/album/albumPublisher.ts`
- Modify: `src/outbox/syncWorker.ts:26-33` (`AlbumHooks`) and `:99` (the `markDirty` call)
- Test: `tests/album.publisher.test.ts`, plus any sync worker test that fakes `AlbumHooks` (`grep -rln "markDirty" tests`)

**Interfaces:**
- Consumes: nothing from Task 1 directly (it takes callbacks).
- Produces:
  - `interface AlbumEvents { activeId(): string; tokenFor(eventId: string): string | undefined }`
  - `new AlbumPublisher(backend: AlbumBackend, events: AlbumEvents, now?: () => number)`
  - `markDirty(eventId: string): void`
  - `publishIfDirty(): Promise<void>`, `getStatus(): AlbumStatus` (unchanged shapes)
  - `AlbumHooks.markDirty(eventId: string): void`
  - `AlbumTarget` is removed.

- [ ] **Step 1: Update the test helper and add per-event tests**

In `tests/album.publisher.test.ts`, replace the `AlbumTarget` import and `setup()` with:

```ts
import { ALBUM_RETRY_MS, AlbumBackend, AlbumManifest, AlbumPhoto, AlbumPublisher } from "../src/album/albumPublisher";

function setup(options: { token?: string } = { token: TOKEN }) {
  const backend = new FakeBackend();
  let now = 1_000_000;
  const tokens: Record<string, string | undefined> = { evt: options.token };
  const state = { activeId: "evt" };
  const publisher = new AlbumPublisher(
    backend,
    { activeId: () => state.activeId, tokenFor: (id) => tokens[id] },
    () => now
  );
  return { backend, publisher, tokens, state, advance: (ms: number) => { now += ms; } };
}
```

Then, in the existing tests: every `publisher.markDirty()` becomes `publisher.markDirty("evt")`, and the "rewrites when the token changes" test sets `tokens.evt = "<new token>"` where it used to set `target.token`. Keep every existing assertion. Add these tests inside `describe("AlbumPublisher", …)`:

```ts
  it("writes each dirty event's album with that event's own token", async () => {
    const { backend, publisher, tokens, state } = setup();
    await publisher.publishIfDirty();
    tokens["new"] = "tok-new-0123456789abcd";
    state.activeId = "new";
    publisher.markDirty("evt"); // a print from the old event finished uploading after the switch
    await publisher.publishIfDirty();
    expect(backend.written.map((w) => `${w.eventId}/${w.token}`)).toEqual([
      `evt/${TOKEN}`,
      `evt/${TOKEN}`,
      "new/tok-new-0123456789abcd",
    ]);
  });

  it("writes a newly active event's album straight away, even with no prints", async () => {
    const { backend, publisher, tokens, state } = setup();
    await publisher.publishIfDirty();
    tokens["new"] = "tok-new-0123456789abcd";
    state.activeId = "new";
    await publisher.publishIfDirty();
    expect(backend.written.at(-1)).toMatchObject({ eventId: "new", token: "tok-new-0123456789abcd" });
  });

  it("skips a dirty event that has no token", async () => {
    const { backend, publisher } = setup();
    await publisher.publishIfDirty();
    publisher.markDirty("tokenless");
    await publisher.publishIfDirty();
    expect(backend.written).toHaveLength(1);
  });

  it("reports the active event's photo count, not another event's", async () => {
    const { backend, publisher, tokens, state } = setup();
    backend.prints = [{ id: "a", takenAt: "2026-09-29T10:00:00.000Z" }];
    await publisher.publishIfDirty();
    tokens["new"] = "tok-new-0123456789abcd";
    state.activeId = "new";
    backend.prints = [];
    await publisher.publishIfDirty();
    expect(publisher.getStatus().photoCount).toBe(0);
  });
```

In any sync worker test that fakes `AlbumHooks`, change the fake's `markDirty` to accept `(eventId: string)` and, where the test asserts it was called, assert it was called with the row's `event_id`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/album.publisher.test.ts`
Expected: FAIL — type errors / wrong writes (the publisher still takes `getTarget`).

- [ ] **Step 3: Implement**

In `src/album/albumPublisher.ts`, replace `AlbumTarget` with:

```ts
/** Which event is on, and each event's album token (src/session/eventStore.ts). */
export interface AlbumEvents {
  activeId(): string;
  tokenFor(eventId: string): string | undefined;
}
```

Update the class doc comment's first sentence to say it keeps each event's `captures/<event>/albums/<token>.json` in step, then replace the class body's state, constructor, `markDirty`, `publishIfDirty` and `getStatus` with:

```ts
  // Events whose album needs rewriting. The active event is added on the first tick, so a
  // write lost before a restart is caught up.
  private readonly dirty = new Set<string>();
  private activeTarget: string | null = null;
  private retryAt = 0;
  /** photoCount and lastWrittenAt are the active event's; lastError and failingSince cover any event. */
  private written: Omit<AlbumStatus, "enabled"> = { photoCount: null, lastWrittenAt: null, lastError: null, failingSince: null };
  private lastLogged: { message: string; at: number } | null = null;

  constructor(
    private readonly backend: AlbumBackend,
    private readonly events: AlbumEvents,
    private readonly now: () => number = Date.now
  ) {}

  markDirty(eventId: string): void {
    this.dirty.add(eventId);
  }

  async publishIfDirty(): Promise<void> {
    const activeId = this.events.activeId();
    const target = `${activeId}/${this.events.tokenFor(activeId) ?? ""}`;
    if (target !== this.activeTarget) {
      // A newly active event (or a new token) needs its manifest right away, so its link works.
      this.activeTarget = target;
      this.dirty.add(activeId);
      this.retryAt = 0;
    }
    if (this.dirty.size === 0 || this.now() < this.retryAt) return;

    for (const eventId of [...this.dirty]) {
      const token = this.events.tokenFor(eventId);
      // Cleared before the write, so a print that uploads while it runs marks it dirty again.
      this.dirty.delete(eventId);
      if (!token) continue;
      try {
        const photos = await this.backend.listPrints(eventId);
        const at = new Date(this.now()).toISOString();
        await this.backend.writeManifest(eventId, token, { updatedAt: at, photos });
        this.written = {
          ...(eventId === activeId ? { photoCount: photos.length, lastWrittenAt: at } : this.written),
          lastError: null,
          failingSince: null,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.dirty.add(eventId);
        this.retryAt = this.now() + ALBUM_RETRY_MS;
        this.written = {
          ...this.written,
          lastError: message,
          failingSince: this.written.failingSince ?? new Date(this.now()).toISOString(),
        };
        this.warnQuietly(`Album manifest for ${eventId} not written, will retry: ${message}`);
        return;
      }

      try {
        await this.backend.removeOtherManifests(eventId, token);
      } catch (err) {
        // Tried again after the next write; a leftover old manifest is not worth re-dirtying for.
        this.warnQuietly(`Could not remove old album manifests: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  getStatus(): AlbumStatus {
    if (!this.events.tokenFor(this.events.activeId())) {
      return { enabled: false, photoCount: null, lastWrittenAt: null, lastError: null, failingSince: null };
    }
    return { enabled: true, ...this.written };
  }
```

If an existing test asserts the old warning text exactly (`Album manifest not written, will retry`), update it to the new text that names the event.

In `src/outbox/syncWorker.ts`:

```ts
export interface AlbumHooks {
  markDirty(eventId: string): void;
  publishIfDirty(): Promise<void>;
}
```

and at the print-upload line:

```ts
      if (row.composite_path !== null && sourcePath === row.composite_path) this.album?.markDirty(row.event_id);
```

(`src/index.ts` and `src/server/routes.ts` will not compile until Task 3; that is expected.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/album.publisher.test.ts` and every sync worker test file found by the grep above.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/album/albumPublisher.ts src/outbox/syncWorker.ts tests/
git commit -m "feat(agent): album publisher keeps each event's album up to date"
```

---

### Task 3: The agent runs on the active event

**Files:**
- Modify: `src/server/context.ts`, `src/index.ts`, `src/server/routes.ts`, `src/health/healthReport.ts`, `src/startup/preflight.ts`
- Test: `tests/album.info.test.ts`, `tests/album.routes.test.ts`, `tests/album.printed.test.ts`, `tests/camera.routes.dual.test.ts`, `tests/templates.routes.test.ts`, `tests/layoutPreview.routes.test.ts`, `tests/layoutTransfer.routes.test.ts`, `tests/album.health.test.ts`, and any other test that fails once `ctx.events` is required (find them with `npm test`)

**Interfaces:**
- Consumes: `EventStore`, `EventSeed` (Task 1); `AlbumPublisher(backend, AlbumEvents)` (Task 2).
- Produces:
  - `AgentContext.events: EventStore`
  - `HealthInputs.eventName?: string`, `HealthInputs.eventDate?: string`, `HealthInputs.eventsFileError?: string | null`
  - `HealthReport.eventName: string`, `HealthReport.eventDate: string | null`
  - `/health` alert `{ level: "error", code: "events-file-unreadable" }`
  - `runPreflight(config: BoothConfig, eventId?: string)`

- [ ] **Step 1: Write the failing tests**

Add to `tests/album.health.test.ts` (it already builds `HealthInputs` in a helper; pass the new fields through that helper):

```ts
  it("reports the event's name and date, falling back to the id", () => {
    expect(report({ eventName: "Gigsmore Launch", eventDate: "2026-09-30" })).toMatchObject({
      eventId: "evt",
      eventName: "Gigsmore Launch",
      eventDate: "2026-09-30",
    });
    expect(report({})).toMatchObject({ eventName: "evt", eventDate: null });
  });

  it("errors while events.json can't be read", () => {
    const alerts = report({ eventsFileError: "Unexpected token" }).alerts;
    expect(alerts).toContainEqual(expect.objectContaining({ level: "error", code: "events-file-unreadable" }));
  });
```

(Adapt `report(...)` to the helper's real name and signature in that file: it spreads overrides into the default inputs.)

Add to `tests/album.info.test.ts` — first change `start()` so the context carries an `EventStore` (the routes stop reading `config.event`, `config.album` and `session.json`):

```ts
import { EventStore } from "../src/session/eventStore";
import { DEFAULT_SESSION } from "../src/session/sessionSettings";

let events: EventStore;

async function start(album: { token?: string }) {
  events = EventStore.open(dataDir, { id: "gigsmore-launch-2026", name: "Gigsmore Launch", albumToken: album.token, session: DEFAULT_SESSION });
  const ctx = {
    configStore: {
      current: {
        agent: { allowedOrigins: [], sharedSecret: SECRET },
        storage: { dataDir },
        compositing: { templateDir: path.join(__dirname, "..", "assets", "templates") },
      },
    },
    events,
  } as unknown as AgentContext;
  server = buildHttpApp(ctx).listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
```

Replace every `readSessionSettings(dataDir)` assertion in that file with `events.active().session`, and add:

```ts
  it("follows the active event", async () => {
    await start({ token: TOKEN });
    const created = events.create({ name: "TUMI", date: "2026-10-05" });
    const body = await (await fetch(`${base}/album-info`, { headers: auth })).json();
    expect(body).toMatchObject({ token: created.albumToken, eventId: "tumi-2026-10-05", eventName: "TUMI" });
  });
```

In each other route test that builds an `AgentContext` by hand with `event: { id: … }` in its config (`album.routes`, `camera.routes.dual`, `templates.routes`, `layoutPreview.routes`, `layoutTransfer.routes`), add an `events` field built the same way — `EventStore.open(<a temp dir>, { id: "evt", name: <the name it used, if any>, session: DEFAULT_SESSION })` — using the test's existing temp dir, or a new `mkdtemp` one removed in `afterAll`/`afterEach`. Tests that set the session layout through `writeSessionSettings`/`session.json` must set it through `events.updateActiveSession(...)` instead. Add to `tests/layoutPreview.routes.test.ts`, after its existing `{event}` test, a case that calls `events.create({ name: "TUMI", date: "2026-10-05" })` and asserts the next preview's text variable is `TUMI` (mirror how the existing test checks "Gigsmore Launch").

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — the new health tests, `album-info follows the active event`, and compile errors in `src/index.ts` / `routes.ts` from Task 2.

- [ ] **Step 3: Implement**

`src/server/context.ts` — add the import and field:

```ts
import { EventStore } from "../session/eventStore";
…
  /** The booth's events; captures, layouts and the album follow the active one. */
  events: EventStore;
```

`src/health/healthReport.ts`:
- `HealthInputs`: after `eventId: string;` add
  ```ts
  /** The active event's name and date (events.json). */
  eventName?: string;
  eventDate?: string;
  /** Why events.json couldn't be read; the booth then runs on booth.config.json's event. */
  eventsFileError?: string | null;
  ```
- `HealthReport`: after `eventId: string;` add `eventName: string;` and `eventDate: string | null;`.
- In `buildHealthReport`, before the album alert block, add
  ```ts
  if (inputs.eventsFileError) {
    alerts.push({
      level: "error",
      code: "events-file-unreadable",
      message: `events.json can't be read (${inputs.eventsFileError}) - photos go to the event in booth.config.json and events can't be switched. Fix or delete the file, then restart booth-agent.`,
    });
  }
  ```
- In the returned object, after `eventId,` add `eventName: inputs.eventName ?? eventId,` and `eventDate: inputs.eventDate ?? null,`.

`src/startup/preflight.ts`: give `runPreflight` a second parameter `eventId: string = config.event.id` and pass it to `checkEventId`, which becomes:

```ts
function checkEventId(eventId: string): PreflightCheck {
  const id = eventId.trim();
  if (id === "" || id === "your-event-id") {
    return fail("event.id", "event.id is unset or still the example value");
  }
  return ok("event.id", `captures will be tagged "${id}"`);
}
```

`src/index.ts`:
- Imports: `import { EventStore } from "./session/eventStore";` and `import { readSessionSettings } from "./session/sessionSettings";`.
- Right after `const config = configStore.current;`, open the store (before preflight):
  ```ts
  // First start after the event-switching update: seed events.json from what the booth ran on until now.
  const events = EventStore.open(config.storage.dataDir, {
    id: config.event.id,
    name: config.event.name,
    albumToken: config.album.token,
    session: readSessionSettings(config.storage.dataDir),
  });
  ```
- `const preflight = await runPreflight(config, events.active().id);`
- The publisher's second argument becomes
  ```ts
    { activeId: () => events.active().id, tokenFor: (eventId) => events.get(eventId)?.albumToken }
  ```
- Add `events,` to the `ctx` object.

`src/server/routes.ts`:
- Import `UnknownEventError` is not needed yet (Task 4). Replace the `readSessionSettings, writeSessionSettings, SessionSettingsSchema` import with `import { SessionSettingsSchema } from "../session/sessionSettings";`.
- `/health`: the `layoutUsesLow` template load uses `ctx.events.active().session.templateId`; in `buildHealthReport({...})` set
  ```ts
        eventId: event.id,
        eventName: event.name,
        eventDate: event.date,
        eventsFileError: ctx.events.loadError,
  ```
  with `const event = ctx.events.active();` at the top of the handler.
- `POST /health/preflight`: `runPreflight(ctx.configStore.current, ctx.events.active().id)`.
- `POST /capture`: `eventId: ctx.events.active().id,`.
- `/album.json`: `ctx.outboxStore.listAlbumPrints(ctx.events.active().id)`.
- `/album-info`:
  ```ts
    const event = ctx.events.active();
    res.set("Cache-Control", "no-store").json({
      token: event.albumToken ?? null,
      eventId: event.id,
      eventName: event.name,
      attractSlideshow: event.session.attractSlideshow,
    });
  ```
- `POST /attract-slideshow`: `ctx.events.updateActiveSession({ ...ctx.events.active().session, attractSlideshow: parsed.data.enabled });` (drop the `dataDir` line).
- `POST /composite`: `variables: textVariables(ctx.events.active().name, captureId),`.
- `renderDraft`: `variables: textVariables(ctx.events.active().name, "a1b2c3d4"),`.
- `POST /print`: `ctx.album.markDirty(row.event_id);`.
- `POST /templates/:id/delete`: `if (ctx.events.active().session.templateId === id) {`.
- `GET /session`: `const settings = ctx.events.active().session;`.
- `POST /session`: `const current = ctx.events.active().session;` and `ctx.events.updateActiveSession(parsed.data);` in place of `writeSessionSettings(...)`.

After these edits `grep -n "config.event\|album.token\|readSessionSettings\|writeSessionSettings" src/server/routes.ts` must print nothing.

- [ ] **Step 4: Run the whole suite and the typecheck**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src tests
git commit -m "feat(agent): captures, layouts, albums and health follow the active event"
```

---

### Task 4: `/events` API

**Files:**
- Modify: `src/server/routes.ts` (new routes before `return router;`), `README.md` (API section)
- Test: `tests/events.routes.test.ts`

**Interfaces:**
- Consumes: `EventStore`, `NewEventSchema`, `UnknownEventError` (Task 1); `ctx.events`, `ctx.album.markDirty` (Tasks 2–3); `ctx.outboxStore.listAlbumPrints(eventId)`.
- Produces (HTTP, all behind the shared secret):
  - `GET /events` → `200 { activeId: string, events: Array<{ id, name, date, photoCount: number }> }` newest date first
  - `POST /events` body `{ name: string, date?: string }` → `201 { id, name, date }`; `400 { error }`; `500 { error }` when the file can't be written
  - `POST /events/:id/activate` → `200 { id, name, date }`; `404 { error }`; `500 { error }`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/events.routes.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AddressInfo } from "node:net";
import { Server } from "node:http";
import { buildHttpApp } from "../src/server/http";
import { AgentContext } from "../src/server/context";
import { createInMemoryOutboxDb } from "../src/outbox/db";
import { OutboxStore } from "../src/outbox/outboxStore";
import { EventStore } from "../src/session/eventStore";
import { DEFAULT_SESSION } from "../src/session/sessionSettings";

const SECRET = "test-secret";
const auth = { Authorization: `Bearer ${SECRET}` };
let dataDir: string;
let server: Server;
let base: string;
let events: EventStore;
let markDirty: ReturnType<typeof vi.fn>;

function start() {
  const outbox = new OutboxStore(createInMemoryOutboxDb());
  outbox.insertCapture({ id: "p1", eventId: "evt", source: "webcam", originalPath: "/tmp/p1.jpg", takenAt: "2026-09-30T10:00:00.000Z" });
  outbox.setCompositePath("p1", "/tmp/p1-print.jpg", "4x6");
  outbox.insertPrintJob({ id: "job-p1", captureId: "p1", size: "4x6", filePath: "/tmp/p1-print.jpg" });
  markDirty = vi.fn();
  const ctx = {
    configStore: { current: { agent: { allowedOrigins: [], sharedSecret: SECRET }, storage: { dataDir } } },
    outboxStore: outbox,
    album: { markDirty },
    events,
  } as unknown as AgentContext;
  server = buildHttpApp(ctx).listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const post = (p: string, body?: unknown) =>
  fetch(`${base}${p}`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "booth-events-routes-"));
  events = EventStore.open(dataDir, { id: "evt", name: "Gigsmore Launch", session: DEFAULT_SESSION }, "2026-09-30");
  start();
});

afterEach(async () => {
  server.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe("/events", () => {
  it("needs the shared secret", async () => {
    expect((await fetch(`${base}/events`)).status).toBe(401);
  });

  it("lists the events newest first with their printed photo counts", async () => {
    events.create({ name: "Older", date: "2026-01-01" });
    events.activate("evt");
    const res = await fetch(`${base}/events`, { headers: auth });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      activeId: "evt",
      events: [
        { id: "evt", name: "Gigsmore Launch", date: "2026-09-30", photoCount: 1 },
        { id: "older-2026-01-01", name: "Older", date: "2026-01-01", photoCount: 0 },
      ],
    });
  });

  it("creates an event and switches to it", async () => {
    const res = await post("/events", { name: "  TUMI Launch ", date: "2026-10-05" });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: "tumi-launch-2026-10-05", name: "TUMI Launch", date: "2026-10-05" });
    expect(events.active().id).toBe("tumi-launch-2026-10-05");
  });

  it("rejects a blank name or a bad date and stays on the current event", async () => {
    expect((await post("/events", { name: "  " })).status).toBe(400);
    expect((await post("/events", { name: "A", date: "tomorrow" })).status).toBe(400);
    expect(events.active().id).toBe("evt");
  });

  it("switches to an existing event and refreshes its album", async () => {
    events.create({ name: "TUMI", date: "2026-10-05" });
    const res = await post("/events/evt/activate");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "evt", name: "Gigsmore Launch", date: "2026-09-30" });
    expect(events.active().id).toBe("evt");
    expect(markDirty).toHaveBeenCalledWith("evt");
  });

  it("answers 404 for an unknown event", async () => {
    expect((await post("/events/nope/activate")).status).toBe(404);
  });

  it("answers 500 and changes nothing while events.json is unreadable", async () => {
    server.close();
    await writeFile(path.join(dataDir, "events.json"), "{ broken");
    events = EventStore.open(dataDir, { id: "evt", session: DEFAULT_SESSION });
    start();
    const res = await post("/events", { name: "TUMI" });
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/events\.json/);
    expect(events.active().id).toBe("evt");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/events.routes.test.ts`
Expected: FAIL — 404s from the missing routes (except the 401 test).

- [ ] **Step 3: Implement the routes**

Add to the imports of `src/server/routes.ts`:

```ts
import { NewEventSchema, UnknownEventError, BoothEvent } from "../session/eventStore";
```

Add before `return router;`:

```ts
  // The operator panel's Events tab. Switching changes where the next capture goes, so it is
  // only offered there, never mid-session.
  const eventSummary = (e: BoothEvent) => ({ id: e.id, name: e.name, date: e.date });

  router.get("/events", (_req: Request, res: Response) => {
    res.set("Cache-Control", "no-store").json({
      activeId: ctx.events.active().id,
      events: ctx.events.list().map((e) => ({ ...eventSummary(e), photoCount: ctx.outboxStore.listAlbumPrints(e.id).length })),
    });
  });

  router.post("/events", (req: Request, res: Response) => {
    const parsed = NewEventSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join("; ") });
      return;
    }
    try {
      const event = ctx.events.create(parsed.data);
      log.info(`New event "${event.name}" (${event.id}) is now active`);
      res.status(201).json(eventSummary(event));
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/events/:id/activate", (req: Request<{ id: string }>, res: Response) => {
    try {
      const event = ctx.events.activate(req.params.id);
      // Catches up anything that changed while another event was on.
      ctx.album.markDirty(event.id);
      log.info(`Switched to event "${event.name}" (${event.id})`);
      res.json(eventSummary(event));
    } catch (err) {
      const status = err instanceof UnknownEventError ? 404 : 500;
      res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
```

In the root `README.md` API section, add the three routes in the same style as the neighbouring entries, and one sentence that the active event lives in `<dataDir>/events.json`, seeded from `event` and `album.token` in `booth.config.json` on first start, after which those two config keys are ignored.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/events.routes.test.ts && npm run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/server/routes.ts tests/events.routes.test.ts README.md
git commit -m "feat(agent): /events API to list, create and switch events"
```

---

### Task 5: Kiosk reads the event from the agent

**Files:**
- Create: `kiosk/src/event.ts`, `kiosk/src/event.test.ts`
- Modify: `kiosk/src/agent.ts`, `kiosk/src/App.tsx`, `kiosk/src/screens.tsx`, `kiosk/src/AlbumScreen.tsx`, `kiosk/src/LayoutEditor.tsx`, `kiosk/src/Operator.tsx`, `kiosk/.env.example`, `kiosk/README.md`

**Interfaces:**
- Consumes: `/health` fields `eventId`, `eventName`, `eventDate` (Task 3).
- Produces:
  - `interface KioskEvent { id: string; name: string; date: string }`
  - `EventContext` (React context of `KioskEvent | null`), `useEvent(): KioskEvent | null`
  - `fillDownloadUrl(template: string, captureId: string, event: KioskEvent | null): string`
  - `Health.eventId: string`, `Health.eventName?: string`, `Health.eventDate?: string | null`
  - `config.downloadUrlTemplate` stays; `config.eventName`, `config.eventDate` and `config.downloadUrl` are removed.

- [ ] **Step 1: Write the failing test**

```ts
// kiosk/src/event.test.ts
import { describe, expect, it } from "vitest";
import { fillDownloadUrl } from "./event";

const EVENT = { id: "tumi-2026-10-05", name: "TUMI & Co", date: "2026-10-05" };

describe("fillDownloadUrl", () => {
  it("fills the capture id and the event from the agent, URL-encoded", () => {
    expect(fillDownloadUrl("https://x.app/?event={eventId}&name={eventName}&id={captureId}", "c1", EVENT)).toBe(
      "https://x.app/?event=tumi-2026-10-05&name=TUMI%20%26%20Co&id=c1",
    );
  });

  it("still works with an old URL that names a fixed event", () => {
    expect(fillDownloadUrl("https://x.app/?event=gigsmore&id={captureId}", "c1", EVENT)).toBe("https://x.app/?event=gigsmore&id=c1");
  });

  it("is empty when the download page isn't set up", () => {
    expect(fillDownloadUrl("", "c1", EVENT)).toBe("");
  });

  it("is empty until the agent has said which event is on, when the URL needs it", () => {
    expect(fillDownloadUrl("https://x.app/?event={eventId}&id={captureId}", "c1", null)).toBe("");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run kiosk/src/event.test.ts`
Expected: FAIL — cannot resolve `./event`.

- [ ] **Step 3: Implement**

```ts
// kiosk/src/event.ts
// The active event comes from booth-agent (/health), so switching events never needs a rebuild.
import { createContext, useContext } from "react";

export interface KioskEvent {
  id: string;
  name: string;
  /** YYYY-MM-DD */
  date: string;
}

/** Provided by App from /health; null until the agent first answers. */
export const EventContext = createContext<KioskEvent | null>(null);

export const useEvent = () => useContext(EventContext);

/**
 * The guest download link for one print. VITE_DOWNLOAD_URL may use {eventId} and {eventName}
 * as well as {captureId}; a link that needs the event gives "" (no QR) until the agent answers.
 */
export function fillDownloadUrl(template: string, captureId: string, event: KioskEvent | null): string {
  if (!template) return "";
  if (!event && /\{event(Id|Name)\}/.test(template)) return "";
  return template
    .replace("{captureId}", captureId)
    .replace("{eventId}", encodeURIComponent(event?.id ?? ""))
    .replace("{eventName}", encodeURIComponent(event?.name ?? ""));
}
```

`kiosk/src/agent.ts`:
- `config` becomes
  ```ts
  export const config = {
    /** The guest download page link with its {captureId} (and optional {eventId}/{eventName}) placeholders; "" when not set up. */
    downloadUrlTemplate: env.VITE_DOWNLOAD_URL || "",
  };
  ```
- In `interface Health`, after `alerts`, add
  ```ts
    /** The active event (events.json). eventName/eventDate are optional for an agent from before events. */
    eventId: string;
    eventName?: string;
    eventDate?: string | null;
  ```

`kiosk/src/App.tsx`:
- Import `import { EventContext, KioskEvent } from "./event";`.
- After `const health = useHealth(15_000);` add
  ```ts
  const event: KioskEvent | null = health
    ? { id: health.eventId, name: health.eventName ?? health.eventId, date: health.eventDate ?? "" }
    : null;
  ```
- Move the whole `switch (screen.name) { … }` into a local function `function renderScreen() { switch … }` (unchanged cases) and end the component with
  ```tsx
  return <EventContext.Provider value={event}>{renderScreen()}</EventContext.Provider>;
  ```

`kiosk/src/screens.tsx`:
- Import `useEvent, fillDownloadUrl` from `./event`.
- `Strip`: add `const event = useEvent();` and render `{event?.name}` / `{event?.date}` in `strip-event` / `strip-date`.
- `Attract`: add `const event = useEvent();` and use `{event?.name && <div className="pill">{event.name}</div>}`.
- `Done`: `const event = useEvent();` and `const url = fillDownloadUrl(config.downloadUrlTemplate, captureId, event);`.

`kiosk/src/AlbumScreen.tsx`:
- `PhotoQr`: `const url = fillDownloadUrl(config.downloadUrlTemplate, id, useEvent());`.
- The pill: `const event = useEvent();` in the component that renders it, then `{event?.name && <div className="pill">{event.name}</div>}`.

`kiosk/src/LayoutEditor.tsx`: in the component that renders text elements, `const event = useEvent();` and `sampleText(el.text, event?.name ?? "")`. (`sampleText` already shows "Event name" for "".)

`kiosk/src/Operator.tsx`: in `Operator`, `const event = useEvent();` and `{event?.name && <div className="muted fs-24">Event: {event.name}</div>}`.

After these edits `grep -rn "config.eventName\|config.eventDate\|config.downloadUrl(" kiosk/src` must print nothing.

`kiosk/.env.example`: delete the `VITE_EVENT_NAME` and `VITE_EVENT_DATE` lines (and their comments), and change the `VITE_DOWNLOAD_URL` comment/example to use `event={eventId}&name={eventName}&id={captureId}`, noting that the event now comes from booth-agent.

`kiosk/README.md`: where it describes `VITE_EVENT_NAME`/`VITE_EVENT_DATE`/`VITE_DOWNLOAD_URL`, say the event name and date come from booth-agent's active event (Operator → Events), and show the placeholder form of `VITE_DOWNLOAD_URL`.

- [ ] **Step 4: Run the tests and build**

Run: `npx vitest run kiosk/src && npm run build --prefix kiosk`
Expected: tests PASS; build succeeds with no type errors.

- [ ] **Step 5: Commit**

```bash
git add kiosk
git commit -m "feat(kiosk): take the event name, date and download link from the agent"
```

---

### Task 6: Events tab in the operator panel

**Files:**
- Create: `kiosk/src/EventsTab.tsx`
- Modify: `kiosk/src/agent.ts` (client calls), `kiosk/src/Operator.tsx` (tab), `kiosk/src/styles.css` (only if the existing classes can't lay the list out), `kiosk/README.md` (operator panel tabs)

**Interfaces:**
- Consumes: `GET /events`, `POST /events`, `POST /events/:id/activate` (Task 4); `useEvent()` (Task 5).
- Produces:
  - `interface EventRow { id: string; name: string; date: string; photoCount: number }`
  - `agent.events(): Promise<{ activeId: string; events: EventRow[] }>`
  - `agent.createEvent(name: string, date: string): Promise<{ id: string; name: string; date: string }>`
  - `agent.activateEvent(id: string): Promise<{ id: string; name: string; date: string }>`

- [ ] **Step 1: Add the client calls**

In `kiosk/src/agent.ts`, next to the other types:

```ts
/** One row of the operator's Events tab (GET /events). photoCount = printed photos. */
export interface EventRow { id: string; name: string; date: string; photoCount: number }
```

and inside the `agent` object, after `albumInfo`:

```ts
  events: () => call<{ activeId: string; events: EventRow[] }>("GET", "/events"),
  createEvent: (name: string, date: string) => call<{ id: string; name: string; date: string }>("POST", "/events", { name, date }),
  activateEvent: (id: string) => call<{ id: string; name: string; date: string }>("POST", `/events/${encodeURIComponent(id)}/activate`),
```

- [ ] **Step 2: Build the tab**

```tsx
// kiosk/src/EventsTab.tsx
import { useEffect, useState } from "react";
import { agent, EventRow } from "./agent";

/** Today on this PC as YYYY-MM-DD, the default date for a new event. */
function today(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Pick the event the booth is working, or start a new one. Photos, the layout settings and the
 * album link all follow it. After a change the kiosk reloads, so every screen (and the attract
 * slideshow's cached prints) starts over on the new event.
 */
export default function EventsTab() {
  const [list, setList] = useState<{ activeId: string; events: EventRow[] } | null>(null);
  const [name, setName] = useState("");
  const [date, setDate] = useState(today);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    agent.events().then(setList, (e: Error) => setError(e.message));
  }, []);

  async function change(run: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await run();
      window.location.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <div className="col gap-36">
      <div className="col gap-20">
        <div className="display fs-36">New event</div>
        <div className="row gap-20">
          <input className="field fs-30" placeholder="Event name" value={name} maxLength={80}
            onChange={(e) => setName(e.target.value)} />
          <input className="field fs-30" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          <button type="button" className="btn primary sm" disabled={busy || !name.trim() || !date}
            onClick={() => change(() => agent.createEvent(name.trim(), date))}>
            Create and switch
          </button>
        </div>
      </div>
      {error && <div className="banner error fs-24">{error}</div>}
      <div className="col gap-20">
        <div className="display fs-36">Events</div>
        {!list ? (
          <div className="muted fs-24">Loading…</div>
        ) : (
          list.events.map((e) => (
            <div key={e.id} className="row between event-row">
              <div className="col gap-6">
                <div className="fs-30">{e.name}</div>
                <div className="muted fs-24">{e.date} · {e.photoCount} photo{e.photoCount === 1 ? "" : "s"}</div>
              </div>
              {e.id === list.activeId ? (
                <div className="pill">In use</div>
              ) : (
                <button type="button" className="btn outline sm" disabled={busy}
                  onClick={() => change(() => agent.activateEvent(e.id))}>
                  Switch
                </button>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
```

Before relying on `field`, `event-row`, `fs-30` and `gap-6`: check `kiosk/src/styles.css` with `grep -n "^\.field\|\.fs-30\|\.gap-6\|input" kiosk/src/styles.css`. Reuse the class the layout editor or Settings tab uses for text inputs if `field` doesn't exist; add only what is missing, in the operator section of `styles.css`:

```css
.event-row { padding: 20px 0; border-bottom: 2px solid var(--line); }
```

(and a `.field` rule matching the existing inputs' look, only if there is none).

- [ ] **Step 3: Add the tab to the operator panel**

In `kiosk/src/Operator.tsx`:
- `import EventsTab from "./EventsTab";`
- The tab state type becomes `"status" | "settings" | "camera" | "album" | "events"`.
- In the `seg` group, after the Album button:
  ```tsx
  <button type="button" className={tab === "events" ? "on" : ""} onClick={() => setTab("events")}>Events</button>
  ```
- In the tab switch, before the `SettingsTab` fallback: `) : tab === "events" ? ( <EventsTab /> `.

`kiosk/README.md`: the operator panel section says "four tabs"; make it five and describe Events in one sentence (list, switch, create; the kiosk reloads on the new event).

- [ ] **Step 4: Build and check in the browser**

Run: `npm run build --prefix kiosk`
Expected: build succeeds.

Then check it in the browser pane against a dev agent, or with `/health` and `/events` stubbed, at 1280×800: the tab shows the list with the active event marked, the "Create and switch" button stays disabled for a blank name, and an error from the agent shows in the banner. Take a screenshot for the PR.

- [ ] **Step 5: Commit**

```bash
git add kiosk
git commit -m "feat(kiosk): Events tab to switch events or start a new one"
```

---

## Deploy (after merge; not a task for the implementer)

1. `git pull` and `npm run build` in `C:\Users\User\Documents\booth-agent`; the user restarts the service. Check `C:\BoothAgent\data\events.json` (or the configured data dir) now exists with `gigsmore-launch-2026`, and `/health` is ok with `eventName`.
2. Back up `C:\BoothAgent\kiosk\.env.local`, then change its `VITE_DOWNLOAD_URL` to `...?event={eventId}&name={eventName}&id={captureId}` (keep any `p=`), and remove `VITE_EVENT_NAME` / `VITE_EVENT_DATE`.
3. Deploy the kiosk as in `kiosk/README.md`, then reload it.
