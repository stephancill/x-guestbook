import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import { devices, webkit } from "playwright";
import type { Browser } from "playwright";
import { createWebviewProbe } from "../worker/webview";
import { runSchema, reportSchema } from "../src/webview-schema";

const origin = "https://x-webview.test",
  hopOrigin = "https://x-webview-hop.test";
const mf = new Miniflare({
  modules: true,
  script: 'export default {fetch(){return new Response("test");}}',
  d1Databases: ["DB"],
});
const app = createWebviewProbe();
let DB: D1Database;
let browser: Browser;
const assets = {
  fetch: async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const file = Bun.file(new URL(`../dist${url.pathname}`, import.meta.url));
    if (!(await file.exists())) return new Response("", { status: 404 });
    return new Response(await file.text(), {
      headers: {
        "content-type": url.pathname.endsWith(".html")
          ? "text/html"
          : url.pathname.endsWith(".css")
            ? "text/css"
            : "application/javascript",
      },
    });
  },
} as unknown as Fetcher;
function serve({ request }: { request: Request }) {
  return app.fetch(request, { DB, ASSETS: assets, APP_ORIGIN: origin, HOP_ORIGIN: hopOrigin });
}
beforeAll(async () => {
  DB = (await mf.getD1Database("DB")) as unknown as D1Database;
  const migration = await Bun.file(
    new URL("../migrations-webview/0001_probe.sql", import.meta.url),
  ).text();
  for (const statement of migration.split(";").filter((value) => value.trim()))
    await DB.prepare(statement).run();
  browser = await webkit.launch();
}, 30000);
beforeEach(async () => {
  await DB.batch([DB.prepare("DELETE FROM probe_events"), DB.prepare("DELETE FROM probe_runs")]);
});
afterAll(async () => {
  await browser?.close();
  await mf.dispose();
});
async function newRun() {
  const response = await serve({
    request: new Request(`${origin}/api/runs`, { method: "POST", headers: { origin } }),
  });
  expect(response.status).toBe(200);
  return runSchema.parse(await response.json());
}
test("probe reports require a private unexpired run credential and bounded validated events", async () => {
  const run = await newRun();
  expect(
    (await serve({ request: new Request(`${origin}/api/runs/${run.id}/report`) })).status,
  ).toBe(403);
  const headers = {
    origin,
    authorization: `Bearer ${run.token}`,
    "content-type": "application/json",
  };
  const event = {
    page: crypto.randomUUID(),
    stage: "viewer",
    type: "context.loaded",
    at: Date.now(),
    data: { opener: false },
  };
  expect(
    (
      await serve({
        request: new Request(`${origin}/api/runs/${run.id}/events`, {
          method: "POST",
          headers,
          body: JSON.stringify({ events: [event] }),
        }),
      })
    ).status,
  ).toBe(200);
  const response = await serve({
    request: new Request(`${origin}/api/runs/${run.id}/report`, { headers }),
  });
  const report = reportSchema.parse(await response.json());
  expect(report.events).toHaveLength(1);
  expect(report.events[0].data).toEqual({ opener: false });
  expect(JSON.stringify(report)).not.toContain(run.token);
  expect(
    (
      await serve({
        request: new Request(`${origin}/api/runs/${run.id}/events`, {
          method: "POST",
          headers,
          body: JSON.stringify({ events: [{ ...event, page: "bad" }] }),
        }),
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await serve({
        request: new Request(`${origin}/api/runs/${run.id}/events`, {
          method: "POST",
          headers: { ...headers, origin: "https://other.test" },
          body: JSON.stringify({ events: [event] }),
        }),
      })
    ).status,
  ).toBe(403);
  await DB.prepare("UPDATE probe_runs SET expires_at=0 WHERE id=?").bind(run.id).run();
  expect(
    (await serve({ request: new Request(`${origin}/api/runs/${run.id}/report`, { headers }) }))
      .status,
  ).toBe(403);
});
test("probe share metadata uses its separate HTTPS player and origin", async () => {
  const response = await serve({ request: new Request(origin) });
  const html = await response.text();
  expect(html).toContain(`content="${origin}/play"`);
  expect(html).toContain('content="480"');
  expect(response.headers.get("content-security-policy")).toContain(
    "frame-ancestors https://x.com",
  );
  expect(html).not.toContain("guestbook.stupidtech.net");
});
async function mobile() {
  const context = await browser.newContext({ ...devices["iPhone 13"] });
  await context.route("**/*", async (route) => {
    const request = route.request();
    const response = await serve({
      request: new Request(request.url(), {
        method: request.method(),
        headers: await request.allHeaders(),
        body: request.postData() || undefined,
      }),
    });
    await route.fulfill({
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body: await response.text(),
    });
  });
  const page = await context.newPage();
  await page.goto(origin);
  await page.locator("#manual[href]").waitFor();
  return { context, page };
}
test("mobile probe records an openerless cross-origin completion before auto-closing", async () => {
  const { context, page } = await mobile();
  try {
    const [popup] = await Promise.all([
      context.waitForEvent("page"),
      page.locator("#auto-close").click(),
    ]);
    await popup.locator("#cross-origin[href]").waitFor();
    await Promise.all([popup.waitForEvent("close"), popup.locator("#cross-origin").click()]);
    await page.bringToFront();
    await page.locator("#probe-status").filter({ hasText: "1 completion(s) detected" }).waitFor();
    const report = JSON.parse(await page.locator("#report").innerText());
    const completion = report.events.find(
      (event: { type: string }) => event.type === "flow.complete",
    );
    expect(completion.data.crossOriginHop).toBe(true);
    expect(completion.data.opener.present).toBe(false);
    expect(report.events.some((event: { type: string }) => event.type === "close.requested")).toBe(
      true,
    );
    const token = new URL(page.url()).hash.slice(1);
    expect(await page.locator("#report").innerText()).not.toContain(token);
  } finally {
    await context.close();
  }
}, 30000);
test("mobile probe observes opener messaging and same-view automatic return", async () => {
  const { context, page } = await mobile();
  try {
    const [popup] = await Promise.all([
      context.waitForEvent("page"),
      page.locator("#with-opener").click(),
    ]);
    await popup.locator("#finish[href]").waitFor();
    await popup.locator("#finish").click();
    await popup.locator("#complete").waitFor({ state: "visible" });
    await page.locator("#report").filter({ hasText: '"recognized": true' }).waitFor();
    expect(await popup.evaluate(() => Boolean(window.opener))).toBe(true);
    await popup.close();
    await page.bringToFront();
    await page.locator("#same-view").click();
    await page.locator("#finish[href]").waitFor();
    await page.locator("#finish").click();
    await page.locator("#viewer").waitFor({ state: "visible" });
    await page.locator("#probe-status").filter({ hasText: "2 completion(s) detected" }).waitFor();
    expect(context.pages()).toHaveLength(1);
  } finally {
    await context.close();
  }
}, 30000);
