// Integration tests for the token-management REST endpoints
// (POST/GET/DELETE /api/tokens). These are session-cookie guarded — they are how
// a signed-in browser user mints, lists, and revokes the PATs their MCP client
// uses. A PAT (Bearer) must NOT authenticate them; only a session cookie does.
//
// Coverage:
//  - session-less create/list/delete -> 401
//  - create returns the raw key; list never returns raw keys
//  - create with an invalid name -> 400
//  - delete removes the token from the list
//  - IDOR: user A cannot delete user B's token; B's token survives
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "../../src/generated/prisma/client.js";
import {
  app,
  signUp,
  createPat,
  postToken,
  listTokens,
  deleteToken,
  toolCall,
  testDb,
} from "../helpers.js";

let db: PrismaClient;

beforeAll(() => {
  db = testDb();
});

afterAll(async () => {
  await db.$disconnect();
});

describe("session guard: no session cookie -> 401", () => {
  it("POST /api/tokens without a session cookie -> 401", async () => {
    const res = await postToken(null, "no-session");
    expect(res.status).toBe(401);
  });

  it("GET /api/tokens without a session cookie -> 401", async () => {
    const res = await listTokens(null);
    expect(res.status).toBe(401);
  });

  it("DELETE /api/tokens/:id without a session cookie -> 401", async () => {
    const res = await deleteToken(null, "any-id");
    expect(res.status).toBe(401);
  });

  it("a PAT (Bearer) does not authenticate the session-guarded endpoints", async () => {
    // Mint a valid PAT, then try to use it as a Bearer against /api/tokens.
    const user = await signUp();
    const pat = await createPat(user.cookie, "bearer-probe");
    const res = await app.request("/api/tokens", {
      method: "GET",
      headers: { Authorization: `Bearer ${pat.key}` },
    });
    expect(res.status).toBe(401);
  });
});

describe("create -> raw key returned; list -> raw keys omitted", () => {
  it("POST returns { key, id, name, start, createdAt }; GET omits the raw key", async () => {
    const user = await signUp();

    const create = await postToken(user.cookie, "list-shape");
    expect(create.status).toBe(201);
    expect(typeof create.body.key).toBe("string");
    expect(create.body.key.length).toBeGreaterThan(0);
    expect(create.body.name).toBe("list-shape");
    const rawKey: string = create.body.key;

    const list = await listTokens(user.cookie);
    expect(list.status).toBe(200);
    expect(Array.isArray(list.body.tokens)).toBe(true);
    expect(list.body.tokens.length).toBeGreaterThan(0);

    for (const token of list.body.tokens as Array<Record<string, unknown>>) {
      // Trimmed shape only — no raw `key`, no `referenceId`.
      expect(Object.prototype.hasOwnProperty.call(token, "key")).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(token, "referenceId")).toBe(false);
      const keys = Object.keys(token).sort();
      expect(keys).toEqual(["createdAt", "id", "lastRequest", "name", "start"]);
    }
    // The raw key never appears anywhere in the serialized list.
    expect(JSON.stringify(list.body).includes(rawKey)).toBe(false);
  });
});

describe("create input validation", () => {
  it("missing/non-string name -> 400", async () => {
    const user = await signUp();
    const res = await postToken(user.cookie, 12345); // not a string
    expect(res.status).toBe(400);
    expect(typeof res.body.error).toBe("string");
  });

  it("empty name -> 400", async () => {
    const user = await signUp();
    const res = await postToken(user.cookie, "");
    expect(res.status).toBe(400);
  });

  it("whitespace-only name -> 400", async () => {
    const user = await signUp();
    const res = await postToken(user.cookie, "   ");
    expect(res.status).toBe(400);
  });
});

describe("delete removes the token from the list", () => {
  it("after DELETE, the token id is gone from GET /api/tokens", async () => {
    const user = await signUp();
    const create = await postToken(user.cookie, "to-delete");
    const id: string = create.body.id;

    const del = await deleteToken(user.cookie, id);
    expect(del.status).toBe(200);
    expect(del.body.ok).toBe(true);

    const list = await listTokens(user.cookie);
    const ids = (list.body.tokens as Array<{ id: string }>).map((t) => t.id);
    expect(ids).not.toContain(id);
  });

  it("deleting an unknown id -> 404 { ok: false } (no throw)", async () => {
    const user = await signUp();
    const res = await deleteToken(user.cookie, "nonexistent-id");
    expect(res.status).toBe(404);
    expect(res.body.ok).toBe(false);
  });
});

describe("IDOR: user A cannot revoke user B's token", () => {
  it("A's DELETE on B's token id -> 404 { ok: false }, and B's token still works", async () => {
    const userA = await signUp();
    const userB = await signUp();
    const bPat = await createPat(userB.cookie, "b-token-idor");

    // A (authenticated with A's session) tries to revoke B's token.
    const res = await deleteToken(userA.cookie, bPat.id);
    expect(res.status).toBe(404);
    expect(res.body.ok).toBe(false);

    // The row still exists and the token still authenticates as B.
    const row = await db.apikey.findUnique({ where: { id: bPat.id } });
    expect(row).not.toBeNull();
    const ping = await toolCall(bPat.key, "ping", {}, 1);
    expect(ping.status).toBe(200);
    expect(ping.body.result.structuredContent.userId).toBe(userB.userId);
  });
});
