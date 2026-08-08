import path from "node:path";
import { BoothConfig } from "../config/schema";

export function originalsDir(config: BoothConfig): string {
  return path.join(config.storage.dataDir, "originals");
}

export function compositesDir(config: BoothConfig): string {
  return path.join(config.storage.dataDir, "composites");
}

export function aiDownloadsDir(config: BoothConfig): string {
  return path.join(config.storage.dataDir, "ai-downloads");
}
