import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { app } from "../src/server.js";

// Shared helpers for the integration suites.
//
// Everything here drives the REAL stack in-process via Hono's `app.request(...)`:
// real Better Auth sign-up, real session cookies, real PATs, real JSON-RPC over
// POST /mcp. Nothing is mocked. A `testDb()` client bound to the ephemeral schema
// is provided for row-level assertions (e.g. "the raw key is not stored").

export { app };

export interface TestUser {
  userId: string;
  cookie: string;
  email: string;
}

export interface CreatedPat {
  key: string;
  id: string;
  name: string;
  start: string;
  createdAt: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = any;

let emailCounter = 0;

/** Pull the `better-auth.session_token` cookie out of a response's Set-Cookie. */
export function extractSessionCookie(res: Response): string {
  const setCookie = res.headers.get("set-cookie") ?? "";
  const m = setCookie.match(/better-auth\.session_token=[^;]+/);
  return m?.[0] ?? "";
}

/** Sign up a brand-new user via the real Better Auth endpoint; returns the id + session cookie. */
export async function signUp(): Promise<TestUser> {
  const email = `user-${process.pid}-${Date.now()}-${emailCounter++}@test.local`;
  const res = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Test User", email, password: "password12345" }),
  });
  if (res.status !== 200) {
    throw new Error(`sign-up failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { user: { id: string } };
  const cookie = extractSessionCookie(res);
  if (!cookie) throw new Error("sign-up did not set a session cookie");
  return { userId: body.user.id, cookie, email };
}

/** Mint a PAT for a signed-in user (session cookie) via POST /api/tokens. */
export async function createPat(cookie: string, name = "test-pat"): Promise<CreatedPat> {
  const res = await app.request("/api/tokens", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ name }),
  });
  if (res.status !== 201) {
    throw new Error(`createPat failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as CreatedPat;
}

export interface HttpResult {
  status: number;
  body: Json;
}

/** GET /api/tokens (session-guarded). */
export async function listTokens(cookie: string | null): Promise<HttpResult> {
  const headers: Record<string, string> = {};
  if (cookie) headers.Cookie = cookie;
  const res = await app.request("/api/tokens", { method: "GET", headers });
  return { status: res.status, body: await readJson(res) };
}

/** POST /api/tokens (session-guarded). Returns status + parsed body (does not throw). */
export async function postToken(cookie: string | null, name: unknown): Promise<HttpResult> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cookie) headers.Cookie = cookie;
  const res = await app.request("/api/tokens", {
    method: "POST",
    headers,
    body: JSON.stringify({ name }),
  });
  return { status: res.status, body: await readJson(res) };
}

/** DELETE /api/tokens/:id (session-guarded). */
export async function deleteToken(cookie: string | null, id: string): Promise<HttpResult> {
  const headers: Record<string, string> = {};
  if (cookie) headers.Cookie = cookie;
  const res = await app.request(`/api/tokens/${id}`, { method: "DELETE", headers });
  return { status: res.status, body: await readJson(res) };
}

/**
 * JSON-RPC helper. Sends `{ jsonrpc, id, method, params }` to POST /mcp with a
 * Bearer PAT (or none, to exercise the 401 path) and unwraps the single JSON
 * response body produced by the transport's `enableJsonResponse` mode. The 401
 * path returns an EMPTY body — `body` is null there, so callers can assert that
 * no JSON-RPC envelope was emitted before auth.
 */
export async function mcpCall(
  token: string | null,
  method: string,
  params: unknown = {},
  id = 1,
): Promise<HttpResult> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    // The Streamable HTTP transport requires the client to accept both JSON and
    // SSE on POST, even though enableJsonResponse means it always answers JSON.
    Accept: "application/json, text/event-stream",
  };
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  const res = await app.request("/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  return { status: res.status, body: await readJson(res) };
}

/** Convenience wrapper for a `tools/call` JSON-RPC request. */
export function toolCall(
  token: string,
  name: string,
  args: Record<string, unknown>,
  id = 1,
): Promise<HttpResult> {
  return mcpCall(token, "tools/call", { name, arguments: args }, id);
}

/** The standard MCP `initialize` params. */
export function initializeParams(): Record<string, unknown> {
  return {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "mcp-test", version: "0.0.1" },
  };
}

async function readJson(res: Response): Promise<Json> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as Json;
  } catch {
    return text;
  }
}

/**
 * Direct Prisma client bound to the ephemeral test schema for row-level
 * assertions (e.g. reading the hashed `apikey.key`). Separate from the app's
 * singleton on purpose: an independent connection proves the app's writes really
 * landed in Postgres. Remember to `$disconnect()` in afterAll.
 */
export function testDb(): PrismaClient {
  const base = process.env.TEST_DB_BASE_URL;
  const schema = process.env.TEST_DB_SCHEMA;
  if (!base || !schema) {
    throw new Error("TEST_DB_* env not set — globalSetup did not run");
  }
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: base }, { schema }) });
}
