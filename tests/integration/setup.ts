import { execSync } from "node:child_process";
import { writeFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../src/generated/prisma/client.js";
import { DB_CONFIG_PATH, type DbConfig } from "./schema-config.js";

// ─── Ephemeral-schema lifecycle (vitest globalSetup) ────────────────────────
//
// Every `pnpm test` run gets its OWN throwaway Postgres schema (`mcp_test_<pid>`)
// inside the docker-compose database. We create it, push the Prisma schema into
// it, and drop it on teardown — so tests never read or clobber the developer's
// `public` schema. The only manual prep is `docker compose up -d`.
//
// WHY the two different URL shapes below:
// The app (src/db.ts) reads `?schema=` from DATABASE_URL and passes it to the
// @prisma/adapter-pg `{ schema }` option, so pointing DATABASE_URL at
// `...?schema=mcp_test_<pid>` is enough to redirect the app's Prisma singleton,
// Better Auth, and the MCP stack at the throwaway schema. `prisma db push` reads
// the same param and creates the tables there.
//
// globalSetup runs in the main process, but vitest does NOT reliably propagate
// env mutations into the forked test workers — so the connection info is written
// to a temp file that tests/integration/worker-setup.ts loads into each worker.

// Load DATABASE_URL, BETTER_AUTH_SECRET, BETTER_AUTH_URL from .env before reading
// or mutating any of them.
loadEnv({ path: fileURLToPath(new URL("../../.env", import.meta.url)) });

const SCHEMA = `mcp_test_${process.pid}`;

/** The connection string with any query params stripped. */
function baseConnectionString(): string {
  const url = process.env.TEST_DB_BASE_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL missing — cannot run integration setup");
  const q = url.indexOf("?");
  return q === -1 ? url : url.slice(0, q);
}

/** Run a single admin statement (CREATE/DROP SCHEMA) on the base connection. */
async function adminExec(base: string, sql: string): Promise<void> {
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: base }) });
  try {
    await prisma.$executeRawUnsafe(sql);
  } finally {
    await prisma.$disconnect();
  }
}

export async function setup(): Promise<void> {
  const base = baseConnectionString();

  // Drop a schema left behind by a previously SIGKILL-ed run, then recreate fresh.
  await adminExec(base, `DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
  await adminExec(base, `CREATE SCHEMA "${SCHEMA}"`);

  // Materialize the Prisma schema into the throwaway schema. The Prisma CLI reads
  // DATABASE_URL from prisma.config.ts and understands the `?schema=` param.
  execSync("pnpm exec prisma db push", {
    env: { ...process.env, DATABASE_URL: `${base}?schema=${SCHEMA}` },
    stdio: "inherit",
  });

  // Publish the runtime connection info for the test workers via a temp file
  // (tests/integration/worker-setup.ts reads it). DATABASE_URL carries `?schema=`
  // so the app's Prisma singleton targets the ephemeral schema; base + schema let
  // the suites build a direct assertion client.
  const config: DbConfig = {
    databaseUrl: `${base}?schema=${SCHEMA}`,
    base,
    schema: SCHEMA,
  };
  writeFileSync(DB_CONFIG_PATH, JSON.stringify(config), "utf-8");
  // Also set it in the main process for good measure (harmless if not inherited).
  process.env.TEST_DB_BASE_URL = base;
  process.env.TEST_DB_SCHEMA = SCHEMA;
  process.env.DATABASE_URL = config.databaseUrl;
}

export async function teardown(): Promise<void> {
  const base = baseConnectionString();
  await adminExec(base, `DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
  rmSync(DB_CONFIG_PATH, { force: true });
}
