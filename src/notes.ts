import { z } from "zod";
import { prisma } from "./db.js";

// Domain layer for the example "notes" resource.
//
// Every function is scoped by `userId`. Reads filter out soft-deleted rows;
// writes and deletes are expressed as `updateMany({ where: { id, userId } })`
// so an id belonging to another user simply matches zero rows. When that
// happens — or when a row is genuinely missing — we throw a `404` Response.
//
// SECURITY: we deliberately throw the SAME 404 for "row does not exist" and
// "row exists but belongs to another user". Distinguishing them would leak the
// existence of other tenants' data (an IDOR information leak). At the MCP layer
// this 404 becomes a generic "not found or not owned by you" envelope.

export const ContentSchema = z
  .string()
  .min(1, "content must not be empty")
  .max(500, "content must be at most 500 characters");

export type Note = {
  id: string;
  content: string;
  createdAt: Date;
  updatedAt: Date;
};

function notFound(): never {
  throw new Response(null, { status: 404 });
}

/** List the user's non-deleted notes, newest first. */
export async function listNotes(userId: string): Promise<Note[]> {
  return prisma.note.findMany({
    where: { userId, deletedAt: null },
    orderBy: { createdAt: "desc" },
    select: { id: true, content: true, createdAt: true, updatedAt: true },
  });
}

/** Create a note owned by the user. Content is validated to 1..500 chars. */
export async function createNote(userId: string, content: string): Promise<Note> {
  const validated = ContentSchema.parse(content);
  return prisma.note.create({
    data: { userId, content: validated },
    select: { id: true, content: true, createdAt: true, updatedAt: true },
  });
}

/**
 * Rewrite a note's content. Throws 404 if the note is missing, soft-deleted, or
 * owned by another user.
 */
export async function updateNote(
  userId: string,
  noteId: string,
  content: string,
): Promise<Note> {
  const validated = ContentSchema.parse(content);
  const result = await prisma.note.updateMany({
    where: { id: noteId, userId, deletedAt: null },
    data: { content: validated },
  });
  if (result.count === 0) notFound();
  return prisma.note.findUniqueOrThrow({
    where: { id: noteId },
    select: { id: true, content: true, createdAt: true, updatedAt: true },
  });
}

/**
 * Soft-delete a note (sets `deletedAt`). The row stays in the database but is
 * excluded from `listNotes`. Throws 404 if the note is missing, already
 * deleted, or owned by another user.
 */
export async function softDeleteNote(userId: string, noteId: string): Promise<void> {
  const result = await prisma.note.updateMany({
    where: { id: noteId, userId, deletedAt: null },
    data: { deletedAt: new Date() },
  });
  if (result.count === 0) notFound();
}
