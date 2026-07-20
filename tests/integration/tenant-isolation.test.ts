// Integration tests for cross-tenant isolation (IDOR defense).
//
// Two users are created through the real sign-up flow, each with their own PAT.
// User B must never be able to read, update, or delete User A's notes via the MCP
// tools. Every cross-tenant attempt must return the generic not-found isError
// envelope (which never reveals whether the row exists for another tenant), and
// User A's data must be left completely unchanged.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "../../src/generated/prisma/client.js";
import { signUp, createPat, toolCall, testDb } from "../helpers.js";

let db: PrismaClient;

interface Actor {
  userId: string;
  key: string;
}

let userA: Actor;
let userB: Actor;

/** Create a note as the given actor and return its id. */
async function createNoteAs(actor: Actor, content: string, id: number): Promise<string> {
  const res = await toolCall(actor.key, "create_note", { content }, id);
  expect(res.status).toBe(200);
  expect(res.body.result.isError).not.toBe(true);
  return res.body.result.structuredContent.note.id as string;
}

/**
 * Assert a cross-tenant tool call is rejected with the generic not-found IDOR
 * envelope. Returns the current DB row so callers can additionally assert the
 * owner's data is unchanged.
 */
async function expectIdorRejection(
  attackerKey: string,
  toolName: string,
  args: Record<string, unknown>,
  ownerNoteId: string,
  id: number,
) {
  const res = await toolCall(attackerKey, toolName, args, id);
  expect(res.status).toBe(200); // IDOR is a tool-level error, still HTTP 200
  expect(res.body.error).toBeUndefined(); // NOT a JSON-RPC error envelope
  expect(res.body.result.isError).toBe(true);
  expect(res.body.result.content[0].text).toMatch(/not found|not owned/i);
  // Error envelopes never carry structuredContent (no data leak channel).
  expect(res.body.result.structuredContent).toBeUndefined();
  return db.note.findUnique({ where: { id: ownerNoteId } });
}

beforeAll(async () => {
  db = testDb();
  const a = await signUp();
  const b = await signUp();
  userA = { userId: a.userId, key: (await createPat(a.cookie, "tenant-a")).key };
  userB = { userId: b.userId, key: (await createPat(b.cookie, "tenant-b")).key };
});

afterAll(async () => {
  await db.$disconnect();
});

describe("IDOR: B cannot update A's note", () => {
  it("update_note with A's noteId from B's PAT -> not-found envelope, content unchanged", async () => {
    const noteId = await createNoteAs(userA, "A's original content", 100);

    const row = await expectIdorRejection(
      userB.key,
      "update_note",
      { noteId, content: "B's malicious rewrite" },
      noteId,
      101,
    );
    expect(row?.content).toBe("A's original content"); // unchanged
    expect(row?.userId).toBe(userA.userId); // still owned by A
  });
});

describe("IDOR: B cannot delete A's note", () => {
  it("delete_note with A's noteId from B's PAT -> not-found envelope, deletedAt still null", async () => {
    const noteId = await createNoteAs(userA, "A's safe note", 110);

    const row = await expectIdorRejection(userB.key, "delete_note", { noteId }, noteId, 111);
    expect(row?.deletedAt).toBeNull(); // soft-delete must NOT have happened
    expect(row?.userId).toBe(userA.userId);
  });
});

describe("IDOR (read): B cannot see A's notes via list_notes", () => {
  it("B's list_notes never includes A's note ids", async () => {
    const aNoteId = await createNoteAs(userA, "A's private note", 120);

    const res = await toolCall(userB.key, "list_notes", {}, 121);
    expect(res.status).toBe(200);
    expect(res.body.result.isError).not.toBe(true);

    const bNotes = res.body.result.structuredContent.notes as Array<{
      id: string;
      content: string;
    }>;
    const ids = bNotes.map((n) => n.id);
    const contents = bNotes.map((n) => n.content);
    expect(ids).not.toContain(aNoteId);
    expect(contents).not.toContain("A's private note");
    // Cross-check the text fallback channel carries no leak either.
    const fromText = JSON.parse(res.body.result.content[0].text) as {
      notes: Array<{ id: string }>;
    };
    expect(fromText.notes.map((n) => n.id)).not.toContain(aNoteId);
  });
});

describe("isolation is symmetric: A cannot touch B's note", () => {
  it("update_note with B's noteId from A's PAT -> not-found envelope, B's content unchanged", async () => {
    const bNoteId = await createNoteAs(userB, "B's original content", 130);

    const row = await expectIdorRejection(
      userA.key,
      "update_note",
      { noteId: bNoteId, content: "A trying to overwrite B" },
      bNoteId,
      131,
    );
    expect(row?.content).toBe("B's original content");
    expect(row?.userId).toBe(userB.userId);
  });
});
