// Integration tests for the PAT (Personal Access Token) lifecycle.
//
// Exercises the real Better Auth apiKey flow end-to-end: create returns the raw
// key exactly once, the key verifies as a Bearer PAT on POST /mcp, revoking it
// kills access, and the key is stored hashed at rest (the raw value never
// appears in the DB row).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "../../src/generated/prisma/client.js";
import {
  signUp,
  createPat,
  mcpCall,
  toolCall,
  deleteToken,
  listTokens,
  testDb,
} from "../helpers.js";

let db: PrismaClient;

beforeAll(() => {
  db = testDb();
});

afterAll(async () => {
  await db.$disconnect();
});

describe("PAT lifecycle: create -> verify -> revoke -> denied", () => {
  it("create returns a raw key that works, revoke then kills MCP access with 401", async () => {
    const user = await signUp();
    const pat = await createPat(user.cookie, "lifecycle-token");

    // create returns the raw key (once) plus a trimmed metadata shape.
    expect(typeof pat.key).toBe("string");
    expect(pat.key.length).toBeGreaterThan(0);
    expect(typeof pat.id).toBe("string");
    expect(pat.name).toBe("lifecycle-token");

    // The key verifies: ping resolves to this user's id.
    const before = await toolCall(pat.key, "ping", {}, 1);
    expect(before.status).toBe(200);
    expect(before.body.result.structuredContent.userId).toBe(user.userId);

    // Revoke via the session-guarded REST endpoint.
    const revoke = await deleteToken(user.cookie, pat.id);
    expect(revoke.status).toBe(200);
    expect(revoke.body.ok).toBe(true);

    // The row is gone (Better Auth deleteApiKey is a hard delete).
    const row = await db.apikey.findUnique({ where: { id: pat.id } });
    expect(row).toBeNull();

    // The revoked key no longer authenticates: 401 BEFORE any JSON-RPC envelope.
    const after = await mcpCall(pat.key, "tools/list", {}, 2);
    expect(after.status).toBe(401);
    expect(after.body).toBeNull();
  });
});

describe("PAT hashed at rest (PAT never stored in plaintext)", () => {
  it("the apikey row's key column does not equal the raw token", async () => {
    const user = await signUp();
    const pat = await createPat(user.cookie, "hash-check");

    const row = await db.apikey.findUnique({ where: { id: pat.id } });
    expect(row).not.toBeNull();
    // Hashed at rest: the stored value differs from the raw key and never
    // contains it as a substring.
    expect(row!.key).not.toBe(pat.key);
    expect(row!.key.includes(pat.key)).toBe(false);
    expect(row!.key.length).toBeGreaterThan(0);
    // The owner is recorded under referenceId (Better Auth 1.5+ rename).
    expect(row!.referenceId).toBe(user.userId);
  });
});

describe("PAT verification negative cases -> 401 before JSON-RPC", () => {
  const cases: Array<[string, string | null]> = [
    ["missing Authorization header", null],
    ["random non-key token", "totally-bogus"],
    ["empty-ish token", " "],
  ];
  for (const [label, token] of cases) {
    it(`rejects ${label} with 401 and no envelope`, async () => {
      const res = await mcpCall(token, "tools/list", {}, 1);
      expect(res.status, label).toBe(401);
      expect(res.body, label).toBeNull();
    });
  }
});

describe("create returns the raw key exactly once (not re-derivable from list)", () => {
  it("the raw key is absent from the token-list endpoint output", async () => {
    const user = await signUp();
    const pat = await createPat(user.cookie, "once-only");

    // Read the list through the session REST endpoint and confirm the raw key
    // never appears anywhere in the serialized response — it is returned only
    // at creation time.
    const res = await listTokens(user.cookie);
    expect(res.status).toBe(200);
    const serialized = JSON.stringify(res.body);
    expect(serialized.includes(pat.key)).toBe(false);
  });
});
