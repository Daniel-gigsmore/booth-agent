import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { listMigrationFiles, parseDbUrlArg, selectPending } from "../src/scripts/migrationRunner";

describe("parseDbUrlArg", () => {
  it("reads --db-url <value>", () => {
    expect(parseDbUrlArg(["--db-url", "postgres://x"])).toBe("postgres://x");
  });

  it("reads --db-url=<value>", () => {
    expect(parseDbUrlArg(["--db-url=postgres://x"])).toBe("postgres://x");
  });

  it("returns undefined when not present", () => {
    expect(parseDbUrlArg(["--other", "flag"])).toBeUndefined();
  });

  it("returns undefined when --db-url is the last argument with no value", () => {
    expect(parseDbUrlArg(["--db-url"])).toBeUndefined();
  });
});

describe("selectPending", () => {
  it("drops filenames already recorded as applied", () => {
    const all = ["20260101_a.sql", "20260102_b.sql", "20260103_c.sql"];
    expect(selectPending(all, ["20260101_a.sql"])).toEqual(["20260102_b.sql", "20260103_c.sql"]);
  });

  it("returns everything when nothing has been applied yet", () => {
    const all = ["20260101_a.sql"];
    expect(selectPending(all, [])).toEqual(all);
  });

  it("returns nothing when everything is already applied", () => {
    const all = ["20260101_a.sql"];
    expect(selectPending(all, all)).toEqual([]);
  });
});

describe("listMigrationFiles", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "booth-migrations-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("lists only .sql files in chronological (lexicographic) order", () => {
    writeFileSync(path.join(dir, "20260102_b.sql"), "-- b");
    writeFileSync(path.join(dir, "20260101_a.sql"), "-- a");
    writeFileSync(path.join(dir, "README.md"), "not a migration");

    expect(listMigrationFiles(dir)).toEqual(["20260101_a.sql", "20260102_b.sql"]);
  });
});
