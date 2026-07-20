import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client.js";

// Lazy Prisma client.
//
// The adapter (and therefore the DATABASE_URL requirement) is only built on the
// first actual query, not when this module is imported. This keeps importing
// the app cheap in contexts that never touch the database (e.g. tooling, tests
// that stub the DB) and avoids constructing multiple pools during dev reloads.

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

let cached: PrismaClient | undefined;

// Extract Prisma's `?schema=` query param from the connection string. The
// @prisma/adapter-pg driver adapter does NOT read this param itself — and,
// crucially, Prisma fully-qualifies every table name with a schema, defaulting to
// `public` when none is provided. So to target any non-public schema (production
// override, or an ephemeral test schema like `mcp_test_<pid>`) the name must be
// passed explicitly as the adapter's `{ schema }` option. Passing `public` is a
// no-op vs. the default, so this is transparent for the normal case.
function schemaFromUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const query = url.split("?")[1];
  if (!query) return undefined;
  return new URLSearchParams(query).get("schema") ?? undefined;
}

function getClient(): PrismaClient {
  cached ??=
    globalForPrisma.prisma ??
    (() => {
      const connectionString = process.env.DATABASE_URL;
      const schema = schemaFromUrl(connectionString);
      const adapter = new PrismaPg(
        { connectionString },
        schema ? { schema } : undefined,
      );
      return new PrismaClient({ adapter });
    })();
  if (process.env.NODE_ENV !== "production") {
    globalForPrisma.prisma = cached;
  }
  return cached;
}

// A Proxy defers construction while preserving the full PrismaClient surface.
// Function properties are bound to the real client so `this`-dependent methods
// ($transaction, $extends, ...) behave identically to a direct instance.
export const prisma = new Proxy({} as PrismaClient, {
  get(_target, prop) {
    const client = getClient();
    const value = Reflect.get(client, prop);
    return typeof value === "function" ? value.bind(client) : value;
  },
});
