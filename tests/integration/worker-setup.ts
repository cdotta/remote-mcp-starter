import { readFileSync } from "node:fs";
import { DB_CONFIG_PATH, type DbConfig } from "./schema-config.js";

// Per-worker setup (vitest `setupFiles`). Runs in every test worker BEFORE the
// test file (and therefore before the app's lazy Prisma singleton runs its first
// query). It loads the ephemeral-schema connection info that globalSetup wrote
// and installs it into this worker's process.env, so the app, Better Auth, and
// the direct assertion client all target the throwaway schema.
let cfg: DbConfig;
try {
  cfg = JSON.parse(readFileSync(DB_CONFIG_PATH, "utf-8")) as DbConfig;
} catch (e) {
  throw new Error(
    `worker setup could not read test DB config from ${DB_CONFIG_PATH} ` +
      `(did globalSetup run?): ${(e as Error).message}`,
  );
}

process.env.DATABASE_URL = cfg.databaseUrl;
process.env.TEST_DB_BASE_URL = cfg.base;
process.env.TEST_DB_SCHEMA = cfg.schema;
