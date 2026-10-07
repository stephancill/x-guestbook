import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { attemptSchema, authorizeSchema, profileSchema, secretSchema } from "../src/schema";
import { body, checkOrigin, hash, oauthConfigured, randomSecret, sessionUser } from "./shared";
import type { Bindings } from "./shared";

const TEN_MINUTES = 10 * 60 * 1000;
const SESSION_LIFE = 30 * 24 * 60 * 60 * 1000;
const tokenResponseSchema = z.object({ access_token: z.string().min(1) });
const xProfileSchema = z.object({
  data: z.object({
    id: profileSchema.shape.id,
    username: profileSchema.shape.username,
    name: profileSchema.shape.name,
    profile_image_url: profileSchema.shape.avatar.optional(),
  }),
});
type AttemptRow = {
  verifier: string;
  user_id: string | null;
  status: string;
  error: string | null;
  expires_at: number;
};

export function createAuth({ providerFetch = fetch }: { providerFetch?: typeof fetch } = {}) {
  const auth = new Hono<{ Bindings: Bindings }>();

  auth.post("/api/auth/start", async (c) => {
    checkOrigin({ c });
    if (!oauthConfigured({ env: c.env }))
      throw new HTTPException(503, { message: "X OAuth credentials are not configured yet" });
    const state = randomSecret(),
      pollToken = randomSecret(),
      launchToken = randomSecret(),
      verifier = randomSecret();
    const now = Date.now();
    await c.env.DB.batch([
      c.env.DB.prepare("DELETE FROM login_attempts WHERE expires_at < ?").bind(now),
      c.env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now),
      c.env.DB.prepare(
        "INSERT INTO login_attempts (state, poll_hash, launch_hash, verifier, expires_at) VALUES (?, ?, ?, ?, ?)",
      ).bind(
        state,
        await hash({ value: pollToken }),
        await hash({ value: launchToken }),
        verifier,
        now + TEN_MINUTES,
      ),
    ]);
    const fragment = new URLSearchParams({ state, launchToken });
    return c.json({
      state,
      pollToken,
      loginUrl: `${c.env.APP_ORIGIN}/auth/launch#${fragment}`,
      expiresAt: now + TEN_MINUTES,
    });
  });

  auth.post("/api/auth/authorize", async (c) => {
    checkOrigin({ c });
    const { state, launchToken } = await body({ c, schema: authorizeSchema });
    const callbackToken = randomSecret();
    const row = await c.env.DB.prepare(
      "UPDATE login_attempts SET status = 'authorizing', launch_hash = NULL, callback_hash = ? WHERE state = ? AND launch_hash = ? AND status = 'pending' AND expires_at > ? RETURNING verifier",
    )
      .bind(
        await hash({ value: callbackToken }),
        state,
        await hash({ value: launchToken }),
        Date.now(),
      )
      .first<{ verifier: string }>();
    if (!row)
      throw new HTTPException(400, {
        message: "This sign-in link expired or was already used. Start again in the guestbook.",
      });
    setCookie(c, `oauth_${state}`, callbackToken, {
      path: "/auth/callback",
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
      maxAge: 600,
    });
    const url = new URL("https://x.com/i/oauth2/authorize");
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: c.env.X_CLIENT_ID!,
      redirect_uri: `${c.env.APP_ORIGIN}/auth/callback`,
      scope: "tweet.read users.read",
      state,
      code_challenge: await hash({ value: row.verifier }),
      code_challenge_method: "S256",
    }).toString();
    return c.json({ url: url.href });
  });

  auth.get("/auth/callback", async (c) => {
    const state = secretSchema.safeParse(c.req.query("state"));
    if (!state.success) throw new HTTPException(400, { message: "Invalid OAuth state" });
    const cookieName = `oauth_${state.data}`;
    const cookie = secretSchema.safeParse(getCookie(c, cookieName));
    if (!cookie.success)
      throw new HTTPException(400, {
        message: "The sign-in browser session is missing. Start again in the guestbook.",
      });
    const row = await c.env.DB.prepare(
      "UPDATE login_attempts SET status = 'exchanging', callback_hash = NULL WHERE state = ? AND callback_hash = ? AND status = 'authorizing' AND expires_at > ? RETURNING verifier",
    )
      .bind(state.data, await hash({ value: cookie.data }), Date.now())
      .first<{ verifier: string }>();
    deleteCookie(c, cookieName, {
      path: "/auth/callback",
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
    });
    if (!row)
      throw new HTTPException(400, { message: "This sign-in expired or was already completed" });
    let error: string | null = null;
    try {
      if (c.req.query("error")) throw new Error("X authorization was declined. You can try again.");
      const code = z.string().min(1).max(2048).parse(c.req.query("code"));
      const authorization = `Basic ${btoa(`${encodeURIComponent(c.env.X_CLIENT_ID!)}:${encodeURIComponent(c.env.X_CLIENT_SECRET!)}`)}`;
      const tokenResponse = await providerFetch("https://api.x.com/2/oauth2/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", authorization },
        body: new URLSearchParams({
          code,
          grant_type: "authorization_code",
          redirect_uri: `${c.env.APP_ORIGIN}/auth/callback`,
          code_verifier: row.verifier,
        }),
      });
      if (!tokenResponse.ok)
        throw new Error(
          `X token exchange failed (HTTP ${tokenResponse.status}). Please try signing in again.`,
        );
      const token = tokenResponseSchema.parse(await tokenResponse.json());
      const userResponse = await providerFetch(
        "https://api.x.com/2/users/me?user.fields=profile_image_url",
        {
          headers: { authorization: `Bearer ${token.access_token}` },
        },
      );
      if (!userResponse.ok)
        throw new Error(
          `X profile lookup failed (HTTP ${userResponse.status}). Check the developer app's API access and credits.`,
        );
      const { data } = xProfileSchema.parse(await userResponse.json());
      const user = profileSchema.parse({ ...data, avatar: data.profile_image_url ?? null });
      const saved = await c.env.DB.batch([
        c.env.DB.prepare(
          "INSERT INTO users (id, username, name, avatar) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET username=excluded.username, name=excluded.name, avatar=excluded.avatar",
        ).bind(user.id, user.username, user.name, user.avatar),
        c.env.DB.prepare(
          "UPDATE login_attempts SET status = 'ready', user_id = ?, verifier = NULL WHERE state = ? AND status = 'exchanging'",
        ).bind(user.id, state.data),
      ]);
      if (saved[1].meta.changes !== 1)
        throw new Error("Sign-in was cancelled. Start again in the guestbook.");
    } catch (caught) {
      error =
        caught instanceof z.ZodError
          ? "X returned an unexpected response. Please try again."
          : caught instanceof Error
            ? caught.message
            : "X sign-in failed. Please try again.";
      await c.env.DB.prepare(
        "UPDATE login_attempts SET status = 'failed', error = ?, verifier = NULL WHERE state = ?",
      )
        .bind(error, state.data)
        .run();
    }
    return c.redirect(
      `${c.env.APP_ORIGIN}/auth/done?${new URLSearchParams({ result: error ? "failed" : "success", state: state.data })}`,
    );
  });

  auth.post("/api/auth/status", async (c) => {
    checkOrigin({ c });
    const { state, pollToken } = await body({ c, schema: attemptSchema });
    const pollHash = await hash({ value: pollToken });
    const row = await c.env.DB.prepare(
      "SELECT status, user_id, error, expires_at FROM login_attempts WHERE state = ? AND poll_hash = ?",
    )
      .bind(state, pollHash)
      .first<AttemptRow>();
    if (!row) throw new HTTPException(404, { message: "Sign-in request not found" });
    if (row.expires_at <= Date.now())
      return c.json({ status: "failed", error: "Sign-in expired. Please try again." });
    if (row.status === "failed")
      return c.json({ status: "failed", error: row.error || "Sign-in failed" });
    if (row.status === "claimed")
      return c.json({
        status: "failed",
        error: "This sign-in was already claimed. Please sign in again.",
      });
    if (row.status !== "ready")
      return c.json({
        status: "pending",
        phase: z.enum(["pending", "authorizing", "exchanging"]).parse(row.status),
      });
    const claimed = await c.env.DB.prepare(
      "UPDATE login_attempts SET status='claimed' WHERE state=? AND poll_hash=? AND status='ready' RETURNING user_id",
    )
      .bind(state, pollHash)
      .first<{ user_id: string }>();
    if (!claimed) throw new HTTPException(409, { message: "Sign-in was already claimed" });
    const user = profileSchema.parse(
      await c.env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(claimed.user_id).first(),
    );
    const sessionToken = randomSecret();
    await c.env.DB.prepare(
      "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)",
    )
      .bind(await hash({ value: sessionToken }), user.id, Date.now() + SESSION_LIFE)
      .run();
    return c.json({ status: "complete", sessionToken, user });
  });

  auth.post("/api/auth/cancel", async (c) => {
    checkOrigin({ c });
    const { state, pollToken } = await body({ c, schema: attemptSchema });
    await c.env.DB.prepare(
      "UPDATE login_attempts SET status='failed', error='Sign-in cancelled. Please try again.', verifier=NULL, launch_hash=NULL, callback_hash=NULL WHERE state=? AND poll_hash=? AND status!='claimed'",
    )
      .bind(state, await hash({ value: pollToken }))
      .run();
    return c.json({ ok: true });
  });

  auth.get("/api/me", async (c) => c.json({ user: await sessionUser({ c }) }));
  auth.post("/api/logout", async (c) => {
    checkOrigin({ c });
    await sessionUser({ c });
    await c.env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?")
      .bind(await hash({ value: c.req.header("authorization")!.slice(7) }))
      .run();
    return c.json({ ok: true });
  });

  return auth;
}
