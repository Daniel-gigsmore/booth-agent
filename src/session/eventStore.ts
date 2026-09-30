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
  name?: string | undefined;
  albumToken?: string | undefined;
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
      // PowerShell 5.1 writes a BOM when an operator hand-edits the file.
      const text = readFileSync(filePath, "utf-8").replace(/^﻿/, "");
      return new EventStore(filePath, EventsFileSchema.parse(JSON.parse(text)), null);
    } catch (err) {
      // Never echo the file's own text (a JSON error quotes it, and it holds album tokens).
      const message =
        err instanceof SyntaxError
          ? "not valid JSON"
          : err instanceof z.ZodError
            ? err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")
            : err instanceof Error
              ? err.message
              : String(err);
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
