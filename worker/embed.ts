import { HTTPException } from "hono/http-exception";
import { secretSchema } from "../src/schema";
import { hash, randomSecret } from "./shared";
import type { AppContext } from "./shared";

export const FRAME_ANCESTORS =
  "https://x.com https://*.x.com https://twitter.com https://*.twitter.com";

export async function createEmbedAccess({ c }: { c: AppContext }) {
  const token = randomSecret();
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM embed_access WHERE expires_at < ?").bind(Date.now()),
    c.env.DB.prepare("INSERT INTO embed_access(token_hash, expires_at) VALUES (?, ?)").bind(
      await hash({ value: token }),
      Date.now() + 24 * 60 * 60 * 1000,
    ),
  ]);
  return token;
}

export async function requireEmbedAccess({ c }: { c: AppContext }) {
  const token = secretSchema.safeParse(c.req.header("x-embed-token"));
  if (!token.success)
    throw new HTTPException(403, { message: "Open the guestbook page to continue" });
  const row = await c.env.DB.prepare(
    "SELECT token_hash FROM embed_access WHERE token_hash = ? AND expires_at > ?",
  )
    .bind(await hash({ value: token.data }), Date.now())
    .first();
  if (!row)
    throw new HTTPException(403, {
      message: "Your guestbook page expired. Reload it to continue.",
    });
}
