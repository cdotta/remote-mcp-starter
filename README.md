# remote-mcp-starter

[![CI](https://github.com/cdotta/remote-mcp-starter/actions/workflows/ci.yml/badge.svg)](https://github.com/cdotta/remote-mcp-starter/actions/workflows/ci.yml)

A **remote** MCP server you can actually put in production. Any agent — a
claude.ai custom connector, Claude Code, Cursor, a Telegram bot — connects to it
over plain HTTPS with an `Authorization: Bearer <token>` header, and gets a
per-user, tenant-isolated view of your data. It was extracted from a production
bullet-journal app and stripped down to a single trivial domain ("notes") so the
plumbing is the point. Swap the notes domain for yours; keep the auth, transport,
isolation, error, and logging layers exactly as they are.

Most MCP examples are local `stdio` toys: one process, one user, no auth, no
network. This is the other thing — the one you reach for when you've already
found those examples and are still asking *"how do I run a **real** remote MCP
server with auth and multi-tenancy?"*

**What you get**

- **Stateless Streamable HTTP** — no session store; any instance serves any
  request. Fits serverless and horizontal scale-out.
- **PAT auth** — Personal Access Tokens via Better Auth's `apiKey` plugin,
  **hashed at rest**, raw key shown exactly once.
- **Per-request tenant isolation** — every query is scoped to the calling user;
  cross-tenant access is indistinguishable from a missing row.
- **Agent-friendly errors** — validation and not-found failures come back as
  readable text an LLM can self-correct on, not opaque JSON-RPC error codes.
- **Log discipline** — one structured line per request and per tool call; tokens,
  arguments, and content are never logged.
- **A real integration suite** — 36 tests, zero mocks, running the whole stack
  in-process against an ephemeral Postgres schema.

**Stack:** [Hono](https://hono.dev) · [Better Auth](https://better-auth.com) ·
[`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk)
`>=1.26` · [Prisma 7](https://prisma.io) + Postgres · TypeScript (ESM, Node `>=22`).

---

## Quick start

You need Node `>=22`, [pnpm](https://pnpm.io), and Docker (for local Postgres).

```bash
git clone <your-fork-url> remote-mcp-starter
cd remote-mcp-starter
pnpm install

cp .env.example .env
# Generate a real secret and paste it into BETTER_AUTH_SECRET:
openssl rand -base64 32

docker compose up -d      # Postgres 17 on host port 5433
pnpm exec prisma db push  # create tables (also runs prisma generate)
pnpm dev                  # tsx watch on http://localhost:3000
```

`docker-compose.yml` publishes Postgres on **5433** (not 5432) so it won't
collide with a Postgres you may already run. `.env.example` already points
`DATABASE_URL` there.

### Drive it with curl

The flow is: sign up (browser-style, session cookie) → mint a PAT with that
cookie → use the PAT as a Bearer token for MCP. Agents only ever hold the PAT.

```bash
# 1. Sign up. Better Auth sets a `better-auth.session_token` cookie.
curl -i -X POST http://localhost:3000/api/auth/sign-up/email \
  -H 'Content-Type: application/json' \
  -c cookies.txt \
  -d '{"name":"Ada","email":"ada@example.com","password":"password12345"}'

# 2. Mint a PAT (cookie-authenticated). The raw key is returned ONCE — save it.
curl -X POST http://localhost:3000/api/tokens \
  -H 'Content-Type: application/json' -b cookies.txt \
  -d '{"name":"my-laptop"}'
# => {"key":"PfGE...cWPF","id":"LhMN...","name":"my-laptop","start":"PfGEBZ","createdAt":"..."}

export PAT="PfGE...cWPF"   # paste the "key" value from above
```

Now talk MCP. Note the `Accept` header: the Streamable HTTP transport requires
the client to advertise *both* JSON and SSE on POST, even though this server is
configured to always answer with a single JSON response.

```bash
# initialize
curl -X POST http://localhost:3000/mcp \
  -H "Authorization: Bearer $PAT" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{
        "protocolVersion":"2024-11-05","capabilities":{},
        "clientInfo":{"name":"curl","version":"0"}}}'

# tools/list  ->  ping, list_notes, create_note, update_note, delete_note
curl -X POST http://localhost:3000/mcp \
  -H "Authorization: Bearer $PAT" -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'

# tools/call create_note
curl -X POST http://localhost:3000/mcp \
  -H "Authorization: Bearer $PAT" -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{
        "name":"create_note","arguments":{"content":"Buy milk"}}}'
```

A call with no (or a bad) token returns a **bare HTTP 401 with an empty body** —
no JSON-RPC envelope. `GET /mcp` returns `405` with `Allow: POST` (there is no
SSE stream to negotiate in stateless mode).

Run the suite anytime (needs `docker compose up -d`):

```bash
pnpm test        # 36 passing integration tests
pnpm typecheck   # tsc on src + tests
```

---

## Connect an agent

Remote MCP needs three things that local stdio doesn't: a reachable **HTTPS
URL**, a **Bearer token**, and the HTTP (Streamable HTTP) transport instead of a
stdio subprocess. Point any of these at `https://<your-host>/mcp`.

**Claude Code**

```bash
claude mcp add --transport http notes https://your-app.fly.dev/mcp \
  --header "Authorization: Bearer $PAT"
```

**claude.ai custom connector** — Settings → Connectors → Add custom connector.
Set the URL to `https://your-app.fly.dev/mcp` and supply the PAT as the bearer
token / `Authorization: Bearer <PAT>` header.

**Generic MCP client config** (Cursor, and anything that reads the standard
`mcpServers` shape):

```json
{
  "mcpServers": {
    "notes": {
      "type": "http",
      "url": "https://your-app.fly.dev/mcp",
      "headers": { "Authorization": "Bearer PfGE...cWPF" }
    }
  }
}
```

For local development the URL is `http://localhost:3000/mcp`. In production it
must be HTTPS — you are shipping a bearer token on every request.

---

## The decisions

This is the part worth reading. Each choice below is a small thing that's easy to
get wrong and annoying to debug.

### Per-request server factory; identity from a closure, never from `authInfo`

`createMcpServer(userId)` in [`src/mcp.ts`](src/mcp.ts) builds a **fresh
`McpServer` per request**, with `userId` captured in the closure. Every tool
handler reads that closure — it is the single source of truth for "who is
calling." We deliberately never read the id from the SDK's per-call `authInfo`
field, which is unreliable in stateless (session-less) mode. Constructing a new
server *and* transport per request isn't just tidy: the SDK (`>=1.26`) throws if
you reuse a stateless Streamable HTTP transport across requests, and a
per-request instance is defense-in-depth against identity bleed between callers
(the class of bug behind CVE-2026-25536). One request, one server, one user.

### Stateless Streamable HTTP

The transport is created with `sessionIdGenerator: undefined` (no session
persistence) and `enableJsonResponse: true` (answer with a single JSON body, not
an SSE stream). Stateless means there's no server-side session to store or route
back to, so **any instance can serve any request** — which is exactly what you
want on serverless or behind a load balancer with N replicas. What you give up:
server-initiated messages. No SSE push, no long-lived streaming, no
`notifications/*` from server to client. For a request/response tool server
(which is most of them), that's a non-loss.

### The transport pitfall: Web-Standard vs. Node

There are two similarly named transports in the SDK. `src/server.ts` imports
`WebStandardStreamableHTTPServerTransport` from
`.../server/webStandardStreamableHttp.js` — it speaks the Web Fetch
`Request`/`Response` API. Hono hands you exactly that as `c.req.raw`, so
`transport.handleRequest(c.req.raw)` returns a `Response` you return directly.
The other one, in `.../server/streamableHttp.js`, is the Node
(`IncomingMessage`/`ServerResponse`) wrapper and expects a completely different
argument shape. Import the wrong one and nothing type-errors until it fails at
runtime. On a Fetch-based framework (Hono, and most edge runtimes), use the
Web-Standard transport.

### Auth is a boundary, not a tool

Look at the order in `POST /mcp`: `verifyPat()` runs **before** `createMcpServer`
is ever called. On any failure it throws a bare `401` `Response`, so an
unauthenticated caller is rejected before a single line of protocol code runs and
gets a **plain HTTP 401 with an empty body** — not a JSON-RPC error object. This
is deliberate. Protocol machinery shouldn't execute for traffic that hasn't
earned it, and the MCP spec places authorization at the HTTP layer, so a
transport-level `401` is the correct, spec-aligned answer. Unauthenticated
callers never learn anything about the protocol behind the door.

### Better Auth `apiKey`: hashing and the `referenceId` gotcha

PATs are Better Auth API keys. `disableKeyHashing` is left at its default, so
keys are **hashed at rest** — the raw token exists only in the HTTP response at
creation time and is never recoverable. `customAPIKeyGetter` overrides the
plugin's default `x-api-key` header so tokens arrive the way MCP clients send
them: `Authorization: Bearer <token>` (anything else returns `null`, keeping the
cookie-session path fully separate). The sharp edge: in **Better Auth 1.5+** the
key's owner is `result.key.referenceId`, *not* `result.key.userId` (which no
longer exists) — and `result.key` can be `null` even when `result.valid` is
`true`. `verifyPat()` guards both conditions before trusting the id. The Prisma
`Apikey.referenceId` → `User` relation is hand-added (the Better Auth CLI won't
emit it) so deleting a user cascades to their keys.

### Tenant isolation & IDOR

Every query in [`src/notes.ts`](src/notes.ts) is `userId`-scoped. Writes and
deletes are expressed as `updateMany({ where: { id, userId, deletedAt: null } })`
so an id owned by another tenant simply matches zero rows. When that happens — or
when a row is genuinely missing — the layer throws the **same** `404`. We never
distinguish "doesn't exist" from "exists but isn't yours," because doing so would
leak the existence of other tenants' data (an IDOR information leak). At the tool
layer that `404` becomes one generic envelope: *"Note not found or not owned by
you."* Deletes are **soft** (`deletedAt` timestamp), so rows are hidden from reads
but never physically removed; the composite `@@index([userId, deletedAt])` matches
the hot "my non-deleted notes" query.

### Agent-friendly errors

Tools don't throw JSON-RPC protocol errors for expected failures. They return the
MCP `isError` envelope with a flat, human-readable message — a Zod validation
failure becomes `"Validation failed: content must be at most 500 characters"`, not
a nested error object. An LLM client can read that and self-correct on the next
turn. Success envelopes carry **both** a `content` text block (JSON-stringified)
and a `structuredContent` object, so clients that want structured output and
clients that only read text both work. See `withToolLogging`, `errorEnvelope`,
`ok`, and `formatZodErrors` in [`src/mcp.ts`](src/mcp.ts).

### Log discipline

Exactly one structured line per HTTP request:

```
mcp method=POST user=<userId> status=200 ms=12
```

and one per tool call:

```
mcp_tool tool=create_note user=<userId> status=ok ms=4
```

That's the whole log surface. The `Authorization` header, the request body, tool
arguments, tool results, and note content are **never** logged. Journals and notes
are sensitive; the logs are safe to ship to any aggregator.

### Testing: no mocks, ephemeral schema

The suite in [`tests/`](tests/) exercises the real stack. `signUp()` hits the
real Better Auth endpoint, `createPat()` mints a real hashed key, and `mcpCall()`
sends real JSON-RPC over `app.request("/mcp", …)` — Hono's in-process request
driver, so every route, Better Auth, the transport, and Prisma all run, but no TCP
port is opened (`src/server.ts` exports `app` and only calls `serve()` when it's
the process entry point). Nothing is stubbed; a separate direct Prisma client
asserts row-level facts like "the raw key is not in the database."

Each `pnpm test` run provisions its **own throwaway Postgres schema**,
`mcp_test_<pid>`, inside the docker-compose database, pushes the Prisma schema
into it, and drops it on teardown — so tests never read or clobber your `public`
dev data. The only manual prep is `docker compose up -d`.

One caveat worth knowing: vitest 4 runs test workers in **forked child
processes**, and env mutations made in `globalSetup` don't reliably cross the fork
boundary. So the ephemeral-schema connection info is written to a temp file and
re-loaded per worker in `setupFiles` (see `tests/integration/setup.ts`,
`worker-setup.ts`, `schema-config.ts`). The suite pins `pool: "forks"` with
`maxWorkers: 1` so the shared schema has a single writer and the logs stay linear.

The 36 tests cover: the MCP protocol surface (initialize, tools/list, every tool
happy path, validation → `isError`, soft-delete visibility), the auth boundary
(401-before-JSON-RPC, 405 on GET), the full PAT lifecycle (create → verify →
revoke → denied, hashed-at-rest, raw-key-shown-once), tenant isolation / IDOR
across users, and the token-management REST API.

---

## Make it yours

The notes domain is a placeholder. To model your own resource, change these files
**in this order** and leave everything else alone:

1. **`prisma/schema.prisma`** — replace the `Note` model with yours (keep the
   `userId` FK to `User` and, if you want reversible deletes, a nullable
   `deletedAt` plus a `@@index([userId, deletedAt])`). Run `pnpm exec prisma db
   push` (or `pnpm migrate` for a versioned migration).
2. **`src/notes.ts`** — rename to your domain and rewrite the query functions.
   Keep the invariants: every query `userId`-scoped, the shared `404` for
   missing-or-not-owned, and Zod validation at the boundary.
3. **`src/mcp.ts`** — swap the `registerTool` calls for your tools. Reuse
   `withToolLogging`, `ok`, and `errorEnvelope` as-is.
4. **`tests/`** — point the existing suites at your tools and models.

Do **not** touch the auth boundary (`src/auth.ts`, the `verifyPat`-first order in
`src/server.ts`), the transport wiring, the envelope/error helpers, or the logging
format. Those are the reusable spine; the domain is the only replaceable part.

---

## Deploy notes

Any Node `>=22` host works — it's a plain Hono app behind `@hono/node-server`.
`pnpm build` runs `prisma generate`, compiles to `dist/`, and copies the
generated client; `pnpm start` runs `node dist/server.js`.

The app this was extracted from runs on **Fly.io** with a managed Postgres
(Neon). The essentials for any target:

- **Env vars:** `DATABASE_URL`, `BETTER_AUTH_SECRET` (`openssl rand -base64 32`),
  `BETTER_AUTH_URL` (the server's public origin — Better Auth validates the
  `Origin` header of state-changing auth requests against it), and `PORT`.
- **HTTPS is mandatory.** You ship a bearer token on every request; terminate TLS
  at the platform's proxy and never expose the plain-HTTP port.
- **Sign-up is open by default.** Anyone who can reach `/api/auth/sign-up/email`
  can create an account — there is no email verification or rate limiting out of
  the box. If your instance isn't meant to be open-registration, gate it before
  going live (Better Auth's `rateLimit` and email-verification options, or
  disable sign-up entirely and provision accounts out of band).
- **Scale out freely.** Stateless mode means there is no session affinity — every
  replica can serve every request, so you can run N instances behind a plain
  round-robin load balancer.

---

## Security checklist

- [ ] **HTTPS only** in production — bearer tokens travel on every request.
- [ ] **PATs hashed at rest** (`disableKeyHashing` left default) — raw key shown
      once, at creation.
- [ ] **Revocation** via `DELETE /api/tokens/:id` (ownership pre-checked; returns
      the same result for missing and not-owned keys).
- [ ] **No token logging** — never log the `Authorization` header, request
      bodies, tool args, or content.
- [ ] **Tenant scoping everywhere** — every query filtered by `userId`;
      cross-tenant access returns the same 404 as a missing row.
- [ ] **401 before protocol** — verify the PAT before constructing any MCP server;
      unauthenticated callers get a bare 401, never a JSON-RPC envelope.
- [ ] **Pin the SDK `>=1.26`** — earlier versions don't guard stateless transport
      reuse (CVE-2026-25536).

---

## Contributing

Issues and PRs welcome. Before opening a PR: `pnpm typecheck && pnpm test` must be
green (start Postgres first with `docker compose up -d`). Keep the auth,
transport, isolation, error, and logging layers intact — changes there need a
clear rationale and test coverage.

## License

MIT — see [LICENSE](LICENSE). Extracted from a production bullet-journal app and
distilled down to the plumbing. Built on [Hono](https://hono.dev),
[Better Auth](https://better-auth.com), [Prisma](https://prisma.io), and the
[Model Context Protocol TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk).
