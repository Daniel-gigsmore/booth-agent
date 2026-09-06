import { readdirSync } from "node:fs";

export function parseDbUrlArg(argv: readonly string[]): string | undefined {
  const eq = argv.find((a) => a.startsWith("--db-url="));
  if (eq) return eq.slice("--db-url=".length);

  const idx = argv.indexOf("--db-url");
  if (idx !== -1 && argv[idx + 1] !== undefined) return argv[idx + 1];

  return undefined;
}

export function listMigrationFiles(dir: string): string[] {
  // Filenames are timestamp-prefixed (20260814000000_captures.sql), so a
  // plain lexicographic sort is also chronological order.
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

export function selectPending(all: readonly string[], applied: readonly string[]): string[] {
  const appliedSet = new Set(applied);
  return all.filter((f) => !appliedSet.has(f));
}
