import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { bookSchema, roomSchema, signatureSchema } from "../src/schema";
import { body, checkOrigin, oauthConfigured, sessionUser } from "./shared";
import type { Bindings } from "./shared";

export const guestbook = new Hono<{ Bindings: Bindings }>();

guestbook.get("/api/book/:room", async (c) => {
  const room = roomSchema.safeParse(c.req.param("room"));
  if (!room.success) throw new HTTPException(400, { message: "Invalid guestbook" });
  const { results } = await c.env.DB.prepare(
    "SELECT user_id AS id, username, name, avatar, message, signed_at AS signedAt FROM entries WHERE room = ? ORDER BY signed_at DESC LIMIT 100",
  )
    .bind(room.data)
    .all();
  return c.json(
    bookSchema.parse({ entries: results, configured: oauthConfigured({ env: c.env }) }),
  );
});

guestbook.post("/api/book/:room", async (c) => {
  checkOrigin({ c });
  const room = roomSchema.safeParse(c.req.param("room"));
  if (!room.success) throw new HTTPException(400, { message: "Invalid guestbook" });
  const user = await sessionUser({ c });
  const { message } = await body({ c, schema: signatureSchema });
  await c.env.DB.prepare(
    "INSERT INTO entries (room, user_id, username, name, avatar, message, signed_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(room,user_id) DO UPDATE SET username=excluded.username, name=excluded.name, avatar=excluded.avatar, message=excluded.message, signed_at=excluded.signed_at",
  )
    .bind(room.data, user.id, user.username, user.name, user.avatar, message, Date.now())
    .run();
  return c.json({ ok: true });
});
