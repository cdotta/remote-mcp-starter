import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { apiKey } from "@better-auth/api-key";
import { APIError } from "better-auth/api";
import { z } from "zod";
import { prisma } from "./db.js";

// ─── Better Auth instance ───────────────────────────────────
//
// Email/password auth for the browser (session cookie) plus the apiKey plugin
// for headless clients (MCP agents) that authenticate with a Personal Access
// Token in an `Authorization: Bearer <token>` header.

export const auth = betterAuth({
  database: prismaAdapter(prisma, {
    provider: "postgresql",
  }),
  // Reads BETTER_AUTH_SECRET and BETTER_AUTH_URL from the environment.
  emailAndPassword: {
    enabled: true,
  },
  plugins: [
    apiKey({
      // The apiKey plugin defaults to reading a key from an `x-api-key` header.
      // We override that so a token arrives the way MCP clients send it:
      // `Authorization: Bearer <token>`. Anything else is ignored (returns
      // null) so the cookie-session path stays completely separate.
      customAPIKeyGetter: (ctx) => {
        const hdr = ctx.request?.headers.get("authorization") ?? "";
        if (!hdr.startsWith("Bearer ")) return null;
        const token = hdr.slice(7).trim();
        return token.length > 0 ? token : null;
      },
      // `disableKeyHashing` is left at its default (false) so keys are hashed at
      // rest — the raw token is only ever returned once, at creation time.
      // The plugin's default maximum key-name length is 32; we raise it to 100
      // to match the validation on our token-creation endpoint.
      maximumNameLength: 100,
    }),
  ],
});

// ─── PAT verification (MCP auth boundary) ───────────────────

/**
 * Verify a Personal Access Token from the request's Authorization header and
 * return the owning user's id. Throws a bare `401` Response on ANY failure so
 * the MCP route can reject before ever constructing an McpServer — no JSON-RPC
 * envelope is emitted on the unauthenticated path.
 */
export async function verifyPat(request: Request): Promise<string> {
  const hdr = request.headers.get("authorization") ?? "";
  if (!hdr.startsWith("Bearer ")) throw new Response(null, { status: 401 });
  const token = hdr.slice(7).trim();
  if (!token) throw new Response(null, { status: 401 });

  const result = await auth.api.verifyApiKey({
    body: { key: token },
    headers: request.headers,
  });

  // IMPORTANT: Better Auth 1.5+ returns the owner under `result.key.referenceId`,
  // NOT `result.key.userId` (which no longer exists). And `result.key` can be
  // null even when `result.valid === true` per the return type union — so we
  // must guard BOTH conditions before trusting the id.
  if (!result.valid || !result.key?.referenceId) {
    throw new Response(null, { status: 401 });
  }
  return result.key.referenceId;
}

// ─── Session helpers (browser / cookie path) ────────────────

export async function getUserId(request: Request): Promise<string | null> {
  const result = await auth.api.getSession({ headers: request.headers });
  return result?.session.userId ?? null;
}

/**
 * Require a signed-in user (session cookie) or throw a bare `401` Response.
 * Used to guard the token-management REST endpoints.
 */
export async function requireUser(request: Request): Promise<string> {
  const userId = await getUserId(request);
  if (!userId) throw new Response(null, { status: 401 });
  return userId;
}

// ─── PAT management (cookie-guarded) ────────────────────────

const PatNameSchema = z.string().trim().min(1).max(100);

/**
 * Create a new PAT for `userId`. Returns the raw key ONCE — it is hashed at
 * rest and can never be read again. Throws ZodError if the name is invalid.
 */
export async function createPat(
  userId: string,
  name: string,
): Promise<{ key: string; id: string; name: string; start: string; createdAt: Date }> {
  const validatedName = PatNameSchema.parse(name);
  const result = await auth.api.createApiKey({
    body: { name: validatedName, userId },
  });
  // Return a trimmed, stable shape — Better Auth may add fields over time and
  // we don't want to leak them (or the hashed key) through our REST surface.
  return {
    key: result.key, // raw token — the only chance to read it
    id: result.id,
    name: result.name ?? validatedName,
    start: result.start ?? "",
    createdAt: result.createdAt,
  };
}

/**
 * List the caller's PATs. Never returns raw keys (they don't exist at rest).
 * Requires the request so Better Auth's session middleware can authorize; we
 * additionally re-filter by owner as defense in depth.
 */
export async function listPats(
  userId: string,
  request: Request,
): Promise<
  Array<{ id: string; name: string; start: string; createdAt: Date; lastRequest: Date | null }>
> {
  // Better Auth returns a paginated shape: { apiKeys, total, limit, offset }.
  // Its session middleware already scopes to the caller; we re-filter by owner
  // as belt-and-braces.
  const result = await auth.api.listApiKeys({ headers: request.headers });
  return result.apiKeys
    .filter((k) => k.referenceId === userId)
    .map((k) => ({
      id: k.id,
      name: k.name ?? "",
      start: k.start ?? "",
      createdAt: k.createdAt,
      lastRequest: k.lastRequest ?? null,
    }));
}

/**
 * Revoke a PAT the caller owns. Returns `{ ok: false }` when the key is missing
 * or owned by someone else (we never reveal which). Real infrastructure errors
 * propagate so the caller can distinguish "not found" from "something is down".
 */
export async function revokePat(
  userId: string,
  keyId: string,
  request: Request,
): Promise<{ ok: boolean }> {
  // Pre-check ownership before deleting. Better Auth's getApiKey throws
  // APIError(NOT_FOUND) when the key is missing or owned by another user, and
  // APIError(UNAUTHORIZED) when the session cookie is rejected. Both collapse
  // to { ok: false }; anything else is a genuine failure and re-throws.
  let owned: { referenceId: string } | null;
  try {
    owned = await auth.api.getApiKey({
      query: { id: keyId },
      headers: request.headers,
    });
  } catch (err) {
    if (err instanceof APIError && (err.statusCode === 404 || err.statusCode === 401)) {
      return { ok: false };
    }
    throw err;
  }
  if (!owned || owned.referenceId !== userId) {
    return { ok: false };
  }
  const result = await auth.api.deleteApiKey({
    body: { keyId },
    headers: request.headers,
  });
  return { ok: result.success };
}
