import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { createLogger } from "../util/logger";
import type { PrintAlignment } from "./printAlignment";

const log = createLogger("print:alignment");

const AlignmentSchema = z.object({
  scale: z.number().min(50).max(100).default(100),
  offsetX: z.number().int().min(-200).max(200).default(0),
  offsetY: z.number().int().min(-200).max(200).default(0),
});

const DEFAULT: PrintAlignment = { scale: 100, offsetX: 0, offsetY: 0 };

export class AlignmentStore {
  private filePath: string;
  private value: PrintAlignment;

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, "print-alignment.json");
    this.value = this.load();
  }

  get current(): PrintAlignment {
    return this.value;
  }

  update(partial: Partial<PrintAlignment>): PrintAlignment {
    const merged = AlignmentSchema.parse({ ...this.value, ...partial });
    this.value = merged;
    writeFileSync(this.filePath, JSON.stringify(merged, null, 2));
    log.info(`Print alignment updated: ${JSON.stringify(merged)}`);
    return merged;
  }

  private load(): PrintAlignment {
    try {
      const raw = readFileSync(this.filePath, "utf-8");
      return AlignmentSchema.parse(JSON.parse(raw));
    } catch {
      return DEFAULT;
    }
  }
}
