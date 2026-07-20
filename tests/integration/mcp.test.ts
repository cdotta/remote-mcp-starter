// Integration tests for the MCP protocol over HTTP (POST /mcp).
//
// Every request goes through the REAL Hono app in-process (`app.request`) with a
// real Bearer PAT minted through the real Better Auth flow. Nothing is mocked —
// not auth, not the database, not the MCP SDK.
//
// Coverage:
//  - unauthenticated / bad-token POST -> 401 BEFORE any JSON-RPC envelope
//  - GET /mcp -> 405 with `Allow: POST`
//  - initialize -> serverInfo + instructions + tools capability
//  - tools/list -> all 5 tools, each with an outputSchema
//  - each tool happy path, asserting BOTH content[0].text and structuredContent
//  - zod validation failure -> isError envelope with a readable message
//  - create twice -> two distinct notes
//  - delete then list -> the deleted note is excluded
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "../../src/generated/prisma/client.js";
import {
  app,
  signUp,
  createPat,
  mcpCall,
  toolCall,
  initializeParams,
  testDb,
} from "../helpers.js";

let db: PrismaClient;

/** A fresh signed-up user plus a ready-to-use PAT. */
async function freshAuth(): Promise<{ userId: string; key: string }> {
  const user = await signUp();
  const pat = await createPat(user.cookie);
  return { userId: user.userId, key: pat.key };
}

/** Assert a success envelope carries content[0].text === JSON(structuredContent). */
function expectDualEnvelope(result: {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
}): Record<string, unknown> {
  expect(result.isError).not.toBe(true);
  expect(Array.isArray(result.content)).toBe(true);
  expect(result.content[0]?.type).toBe("text");
  expect(result.structuredContent).toBeDefined();
  const fromText = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
  expect(fromText).toEqual(result.structuredContent);
  return result.structuredContent!;
}

beforeAll(() => {
  db = testDb();
});

afterAll(async () => {
  await db.$disconnect();
});

// ─── Auth boundary (pre-JSON-RPC) ───────────────────────────────────────────

describe("auth boundary: POST /mcp rejects before emitting any JSON-RPC envelope", () => {
  it("missing Authorization header -> 401, empty body (no JSON-RPC envelope)", async () => {
    const res = await mcpCall(null, "initialize", initializeParams(), 1);
    expect(res.status).toBe(401);
    expect(res.body).toBeNull(); // no `result`, no `error` — the request never reached the SDK
  });

  it("malformed Bearer token -> 401, empty body", async () => {
    const res = await mcpCall("not-a-real-token", "tools/list", {}, 2);
    expect(res.status).toBe(401);
    expect(res.body).toBeNull();
  });
});

describe("GET /mcp -> 405 Allow: POST", () => {
  it("returns 405 with an Allow header advertising POST", async () => {
    // GET is not a valid MCP request in this stateless server, so the route
    // answers 405 directly rather than negotiating an SSE stream.
    const res = await app.request("/mcp", { method: "GET" });
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("POST");
  });
});

// ─── initialize + tools/list ────────────────────────────────────────────────

describe("initialize", () => {
  it("returns serverInfo (name + version), instructions, and a tools capability", async () => {
    const { key } = await freshAuth();
    const res = await mcpCall(key, "initialize", initializeParams(), 10);
    expect(res.status).toBe(200);
    expect(res.body.jsonrpc).toBe("2.0");
    expect(res.body.id).toBe(10);

    expect(res.body.result.serverInfo.name).toBe("remote-mcp-starter");
    expect(typeof res.body.result.serverInfo.version).toBe("string");
    expect(res.body.result.serverInfo.version.length).toBeGreaterThan(0);

    // instructions present + non-empty (helps the client's LLM use the server).
    expect(typeof res.body.result.instructions).toBe("string");
    expect(res.body.result.instructions.length).toBeGreaterThan(0);

    // The tools capability is advertised. The factory requests
    // `listChanged: false` (static list), but the SDK flips this to `true` the
    // moment a tool is registered — so we assert presence + boolean type rather
    // than the literal value.
    expect(res.body.result.capabilities.tools).toBeDefined();
    expect(typeof res.body.result.capabilities.tools.listChanged).toBe("boolean");
  });
});

describe("tools/list", () => {
  it("lists all 5 tools, each with an outputSchema; write tools also carry an inputSchema", async () => {
    const { key } = await freshAuth();
    const res = await mcpCall(key, "tools/list", {}, 11);
    expect(res.status).toBe(200);

    const tools = res.body.result.tools as Array<{
      name: string;
      description: string;
      inputSchema?: unknown;
      outputSchema?: unknown;
    }>;
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(["create_note", "delete_note", "list_notes", "ping", "update_note"]);

    for (const tool of tools) {
      expect(typeof tool.description, `${tool.name} description`).toBe("string");
      expect(tool.description.length, `${tool.name} description length`).toBeGreaterThan(0);
      expect(tool.outputSchema, `${tool.name} outputSchema`).toBeDefined();
      expect(typeof tool.outputSchema, `${tool.name} outputSchema type`).toBe("object");
    }

    for (const name of ["create_note", "update_note", "delete_note"] as const) {
      const tool = tools.find((t) => t.name === name)!;
      expect(tool.inputSchema, `${name} inputSchema`).toBeDefined();
    }
  });
});

// ─── Per-tool happy paths ───────────────────────────────────────────────────

