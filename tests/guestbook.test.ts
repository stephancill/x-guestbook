import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import { z } from "zod";
import { createApp } from "../worker";
import { hash, randomSecret } from "../worker/shared";
import type { Bindings } from "../worker/shared";
import { appConfigSchema, bookSchema, pollSchema, startSchema } from "../src/schema";

const origin = "https://guestbook.test";
const mf = new Miniflare({
  modules: true,
  script: 'export default { fetch() { return new Response("test"); } }',
  d1Databases: ["DB"],
});
let env: Bindings;
let providerCalls: { url: string; body?: URLSearchParams; headers: Headers }[] = [];
let profileStatus = 200;
let embedToken = "";

const providerFetch: typeof fetch = Object.assign(
  async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    providerCalls.push({
      url,
      body: init?.body instanceof URLSearchParams ? init.body : undefined,
      headers: new Headers(init?.headers),
    });
    if (url.endsWith("/oauth2/token"))
      return Response.json({ access_token: "provider-token-never-returned-to-client" });
    if (profileStatus !== 200)
      return Response.json({ error: "Test error" }, { status: profileStatus });
    return Response.json({
      data: {
        id: "123456789",
        username: "guest",
        name: "Guest",
        profile_image_url: "https://pbs.twimg.com/profile_images/test.png",
      },
    });
  },
  { preconnect: fetch.preconnect },
);
const app = createApp({ providerFetch });

beforeAll(async () => {
  const template = await Bun.file(new URL("../dist/index.html", import.meta.url)).text();
  env = {
    DB: (await mf.getD1Database("DB")) as unknown as D1Database,
    APP_ORIGIN: origin,
    X_CLIENT_ID: "test-client",
    X_CLIENT_SECRET: "test-secret",
    ASSETS: { fetch: async () => new Response(template) } as unknown as Fetcher,
  };
  const migration = await Bun.file(
    new URL("../migrations/0001_guestbook.sql", import.meta.url),
  ).text();
  for (const statement of migration.split(";").filter((value) => value.trim()))
    await env.DB.prepare(statement).run();
  const embedMigration = await Bun.file(
    new URL("../migrations/0002_embed_access.sql", import.meta.url),
  ).text();
  for (const statement of embedMigration.split(";").filter((value) => value.trim()))
    await env.DB.prepare(statement).run();
});
beforeEach(async () => {
  providerCalls = [];
  profileStatus = 200;
  embedToken = randomSecret();
  await env.DB.prepare("INSERT INTO embed_access(token_hash, expires_at) VALUES (?, ?)")
    .bind(await hash({ value: embedToken }), Date.now() + 60000)
    .run();
  await env.DB.batch(
    ["entries", "sessions", "login_attempts", "users"].map((table) =>
      env.DB.prepare(`DELETE FROM ${table}`),
    ),
  );
});
afterAll(async () => {
  await mf.dispose();
});

