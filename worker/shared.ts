import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { z } from "zod";
import { profileSchema, secretSchema } from "../src/schema";

export type Bindings = {
  ASSETS: Fetcher;
  DB: D1Database;
  APP_ORIGIN: string;
  X_CLIENT_ID?: string;
  X_CLIENT_SECRET?: string;
};
export type AppContext = Context<{ Bindings: Bindings }>;

export function randomSecret() {
  return base64url({ bytes: crypto.getRandomValues(new Uint8Array(32)) });
}

function base64url({ bytes }: { bytes: Uint8Array }) {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

export async function hash({ value }: { value: string }) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return base64url({ bytes: new Uint8Array(digest) });
}

export async function body<T extends z.ZodType>({
  c,
  schema,
}: {
  c: AppContext;
  schema: T;
}): Promise<z.output<T>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Expected a JSON request" });
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new HTTPException(400, { message: "Invalid request" });
  return parsed.data;
}

export function checkOrigin({ c }: { c: AppContext }) {
  if (c.req.header("origin") !== c.env.APP_ORIGIN) {
    throw new HTTPException(403, { message: "Request origin is not allowed" });
  }
}

export function oauthConfigured({ env }: { env: Bindings }) {
  return Boolean(env.X_CLIENT_ID && env.X_CLIENT_SECRET);
}

export async function sessionUser({ c }: { c: AppContext }) {
  const parsed = secretSchema.safeParse(c.req.header("authorization")?.replace(/^Bearer /, ""));
  if (!parsed.success) throw new HTTPException(401, { message: "Sign in with X first" });
  const tokenHash = await hash({ value: parsed.data });
  const row = await c.env.DB.prepare(
    "SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?",
  )
    .bind(tokenHash, Date.now())
    .first();
  if (!row) throw new HTTPException(401, { message: "Your session expired. Sign in again." });
  return profileSchema.parse(row);
}
