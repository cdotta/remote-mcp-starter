import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listNotes, createNote, updateNote, softDeleteNote } from "./notes.js";

// ─── Tool-result envelope helpers ───────────────────────────

/** Subset of the SDK's CallToolResult that our tools return. */
type ToolEnvelope = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: true;
};

/** Build the MCP `isError` envelope for a tool-execution failure. */
function errorEnvelope(text: string): ToolEnvelope {
  return {
    content: [{ type: "text" as const, text }],
    isError: true as const,
  };
}

/** Build a success envelope carrying BOTH a text block and structuredContent. */
function ok(result: Record<string, unknown>): ToolEnvelope {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result) }],
    structuredContent: result,
  };
}

type ZodFlattened = { formErrors: string[]; fieldErrors: Record<string, string[]> };

/**
 * Flatten a Zod error into a single agent-readable line, e.g.
 *   "content must be at most 500 characters"
 * so an LLM client gets an actionable message instead of a nested object.
 */
function formatZodErrors(errors: ZodFlattened): string {
  const fields = Object.entries(errors.fieldErrors)
    .map(([k, v]) => `${k}: ${v.join("; ")}`)
    .join(" | ");
  return [errors.formErrors.join("; "), fields].filter(Boolean).join(" — ");
}

/**
 * Per-tool wrapper. Emits exactly ONE stdout line per call:
 *
 *   mcp_tool tool=<name> user=<userId> status=<ok|error> ms=<elapsed>
 *
 * It NEVER logs args, note content, results, or token counts — only the tool
 * name (hard-coded at the call site), the user id, an ok/error status, and the
 * elapsed milliseconds.
 *
 * It also translates thrown errors into MCP envelopes:
 *   - a domain `Response(404)` becomes the generic IDOR/not-found envelope
 *     (never revealing whether the row exists for another tenant);
 *   - a `ZodError` becomes an agent-readable validation message;
 *   - anything else is re-thrown for the SDK to wrap as a generic tool error.
 */
async function withToolLogging(
  name: string,
  userId: string,
  fn: () => Promise<ToolEnvelope> | ToolEnvelope,
): Promise<ToolEnvelope> {
  const start = Date.now();
  let status: "ok" | "error" = "ok";
  try {
    const result = await fn();
    if (result.isError) status = "error";
    return result;
  } catch (e) {
    status = "error";
    if (e instanceof Response && e.status === 404) {
      return errorEnvelope("Note not found or not owned by you. Verify the noteId and try again.");
    }
    if (e instanceof z.ZodError) {
      return errorEnvelope(`Validation failed: ${formatZodErrors(e.flatten())}`);
    }
    throw e;
  } finally {
    console.log(`mcp_tool tool=${name} user=${userId} status=${status} ms=${Date.now() - start}`);
  }
}

/**
 * Build a fresh MCP server bound to `userId` via closure.
 *
 * WHY a factory (one server per request):
 *  - The user id is captured in this closure and read by every tool handler.
 *    We deliberately NEVER read it from the SDK's per-call `authInfo` field,
 *    which is unreliable in stateless (session-less) HTTP mode. The closure is
 *    the single source of truth for "who is calling".
 *  - The Streamable HTTP transport in stateless mode must not be reused across
 *    requests; recent SDK versions (>= 1.26) throw if you try. Constructing a
 *    fresh server + transport per request is both the supported pattern and a
 *    defense-in-depth measure against request/identity bleed between callers
 *    (the class of issue behind CVE-2026-25536).
 */
export function createMcpServer(userId: string): McpServer {
  const server = new McpServer(
    // Implementation info — name + version only.
    { name: "remote-mcp-starter", version: "0.1.0" },
    // Server options — capabilities + instructions live here.
    {
      capabilities: { tools: { listChanged: false } }, // static tool list
      instructions:
        "Example remote MCP server exposing per-user CRUD over 'notes'. Call `ping` first to verify connectivity and see your authenticated userId.",
    },
  );

  // Diagnostic ping. Zero-arg — returns the authenticated userId (from the
  // closure, never from authInfo) and a server-side ISO timestamp.
  server.registerTool(
    "ping",
    {
      description:
        "Diagnostic ping — returns the authenticated userId and current server timestamp. Use to verify the MCP connection is healthy.",
      outputSchema: {
        userId: z.string(),
        timestamp: z.string(),
      },
    },
    async () =>
      withToolLogging("ping", userId, () =>
        ok({ userId, timestamp: new Date().toISOString() }),
      ),
  );

  // Read all of the caller's non-deleted notes.
  server.registerTool(
    "list_notes",
    {
      description:
        "List all of your notes (soft-deleted notes are excluded). Returns { notes: [{ id, content, createdAt }] }.",
      outputSchema: {
        notes: z.array(
          z.object({
            id: z.string(),
            content: z.string(),
            createdAt: z.string(),
          }),
        ),
      },
    },
    async () =>
      withToolLogging("list_notes", userId, async () => {
        const notes = await listNotes(userId);
        return ok({
          notes: notes.map((n) => ({
            id: n.id,
            content: n.content,
            createdAt: n.createdAt.toISOString(),
          })),
        });
      }),
  );

  // Create a note.
  server.registerTool(
    "create_note",
    {
      description: "Create a new note. Content must be 1-500 characters.",
      inputSchema: {
        content: z.string().min(1, "content must not be empty").max(500, "content must be at most 500 characters"),
      },
      outputSchema: {
        ok: z.literal(true),
        note: z.object({
          id: z.string(),
          content: z.string(),
          createdAt: z.string(),
        }),
      },
    },
    async ({ content }) =>
      withToolLogging("create_note", userId, async () => {
        const note = await createNote(userId, content);
        return ok({
          ok: true,
          note: { id: note.id, content: note.content, createdAt: note.createdAt.toISOString() },
        });
      }),
  );

  // Rewrite a note's content.
  server.registerTool(
    "update_note",
    {
      description:
        "Rewrite an existing note's content. Content must be 1-500 characters. Fails if the note does not exist or is not yours.",
      inputSchema: {
        noteId: z.string().min(1, "noteId is required"),
        content: z.string().min(1, "content must not be empty").max(500, "content must be at most 500 characters"),
      },
      outputSchema: {
        ok: z.literal(true),
      },
    },
    async ({ noteId, content }) =>
      withToolLogging("update_note", userId, async () => {
        await updateNote(userId, noteId, content);
        return ok({ ok: true });
      }),
  );

  // Soft-delete a note.
  server.registerTool(
    "delete_note",
    {
      description:
        "Soft-delete a note (sets deletedAt; the row is kept but hidden). After this call, list_notes no longer returns it. Fails if the note does not exist or is not yours.",
      inputSchema: {
        noteId: z.string().min(1, "noteId is required"),
      },
      outputSchema: {
        ok: z.literal(true),
      },
    },
    async ({ noteId }) =>
      withToolLogging("delete_note", userId, async () => {
        await softDeleteNote(userId, noteId);
        return ok({ ok: true });
      }),
  );

  return server;
}
