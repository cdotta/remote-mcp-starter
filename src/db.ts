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

function getClient(): PrismaClient {
  cached ??=
    globalForPrisma.prisma ??
    new PrismaClient({
      adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
    });
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
