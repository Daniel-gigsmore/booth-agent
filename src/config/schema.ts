import { z } from "zod";

export const CaptureSourcePreferenceSchema = z.enum(["canon", "webcam"]);
export type CaptureSourcePreference = z.infer<typeof CaptureSourcePreferenceSchema>;

export const PrintSizeSchema = z.enum(["4x6", "2x6-strip"]);
export type PrintSize = z.infer<typeof PrintSizeSchema>;

export const BoothConfigSchema = z.object({
  agent: z.object({
    port: z.number().int().positive().default(7070),
    sharedSecret: z.string().min(8, "sharedSecret must be at least 8 characters"),
  }),
  capture: z.object({
    sourcePreference: CaptureSourcePreferenceSchema.default("canon"),
    canon: z.object({
      digiCamControlExePath: z.string(),
      digiCamControlHttpPort: z.number().int().positive().default(5513),
      digiCamControlHttpHost: z.string().default("127.0.0.1"),
      sessionDir: z.string(),
      pollIntervalMs: z.number().int().positive().default(1000),
    }),
    webcam: z.object({
      ffmpegPath: z.string().default("ffmpeg"),
      deviceName: z.string(),
      captureWidth: z.number().int().positive().default(1920),
      captureHeight: z.number().int().positive().default(1080),
    }),
    fallbackThresholdMs: z.number().int().positive().default(3000),
  }),
  storage: z.object({
    dataDir: z.string(),
    outboxDbFileName: z.string().default("outbox.db"),
    // ~300 guests x (2 originals + 1 composite) is roughly 6GB per event, so
    // the default leaves room for a full event after the warning fires.
    lowDiskWarnBytes: z.number().int().positive().default(10 * 1024 ** 3),
  }),
  printing: z.object({
    hotFolderPath: z.string(),
    defaultSize: PrintSizeSchema.default("4x6"),
    secondsPerPrint: z.number().positive().default(12.4),
    // Hot Folder Print writes its own status file to Logs\\printer_status.txt
    // alongside the Prints folder. Derived from hotFolderPath when unset -
    // only set this if a future HFP version moves it.
    printerStatusPath: z.string().optional(),
    // A killed HotFolderPrint.exe leaves its last STATUS_OK on disk forever,
    // so status older than this is treated as unknown rather than as good
    // news. Confirm HFP's real write cadence on the booth PC and tune.
    printerStatusStaleMs: z.number().int().positive().default(120000),
    // Prints left on the roll before the operator is told to fetch a spare.
    lowMediaWarnPrints: z.number().int().nonnegative().default(30),
  }),
  compositing: z.object({
    templateDir: z.string(),
    jpegQuality: z.number().int().min(1).max(100).default(92),
    dpi: z.number().int().positive().default(300),
  }),
  supabase: z.object({
    url: z.string().url(),
    // booth-agent is a trusted local service on hardware Daniel controls,
    // not a browser client - it uses the service_role key (bypasses RLS)
    // rather than anon. Only the guest-facing web app should ever hold an
    // anon key. See supabase/migrations/20260814000000_captures.sql for the
    // RLS policies that assume this split.
    serviceRoleKey: z.string(),
    storageBucket: z.string().default("captures"),
  }),
  event: z.object({
    id: z.string(),
  }),
  sync: z.object({
    // Backlog size that turns into a /health warning. Being offline is an
    // expected, survivable state, so this is a nudge to check the network -
    // never an error.
    backlogWarnCount: z.number().int().positive().default(50),
    initialBackoffMs: z.number().int().positive().default(2000),
    maxBackoffMs: z.number().int().positive().default(120000),
    backoffMultiplier: z.number().positive().default(2),
    batchSize: z.number().int().positive().default(5),
  }),
});

export type BoothConfig = z.infer<typeof BoothConfigSchema>;
