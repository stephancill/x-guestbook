import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { bodyLimit } from "hono/body-limit";
import { DEFAULT_ROOM, roomSchema } from "../src/schema";
import { createAuth } from "./auth";
import { guestbook } from "./guestbook";
import type { Bindings } from "./shared";
import { createEmbedAccess, FRAME_ANCESTORS, requireEmbedAccess } from "./embed";

export function createApp({ providerFetch }: { providerFetch?: typeof fetch } = {}) {
  const app = new Hono<{ Bindings: Bindings }>();

  app.use("*", async (c, next) => {
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "strict-origin-when-cross-origin");
    await next();
  });
  app.use("/api/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  });
  app.use("/api/*", bodyLimit({ maxSize: 4096 }));
  app.use("/api/*", async (c, next) => {
    if (c.req.path !== "/api/auth/authorize") await requireEmbedAccess({ c });
    await next();
  });
  app.use("/auth/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    c.header("Referrer-Policy", "no-referrer");
    await next();
  });
  app.onError((error, c) => {
    if (error instanceof HTTPException) return c.json({ error: error.message }, error.status);
    console.error("Request failed", error.name);
    return c.json({ error: "The server could not complete this request. Please try again." }, 500);
  });
  app.route("/", createAuth({ providerFetch }));
  app.route("/", guestbook);

  app.get("/about", async (c) => {
    const response = await c.env.ASSETS.fetch(new Request(new URL("/about.html", c.req.url)));
    return new Response(response.body, {
      status: response.status,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy": `default-src 'self'; style-src 'self'; img-src 'self'; frame-ancestors ${FRAME_ANCESTORS}; base-uri 'none'; object-src 'none'`,
      },
    });
  });

  for (const path of ["/auth/launch", "/auth/done"]) {
    app.get(path, async (c) => {
      const response = await c.env.ASSETS.fetch(new Request(new URL("/auth.html", c.req.url)));
      c.header("Cache-Control", "no-store");
      c.header("Referrer-Policy", "no-referrer");
      c.header(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'",
      );
      return response;
    });
  }

  for (const route of ["/", "/r/:room", "/play/:room"]) {
    app.get(route, async (c) => {
      const parsed = roomSchema.safeParse(c.req.param("room") || DEFAULT_ROOM);
      if (!parsed.success) return c.text("Invalid room", 400);
      const room = parsed.data;
      const origin = c.env.APP_ORIGIN;
      const embedToken = await createEmbedAccess({ c });
      const config = JSON.stringify({ room, embedToken }).replace(/</g, "\\u003c");
      const template = await c.env.ASSETS.fetch(new Request(new URL("/index.html", origin)));
      if (!template.ok) return c.text("App template could not be loaded", 500);
      const rewriter = new HTMLRewriter()
        .on("meta", {
          element(element) {
            const content = element.getAttribute("content");
            if (content?.includes("__ORIGIN__")) {
              element.setAttribute(
                "content",
                content.replaceAll("__ORIGIN__", origin).replaceAll("__ROOM__", room),
              );
            }
          },
        })
        .on("#app-config", {
          element(element) {
            element.setInnerContent(config, { html: true });
          },
        });
      const html = rewriter.transform(template);
      return new Response(html.body, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "Content-Security-Policy": `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' https://pbs.twimg.com; connect-src 'self'; frame-ancestors ${FRAME_ANCESTORS}; base-uri 'none'; object-src 'none'`,
        },
      });
    });
  }

  app.get("/assets/*", (c) => c.env.ASSETS.fetch(c.req.raw));
  app.get("/card.png", (c) => c.env.ASSETS.fetch(c.req.raw));
  app.get("/favicon.png", (c) => c.env.ASSETS.fetch(c.req.raw));
  return app;
}

export default createApp();