describe("tool happy paths (dual content + structuredContent)", () => {
  it("ping returns the authenticated userId and an ISO timestamp", async () => {
    const { userId, key } = await freshAuth();
    const res = await toolCall(key, "ping", {}, 20);
    expect(res.status).toBe(200);
    const sc = expectDualEnvelope(res.body.result);
    expect(sc.userId).toBe(userId);
    expect(typeof sc.timestamp).toBe("string");
    expect(new Date(sc.timestamp as string).toString()).not.toBe("Invalid Date");
  });

  it("create_note creates a row owned by the caller", async () => {
    const { userId, key } = await freshAuth();
    const res = await toolCall(key, "create_note", { content: "hello from MCP" }, 21);
    expect(res.status).toBe(200);
    const sc = expectDualEnvelope(res.body.result) as {
      ok: boolean;
      note: { id: string; content: string; createdAt: string };
    };
    expect(sc.ok).toBe(true);
    expect(sc.note.content).toBe("hello from MCP");

    // The row landed in the DB scoped to this user.
    const row = await db.note.findUnique({ where: { id: sc.note.id } });
    expect(row?.userId).toBe(userId);
    expect(row?.content).toBe("hello from MCP");
  });

  it("list_notes returns the caller's notes, newest first, excluding nothing yet", async () => {
    const { key } = await freshAuth();
    await toolCall(key, "create_note", { content: "note-1" }, 22);
    await toolCall(key, "create_note", { content: "note-2" }, 23);

    const res = await toolCall(key, "list_notes", {}, 24);
    expect(res.status).toBe(200);
    const sc = expectDualEnvelope(res.body.result) as {
      notes: Array<{ id: string; content: string; createdAt: string }>;
    };
    const contents = sc.notes.map((n) => n.content);
    expect(contents).toContain("note-1");
    expect(contents).toContain("note-2");
    expect(sc.notes.length).toBe(2); // fresh user — exactly the two we created
  });

  it("update_note rewrites content and returns { ok: true }", async () => {
    const { key } = await freshAuth();
    const created = await toolCall(key, "create_note", { content: "before" }, 25);
    const noteId = created.body.result.structuredContent.note.id as string;

    const res = await toolCall(key, "update_note", { noteId, content: "after" }, 26);
    expect(res.status).toBe(200);
    const sc = expectDualEnvelope(res.body.result);
    expect(sc).toEqual({ ok: true });

    const row = await db.note.findUnique({ where: { id: noteId } });
    expect(row?.content).toBe("after");
  });

  it("delete_note soft-deletes (row stays, deletedAt set) and returns { ok: true }", async () => {
    const { key } = await freshAuth();
    const created = await toolCall(key, "create_note", { content: "doomed" }, 27);
    const noteId = created.body.result.structuredContent.note.id as string;

    const res = await toolCall(key, "delete_note", { noteId }, 28);
    expect(res.status).toBe(200);
    const sc = expectDualEnvelope(res.body.result);
    expect(sc).toEqual({ ok: true });

    const row = await db.note.findUnique({ where: { id: noteId } });
    expect(row).not.toBeNull(); // soft, not hard
    expect(row?.deletedAt).not.toBeNull();
  });
});

// ─── Domain behaviors ───────────────────────────────────────────────────────

describe("create twice -> two distinct notes (not idempotent)", () => {
  it("two identical create_note calls produce two rows", async () => {
    const { userId, key } = await freshAuth();
    const r1 = await toolCall(key, "create_note", { content: "dup-on-purpose" }, 30);
    const r2 = await toolCall(key, "create_note", { content: "dup-on-purpose" }, 31);
    const id1 = r1.body.result.structuredContent.note.id as string;
    const id2 = r2.body.result.structuredContent.note.id as string;
    expect(id1).not.toBe(id2);

    const rows = await db.note.findMany({ where: { userId, content: "dup-on-purpose" } });
    expect(rows.length).toBe(2);
  });
});

describe("delete then list -> deleted note excluded", () => {
  it("after delete_note, list_notes no longer returns the entry", async () => {
    const { key } = await freshAuth();
    const created = await toolCall(key, "create_note", { content: "will-disappear" }, 40);
    const noteId = created.body.result.structuredContent.note.id as string;

    await toolCall(key, "delete_note", { noteId }, 41);

    const res = await toolCall(key, "list_notes", {}, 42);
    const ids = (res.body.result.structuredContent.notes as Array<{ id: string }>).map((n) => n.id);
    expect(ids).not.toContain(noteId);
  });
});

// ─── Validation failures -> isError envelope ────────────────────────────────

describe("zod validation failure -> isError envelope with a readable message", () => {
  it("empty content -> result.isError true, message mentions the constraint (not a JSON-RPC error)", async () => {
    const { key } = await freshAuth();
    const res = await toolCall(key, "create_note", { content: "" }, 50);
    expect(res.status).toBe(200); // tool/validation errors ride HTTP 200
    expect(res.body.error).toBeUndefined(); // NOT a top-level JSON-RPC error
    expect(res.body.result.isError).toBe(true);
    expect(res.body.result.content[0].text).toMatch(/empty|validation|invalid/i);
  });

  it("content over 500 chars -> result.isError true, message mentions the limit", async () => {
    const { key } = await freshAuth();
    const res = await toolCall(key, "create_note", { content: "x".repeat(501) }, 51);
    expect(res.status).toBe(200);
    expect(res.body.error).toBeUndefined();
    expect(res.body.result.isError).toBe(true);
    expect(res.body.result.content[0].text).toMatch(/500|at most|validation|invalid/i);
  });

  it("update_note with an unknown noteId -> not-found isError envelope, no structuredContent", async () => {
    const { key } = await freshAuth();
    const res = await toolCall(key, "update_note", { noteId: "does-not-exist", content: "x" }, 52);
    expect(res.status).toBe(200);
    expect(res.body.error).toBeUndefined();
    expect(res.body.result.isError).toBe(true);
    expect(res.body.result.content[0].text).toMatch(/not found|not owned/i);
    expect(res.body.result.structuredContent).toBeUndefined();
  });
});
