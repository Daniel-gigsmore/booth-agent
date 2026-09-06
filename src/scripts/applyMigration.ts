import { readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { listMigrationFiles, parseDbUrlArg, selectPending } from "./migrationRunner";

const MIGRATIONS_DIR = path.join(__dirname, "..", "..", "supabase", "migrations");
const BOOKKEEPING_TABLE = "public._booth_agent_migrations";

async function main(): Promise<void> {
  const dbUrl = parseDbUrlArg(process.argv.slice(2)) ?? process.env["SUPABASE_DB_URL"];
  if (!dbUrl) {
    console.error(
      "Usage: npm run db:migrate -- --db-url <postgres-connection-string>\n" +
        "(or set SUPABASE_DB_URL). Find the connection string under the\n" +
        "target Supabase project's Settings -> Database -> Connection string (URI)."
    );
    process.exitCode = 1;
    return;
  }

  const allFiles = listMigrationFiles(MIGRATIONS_DIR);
  if (allFiles.length === 0) {
    console.log(`No migration files found in ${MIGRATIONS_DIR}`);
    return;
  }

  // Matches Supabase's own documented node-postgres connection example:
  // the connection is still TLS-encrypted, only certificate verification is
  // relaxed, which their cert chain needs from plain node-postgres.
  const client = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();

  try {
    await client.query(
      `create table if not exists ${BOOKKEEPING_TABLE} (
         filename text primary key,
         applied_at timestamptz not null default now()
       )`
    );

    const { rows } = await client.query<{ filename: string }>(
      `select filename from ${BOOKKEEPING_TABLE}`
    );
    const pending = selectPending(
      allFiles,
      rows.map((r) => r.filename)
    );

    if (pending.length === 0) {
      console.log("Nothing to apply - every migration is already recorded as applied.");
      return;
    }

    for (const filename of pending) {
      const sql = readFileSync(path.join(MIGRATIONS_DIR, filename), "utf8");
      console.log(`Applying ${filename}...`);
      await client.query("begin");
      try {
        await client.query(sql);
        await client.query(`insert into ${BOOKKEEPING_TABLE} (filename) values ($1)`, [filename]);
        await client.query("commit");
      } catch (err) {
        await client.query("rollback");
        throw new Error(`Failed applying ${filename}: ${(err as Error).message}`);
      }
    }

    console.log(`Done - applied ${pending.length} migration(s).`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
