import { defineConfig } from "vitest/config";

// Integration-only test setup.
//
// `globalSetup` provisions a per-run ephemeral Postgres schema (see
// tests/integration/setup.ts) and rewrites DATABASE_URL to point at it BEFORE
// the test workers are forked — so the app's Prisma singleton, Better Auth, and
// the MCP stack all run against a throwaway schema and never touch dev data.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    globalSetup: ["./tests/integration/setup.ts"],
    // Runs in every worker BEFORE the test file — installs the ephemeral-schema
    // DATABASE_URL into the worker's env (globalSetup env mutations don't cross
    // the fork boundary reliably; a temp file does).
    setupFiles: ["./tests/integration/worker-setup.ts"],
    // The suites share one ephemeral schema and create their own users with
    // unique emails, so cross-file data collisions are impossible. A single fork
    // keeps the shared Postgres connection pool small and the log output linear.
    // (vitest 4 flattened pool options to the top level.)
    pool: "forks",
    maxWorkers: 1,
    fileParallelism: false,
    // Better Auth password hashing + real Postgres round-trips are slower than a
    // unit test; give each test room before timing out.
    testTimeout: 20000,
    hookTimeout: 30000,
  },
});
