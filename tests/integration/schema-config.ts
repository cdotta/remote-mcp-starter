import { tmpdir } from "node:os";
import { join } from "node:path";

// Where globalSetup writes the ephemeral-schema connection info so the per-worker
// setupFile can pick it up. A file (rather than process.env) is used because
// vitest does NOT reliably propagate env vars mutated in globalSetup into the
// forked test workers — the workers inherit an env snapshot taken before
// globalSetup ran. The file is the authoritative channel.
export const DB_CONFIG_PATH = join(tmpdir(), "remote-mcp-starter-test-db.json");

export interface DbConfig {
  /** Runtime URL for the app + tests: carries `?schema=<schema>`. */
  databaseUrl: string;
  /** Bare connection string (no query params) for the direct assertion client. */
  base: string;
  /** The ephemeral schema name, e.g. `mcp_test_12345`. */
  schema: string;
}
