import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Brings an existing booth.config.json up to what this version of the booth
 * installer sets up, so upgrading a booth needs no hand edits. Run by the
 * installer (with the bundled node.exe) before the service starts:
 *
 *   node dist/service/migrateConfig.js <path to booth.config.json>
 *
 * Only adds what is missing; never changes a value the operator set. The file
 * is backed up next to itself before it is rewritten.
 */

export const KIOSK_ORIGIN = "http://127.0.0.1:4173";
export const DEFAULT_EDSDK_DLL = "C:\\BoothAgent\\edsdk\\EDSDK.dll";

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : undefined);

export interface MigrateOptions {
  /** Whether a file exists; injectable for tests. */
  fileExists?: (p: string) => boolean;
}

/** Returns the migrated config (a copy) and a line per change; no changes means nothing to write. */
export function migrateConfig(input: Json, opts: MigrateOptions = {}): { config: Json; changes: string[] } {
  const fileExists = opts.fileExists ?? existsSync;
  const config = JSON.parse(JSON.stringify(input)) as Json;
  const changes: string[] = [];

  // The kiosk app is served from this origin; without it every kiosk call fails CORS.
  const agent = obj(config["agent"]);
  if (agent) {
    const origins = Array.isArray(agent["allowedOrigins"]) ? (agent["allowedOrigins"] as unknown[]) : [];
    if (!origins.includes(KIOSK_ORIGIN)) {
      agent["allowedOrigins"] = [...origins, KIOSK_ORIGIN];
      changes.push(`agent.allowedOrigins: added ${KIOSK_ORIGIN}`);
    }
  }

  // The installer ships Canon's EDSDK; a config from before it still defaults to digiCamControl.
  const canon = obj(obj(config["capture"])?.["canon"]);
  if (canon && canon["driver"] === undefined) {
    const dll = typeof canon["edsdkDllPath"] === "string" ? (canon["edsdkDllPath"] as string) : DEFAULT_EDSDK_DLL;
    if (fileExists(dll)) {
      canon["driver"] = "edsdk";
      changes.push(`capture.canon.driver: set to "edsdk" (${dll} is installed)`);
    }
  }

  // Where the kiosk app reads the guest download link from.
  if (!obj(config["kiosk"])) {
    config["kiosk"] = { downloadUrl: "" };
    changes.push("kiosk.downloadUrl: added (empty - set it to show the guest QR code)");
  }

  return { config, changes };
}

function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Migrates the file in place (with a backup). Returns the changes made. */
export function migrateConfigFile(file: string, opts: MigrateOptions = {}): string[] {
  const text = readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  const { config, changes } = migrateConfig(JSON.parse(text) as Json, opts);
  if (changes.length === 0) return changes;
  const backup = path.join(path.dirname(file), `${path.basename(file)}.bak-${stamp()}`);
  copyFileSync(file, backup);
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return [...changes, `backup: ${backup}`];
}

if (require.main === module) {
  const file = process.argv[2] ?? path.join(__dirname, "..", "..", "booth.config.json");
  try {
    const changes = migrateConfigFile(file);
    console.log(changes.length ? `Updated ${file}:\n  ${changes.join("\n  ")}` : `${file} is up to date.`);
  } catch (err) {
    // Never fail the install over this: the service still starts and preflight reports what's wrong.
    console.error(`Could not update ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
