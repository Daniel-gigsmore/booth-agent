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
