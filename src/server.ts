import "dotenv/config"; // load .env before anything reads process.env
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { auth, verifyPat, requireUser, createPat, listPats, revokePat } from "./auth.js";
import { createMcpServer } from "./mcp.js";

const app = new Hono();

// ─── Better Auth ────────────────────────────────────────────
// Mount Better Auth's own request handler. It owns everything under
// /api/auth/** (sign-up, sign-in, sign-out, session, etc). Hono exposes the
// underlying Web-Fetch Request as `c.req.raw`, which is exactly what the
// handler expects.
app.on(["POST", "GET"], "/api/auth/*", (c) => auth.handler(c.req.raw));

// ─── MCP endpoint ───────────────────────────────────────────

// GET is not a valid MCP request in this stateless configuration. Answer 405
// with an Allow header rather than letting the transport negotiate an SSE
// stream we don't serve.
app.get("/mcp", (c) => {
  c.header("Allow", "POST");
  return c.body(null, 405);
});

app.post("/mcp", async (c) => {
  const start = Date.now();
  let status = 200;
  let userIdForLog = "-";
  try {
    // AUTH FIRST: verify the PAT before anything else. On failure this throws a
    // bare 401 Response, so we reject *before* an McpServer is ever built and
    // without emitting a JSON-RPC envelope — an unauthenticated caller gets a
    // plain HTTP 401, not a protocol-level error object.
    const userId = await verifyPat(c.req.raw);
    userIdForLog = userId;

    // Fresh server + fresh transport per request (see the factory's WHY note).
    const server = createMcpServer(userId);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless — no session persistence
      enableJsonResponse: true, // return a single JSON response, not an SSE stream
    });
    await server.connect(transport);

    // PITFALL: pass the *Web-Fetch* Request (`c.req.raw`). This transport comes
    // from `.../server/webStandardStreamableHttp.js` and speaks the Web Fetch
    // Request/Response API. The similarly named transport in `streamableHttp.js`
    // is the Node (IncomingMessage/ServerResponse) wrapper and expects a
    // different argument shape — do not mix them up.
    const response = await transport.handleRequest(c.req.raw);
    status = response.status;
    return response;
  } catch (e) {
    if (e instanceof Response) {
      status = e.status;
      return e;
    }
    status = 500;
    throw e;
  } finally {
    // One structured line per request. Never logs the Authorization header, the
    // request body, tool args, or tool results.
    console.log(
      `mcp method=POST user=${userIdForLog} status=${status} ms=${Date.now() - start}`,
    );
  }
});

// ─── Token management (cookie-session guarded) ──────────────
// These endpoints are for a signed-in browser user to mint/list/revoke the
// PATs their MCP client will use. They authenticate with the session cookie,
// NOT with a PAT.

app.post("/api/tokens", async (c) => {
  let userId: string;
  try {
    userId = await requireUser(c.req.raw);
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
  const body = (await c.req.json().catch(() => ({}))) as { name?: unknown };
  if (typeof body.name !== "string") {
    return c.json({ error: "Field 'name' (string) is required." }, 400);
  }
  try {
    // The raw key is returned exactly once here — the caller must store it now.
    const pat = await createPat(userId, body.name);
    return c.json(pat, 201);
  } catch {
    return c.json({ error: "Invalid token name (must be 1-100 characters)." }, 400);
  }
});

app.get("/api/tokens", async (c) => {
  let userId: string;
  try {
    userId = await requireUser(c.req.raw);
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
  const tokens = await listPats(userId, c.req.raw);
  return c.json({ tokens });
});

app.delete("/api/tokens/:id", async (c) => {
  let userId: string;
  try {
    userId = await requireUser(c.req.raw);
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
  const result = await revokePat(userId, c.req.param("id"), c.req.raw);
  return c.json(result, result.ok ? 200 : 404);
});

// ─── Boot ───────────────────────────────────────────────────

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`remote-mcp-starter listening on http://localhost:${info.port}`);
});
