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
  }),
  printing: z.object({
    hotFolderPath: z.string(),
    defaultSize: PrintSizeSchema.default("4x6"),
    secondsPerPrint: z.number().positive().default(12.4),
  }),
  compositing: z.object({
    templateDir: z.string(),
    jpegQuality: z.number().int().min(1).max(100).default(92),
    dpi: z.number().int().positive().default(300),
  }),
  supabase: z.object({
    url: z.string().url(),
    anonKey: z.string(),
    storageBucket: z.string().default("captures"),
  }),
  event: z.object({
    id: z.string(),
  }),
  sync: z.object({
    initialBackoffMs: z.number().int().positive().default(2000),
    maxBackoffMs: z.number().int().positive().default(120000),
    backoffMultiplier: z.number().positive().default(2),
    batchSize: z.number().int().positive().default(5),
  }),
});

export type BoothConfig = z.infer<typeof BoothConfigSchema>;