function call({
  path,
  body,
  token,
  cookie,
  requestOrigin = origin,
}: {
  path: string;
  body?: unknown;
  token?: string;
  cookie?: string;
  requestOrigin?: string;
}) {
  const headers = new Headers({ origin: requestOrigin });
  headers.set("x-embed-token", embedToken);
  if (body !== undefined) headers.set("content-type", "application/json");
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (cookie) headers.set("cookie", cookie);
  return app.fetch(
    new Request(`${origin}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env,
  );
}

async function begin() {
  const response = await call({ path: "/api/auth/start", body: {} });
  expect(response.status).toBe(200);
  const attempt = startSchema.parse(await response.json());
  const launch = Object.fromEntries(new URLSearchParams(new URL(attempt.loginUrl).hash.slice(1)));
  const authorized = await call({ path: "/api/auth/authorize", body: launch });
  expect(authorized.status).toBe(200);
  const { url } = z.object({ url: z.string() }).parse(await authorized.json());
  const cookie = authorized.headers.get("set-cookie")!.split(";")[0];
  return {
    attempt,
    launch,
    url: new URL(url),
    cookie,
    poll: { state: attempt.state, pollToken: attempt.pollToken },
  };
}

async function finish({ login }: { login: Awaited<ReturnType<typeof begin>> }) {
  const response = await call({
    path: `/auth/callback?state=${login.attempt.state}&code=test-code`,
    cookie: login.cookie,
  });
  expect(response.status).toBe(302);
  expect(new URL(response.headers.get("location")!).searchParams.get("state")).toBe(
    login.attempt.state,
  );
  const result = pollSchema.parse(
    await (await call({ path: "/api/auth/status", body: login.poll })).json(),
  );
  if (result.status !== "complete") throw new Error(`Unexpected status ${result.status}`);
  return result;
}

test("PKCE and secrets bind sign-in to its browser and card, with single-use launch and callback", async () => {
  const login = await begin();
  expect(login.url.searchParams.get("scope")).toBe("tweet.read users.read");
  expect(login.url.searchParams.get("redirect_uri")).toBe(`${origin}/auth/callback`);
  expect(login.url.searchParams.get("code_challenge_method")).toBe("S256");
  const row = await env.DB.prepare("SELECT * FROM login_attempts WHERE state=?")
    .bind(login.attempt.state)
    .first<{ verifier: string; poll_hash: string }>();
  expect(login.url.searchParams.get("code_challenge")).toBe(await hash({ value: row!.verifier }));
  expect(row!.poll_hash).not.toBe(login.attempt.pollToken);
  expect((await call({ path: "/api/auth/authorize", body: login.launch })).status).toBe(400);
  expect((await call({ path: "/api/auth/status", body: login.poll })).status).toBe(200);
  expect(
    (await call({ path: "/api/auth/status", body: { ...login.poll, pollToken: randomSecret() } }))
      .status,
  ).toBe(404);
  expect(
    (await call({ path: `/auth/callback?state=${login.attempt.state}&code=test-code` })).status,
  ).toBe(400);
  const session = await finish({ login });
  expect(
    (
      await call({
        path: `/auth/callback?state=${login.attempt.state}&code=test-code`,
        cookie: login.cookie,
      })
    ).status,
  ).toBe(400);
  expect(providerCalls).toHaveLength(2);
  expect(providerCalls[0].body!.get("code_verifier")).toBe(row!.verifier);
  expect(providerCalls[0].headers.get("authorization")).toBe(
    `Basic ${btoa("test-client:test-secret")}`,
  );
  expect(session.user.username).toBe("guest");
  expect(JSON.stringify(session)).not.toContain("provider-token");
  expect(
    (await env.DB.prepare("SELECT token_hash FROM sessions").first<{ token_hash: string }>())!
      .token_hash,
  ).toBe(await hash({ value: session.sessionToken }));
});

test("only verified sessions can sign; profile cannot be spoofed; entries persist and update once per account/book; logout revokes", async () => {
  expect((await call({ path: "/api/book/demo", body: { message: "Hi" } })).status).toBe(401);
  const session = await finish({ login: await begin() });
  expect(
    (
      await call({
        path: "/api/book/demo",
        token: session.sessionToken,
        body: { message: "Hi", username: "imposter" },
      })
    ).status,
  ).toBe(400);
  expect(
    (await call({ path: "/api/book/demo", token: session.sessionToken, body: { message: "Hi" } }))
      .status,
  ).toBe(200);
  expect(
    (
      await call({
        path: "/api/book/demo",
        token: session.sessionToken,
        body: { message: "Updated <script>text</script>" },
      })
    ).status,
  ).toBe(200);
  const book = bookSchema.parse(await (await call({ path: "/api/book/demo" })).json());
  expect(book.entries).toHaveLength(1);
  expect(book.entries[0].username).toBe("guest");
  expect(book.entries[0].message).toBe("Updated <script>text</script>");
  expect((await call({ path: "/api/book/other" })).status).toBe(200);
  expect(
    bookSchema.parse(await (await call({ path: "/api/book/other" })).json()).entries,
  ).toHaveLength(0);
  expect((await call({ path: "/api/logout", body: {}, token: session.sessionToken })).status).toBe(
    200,
  );
  expect((await call({ path: "/api/me", token: session.sessionToken })).status).toBe(401);
});

test("authorization rejection and failed profile lookup surface actionable errors without issuing sessions", async () => {
  const rejected = await begin();
  await call({
    path: `/auth/callback?state=${rejected.attempt.state}&error=access_denied`,
    cookie: rejected.cookie,
  });
  const failure = pollSchema.parse(
    await (await call({ path: "/api/auth/status", body: rejected.poll })).json(),
  );
  expect(failure.status).toBe("failed");
  expect(providerCalls).toHaveLength(0);
  profileStatus = 402;
  const unavailable = await begin();
  await call({
    path: `/auth/callback?state=${unavailable.attempt.state}&code=test-code`,
    cookie: unavailable.cookie,
  });
  const result = pollSchema.parse(
    await (await call({ path: "/api/auth/status", body: unavailable.poll })).json(),
  );
  expect(result.status).toBe("failed");
  if (result.status === "failed") expect(result.error).toContain("HTTP 402");
  expect(
    (await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions").first<{ n: number }>())!.n,
  ).toBe(0);
});

test("expired attempts, invalid origins and malformed requests are rejected", async () => {
  expect(
    (await call({ path: "/api/auth/start", body: {}, requestOrigin: "https://other.test" })).status,
  ).toBe(403);
  expect((await call({ path: "/api/auth/status", body: { state: "bad" } })).status).toBe(400);
  const login = await begin();
  await env.DB.prepare("UPDATE login_attempts SET expires_at=0 WHERE state=?")
    .bind(login.attempt.state)
    .run();
  expect(
    pollSchema.parse(await (await call({ path: "/api/auth/status", body: login.poll })).json())
      .status,
  ).toBe("failed");
  expect(
    (
      await call({
        path: `/auth/callback?state=${login.attempt.state}&code=test-code`,
        cookie: login.cookie,
      })
    ).status,
  ).toBe(400);
  expect(providerCalls).toHaveLength(0);
});

test("prepared attempts report launch progress and can be cancelled without accepting later callbacks", async () => {
  const attempt = startSchema.parse(
    await (await call({ path: "/api/auth/start", body: {} })).json(),
  );
  expect(attempt.expiresAt).toBeGreaterThan(Date.now());
  const poll = { state: attempt.state, pollToken: attempt.pollToken };
  const initial = pollSchema.parse(
    await (await call({ path: "/api/auth/status", body: poll })).json(),
  );
  expect(initial).toEqual({ status: "pending", phase: "pending" });
  await call({
    path: "/api/auth/cancel",
    body: { state: attempt.state, pollToken: randomSecret() },
  });
  expect(
    pollSchema.parse(await (await call({ path: "/api/auth/status", body: poll })).json()),
  ).toEqual(initial);
  expect((await call({ path: "/api/auth/cancel", body: poll })).status).toBe(200);
  expect(
    pollSchema.parse(await (await call({ path: "/api/auth/status", body: poll })).json()).status,
  ).toBe("failed");
  const launch = Object.fromEntries(new URLSearchParams(new URL(attempt.loginUrl).hash.slice(1)));
  expect((await call({ path: "/api/auth/authorize", body: launch })).status).toBe(400);

  const login = await begin();
  expect(
    pollSchema.parse(await (await call({ path: "/api/auth/status", body: login.poll })).json()),
  ).toEqual({ status: "pending", phase: "authorizing" });
  await call({ path: "/api/auth/cancel", body: login.poll });
  expect(
    (
      await call({
        path: `/auth/callback?state=${login.attempt.state}&code=test-code`,
        cookie: login.cookie,
      })
    ).status,
  ).toBe(400);
  expect(providerCalls).toHaveLength(0);
});

test("guestbook APIs require an unexpired page credential", async () => {
  expect((await app.fetch(new Request(`${origin}/api/book/demo`), env)).status).toBe(403);
  expect(
    (
      await app.fetch(
        new Request(`${origin}/api/auth/start`, { method: "POST", headers: { origin } }),
        env,
      )
    ).status,
  ).toBe(403);
  await env.DB.prepare("UPDATE embed_access SET expires_at=0 WHERE token_hash=?")
    .bind(await hash({ value: embedToken }))
    .run();
  expect((await call({ path: "/api/book/demo" })).status).toBe(403);
});

test("root, room and player pages support direct visits without X referrer headers and retain Player Card metadata", async () => {
  for (const path of ["/", "/r/demo", "/play/demo"]) {
    const page = await app.fetch(new Request(`${origin}${path}`), env);
    expect(page.status).toBe(200);
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect(page.headers.get("content-security-policy")).toContain("frame-ancestors https://x.com");
    const html = await page.text();
    expect(html).toContain('id="signin"');
    expect(html).toContain('src="/assets/main-');
    expect(html).not.toContain("available only inside an X post");
    const config = appConfigSchema.parse(
      JSON.parse(
        html.match(/<script id="app-config" type="application\/json">([\s\S]*?)<\/script>/)![1],
      ),
    );
    expect(config.room).toBe(path === "/" ? "poc-1" : "demo");
    expect(html).toContain(`content="${origin}/play/${config.room}"`);
    const headers = {
      "x-embed-token": config.embedToken,
      origin,
      "content-type": "application/json",
    };
    expect(
      (await app.fetch(new Request(`${origin}/api/book/${config.room}`, { headers }), env)).status,
    ).toBe(200);
    expect(
      (
        await app.fetch(
          new Request(`${origin}/api/book/${config.room}`, {
            method: "POST",
            headers,
            body: JSON.stringify({ message: "Hello" }),
          }),
          env,
        )
      ).status,
    ).toBe(401);
  }
});

test("simultaneous polling can claim a completed login only once", async () => {
  const login = await begin();
  await call({
    path: `/auth/callback?state=${login.attempt.state}&code=test-code`,
    cookie: login.cookie,
  });
  const responses = await Promise.all([
    call({ path: "/api/auth/status", body: login.poll }),
    call({ path: "/api/auth/status", body: login.poll }),
  ]);
  const data = await Promise.all(responses.map((response) => response.json()));
  expect(
    data.filter((result) => (result as { status?: string }).status === "complete"),
  ).toHaveLength(1);
  expect(
    (await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions").first<{ n: number }>())!.n,
  ).toBe(1);
});
