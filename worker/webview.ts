import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { eventsSchema, eventSchema, runIdSchema } from "../src/webview-schema";
import { secretSchema } from "../src/schema";
import { hash, randomSecret } from "./shared";

type ProbeBindings = { DB: D1Database; ASSETS: Fetcher; APP_ORIGIN: string; HOP_ORIGIN: string };
const LIFE = 24 * 60 * 60 * 1000;
export function createWebviewProbe() {
  const app = new Hono<{ Bindings: ProbeBindings }>();
  app.use("*", async (c, next) => {
    await next();
    c.header("Cache-Control", "no-store");
    c.header("Referrer-Policy", "no-referrer");
    c.header("X-Content-Type-Options", "nosniff");
    c.header(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors https://x.com https://*.x.com https://twitter.com https://*.twitter.com; base-uri 'none'; object-src 'none'",
    );
  });
  app.use("/api/*", bodyLimit({ maxSize: 24000 }));
  app.use("/api/*", async (c, next) => {
    if (new URL(c.req.url).origin !== c.env.APP_ORIGIN)
      throw new HTTPException(403, { message: "Use the primary probe origin" });
    if (c.req.method === "POST" && c.req.header("origin") !== c.env.APP_ORIGIN)
      throw new HTTPException(403, { message: "Invalid request origin" });
    await next();
  });
  app.onError((error, c) =>
    c.json(
      {
        error:
          error instanceof HTTPException
            ? error.message
            : error instanceof z.ZodError
              ? "Invalid probe input"
              : "Probe request failed",
      },
      error instanceof HTTPException ? error.status : error instanceof z.ZodError ? 400 : 500,
    ),
  );
  app.post("/api/runs", async (c) => {
    const id = crypto.randomUUID(),
      token = randomSecret(),
      now = Date.now();
    await c.env.DB.batch([
      c.env.DB.prepare(
        "DELETE FROM probe_events WHERE run_id IN (SELECT id FROM probe_runs WHERE expires_at < ?)",
      ).bind(now),
      c.env.DB.prepare("DELETE FROM probe_runs WHERE expires_at < ?").bind(now),
      c.env.DB.prepare("INSERT INTO probe_runs(id,token_hash,expires_at) VALUES (?,?,?)").bind(
        id,
        await hash({ value: token }),
        now + LIFE,
      ),
    ]);
    return c.json({ id, token, expiresAt: now + LIFE });
  });
  app.use("/api/runs/:run/*", async (c, next) => {
    const id = runIdSchema.parse(c.req.param("run"));
    const token = secretSchema.safeParse(c.req.header("authorization")?.replace(/^Bearer /, ""));
    const row = token.success
      ? await c.env.DB.prepare(
          "SELECT id FROM probe_runs WHERE id=? AND token_hash=? AND expires_at>?",
        )
          .bind(id, await hash({ value: token.data }), Date.now())
          .first()
      : null;
    if (!row)
      throw new HTTPException(403, { message: "Probe run missing, expired or invalid credential" });
    await next();
  });
  app.post("/api/runs/:run/events", async (c) => {
    const { events } = eventsSchema.parse(await c.req.json());
    const saved = await c.env.DB.batch(
      events.map((event) =>
        c.env.DB.prepare(
          "INSERT INTO probe_events(run_id,received_at,event) SELECT ?,?,? WHERE (SELECT COUNT(*) FROM probe_events WHERE run_id=?) < 1000",
        ).bind(c.req.param("run"), Date.now(), JSON.stringify(event), c.req.param("run")),
      ),
    );
    if (saved.some((result) => result.meta.changes !== 1))
      throw new HTTPException(429, {
        message: "This run has reached its event limit. Open the root URL to start a new run.",
      });
    return c.json({ ok: true });
  });
  app.get("/api/runs/:run/report", async (c) => {
    const after = z.coerce
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER)
      .parse(c.req.query("after") || "0");
    const { results } = await c.env.DB.prepare(
      "SELECT id,received_at,event FROM probe_events WHERE run_id=? AND id>? ORDER BY id LIMIT 100",
    )
      .bind(c.req.param("run"), after)
      .all<{ id: number; received_at: number; event: string }>();
    return c.json({
      events: results.map((row) => ({
        ...eventSchema.parse(JSON.parse(row.event)),
        id: row.id,
        receivedAt: row.received_at,
      })),
    });
  });
  app.get("/api/context", (c) => {
    const names = [
      "user-agent",
      "referer",
      "sec-fetch-dest",
      "sec-fetch-mode",
      "sec-fetch-site",
      "sec-fetch-user",
      "accept-language",
    ];
    const headers = Object.fromEntries(
      names.map((name) => {
        let value = c.req.header(name) || null;
        if (name === "referer" && value) {
          try {
            value = new URL(value).origin;
          } catch {
            value = "invalid";
          }
        }
        return [name, value];
      }),
    );
    return c.json({ headers });
  });
  for (const route of [
    "/",
    "/play",
    "/test/:run",
    "/popup/:run",
    "/complete/:run",
    "/return/:run",
  ]) {
    app.get(route, async (c) => {
      if (c.req.param("run") && !runIdSchema.safeParse(c.req.param("run")).success)
        return c.text("Invalid run", 400);
      const response = await c.env.ASSETS.fetch(new Request(new URL("/webview.html", c.req.url)));
      const html = new HTMLRewriter()
        .on("meta", {
          element(element) {
            const content = element.getAttribute("content");
            if (content?.includes("__ORIGIN__"))
              element.setAttribute("content", content.replaceAll("__ORIGIN__", c.env.APP_ORIGIN));
          },
        })
        .on("#probe-config", {
          element(element) {
            element.setInnerContent(
              JSON.stringify({ origin: c.env.APP_ORIGIN, hopOrigin: c.env.HOP_ORIGIN }).replace(
                /</g,
                "\\u003c",
              ),
              { html: true },
            );
          },
        })
        .transform(response);
      return new Response(html.body, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    });
  }
  for (const route of ["/assets/*", "/favicon.png", "/webview-card.png"])
    app.get(route, (c) => c.env.ASSETS.fetch(c.req.raw));
  return app;
}
const app = createWebviewProbe();
export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledController, env: ProbeBindings) {
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        "DELETE FROM probe_events WHERE run_id IN (SELECT id FROM probe_runs WHERE expires_at < ?)",
      ).bind(now),
      env.DB.prepare("DELETE FROM probe_runs WHERE expires_at < ?").bind(now),
    ]);
  },
} satisfies ExportedHandler<ProbeBindings>;
