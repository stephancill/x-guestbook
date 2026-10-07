import { afterAll, beforeAll, expect, test } from "bun:test";
import { devices, webkit } from "playwright";
import type { Browser } from "playwright";

const origin = "https://guestbook.stupidtech.net";
let browser: Browser;
beforeAll(async () => {
  browser = await webkit.launch();
}, 30000);
afterAll(async () => {
  await browser?.close();
});

async function mobileHarness({
  stopAtLaunch = false,
  cardSize = { width: 390, height: 480 },
  signedIn = false,
  entryCount = 0,
  standalone = false,
  standalonePath = "/",
}: {
  stopAtLaunch?: boolean;
  cardSize?: { width: number; height: number };
  signedIn?: boolean;
  entryCount?: number;
  standalone?: boolean;
  standalonePath?: string;
} = {}) {
  const context = await browser.newContext({ ...devices["iPhone 13"] });
  if (signedIn)
    await context.addInitScript(() => {
      if (location.hostname === "guestbook.stupidtech.net")
        localStorage.setItem("guestbook.session", "S".repeat(43));
    });
  const page = await context.newPage();
  const model = {
    starts: 0,
    cancels: 0,
    complete: false,
    phase: "pending",
    stopAtLaunch,
    state: "",
    failed: false,
  };
  const profile = { id: "123456789", username: "mobile_guest", name: "Mobile Guest", avatar: null };
  const main = await Bun.file(new URL("../dist/index.html", import.meta.url)).text();
  const auth = await Bun.file(new URL("../dist/auth.html", import.meta.url)).text();
  const mainWithConfig = main.replace(
    /(<script id="app-config" type="application\/json">)[\s\S]*?(<\/script>)/,
    `$1${JSON.stringify({ room: "mobile-test", embedToken: "E".repeat(43) })}$2`,
  );
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    const json = (value: unknown) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(value) });
    if (url.hostname === "x.com" && url.pathname === "/mobile-guestbook-test") {
      return route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><iframe title="Guestbook" width="${cardSize.width}" height="${cardSize.height}" src="${origin}/play/mobile-test" sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"></iframe></body></html>`,
      });
    }
    if (url.hostname === "x.com" && url.pathname === "/i/oauth2/authorize") {
      return route.fulfill({
        contentType: "text/html",
        body: `<h1>X authorization opened</h1><a id="authorize" href="${origin}/auth/callback?state=${model.state}&code=test-code">Authorize</a><a id="deny" href="${origin}/auth/callback?state=${model.state}&error=access_denied">Decline</a>`,
      });
    }
    if (url.origin !== origin) return route.fulfill({ status: 404, body: "" });
    if (
      url.pathname === "/play/mobile-test" ||
      url.pathname === "/r/mobile-test" ||
      url.pathname === "/"
    )
      return route.fulfill({ contentType: "text/html", body: mainWithConfig });
    if (url.pathname.startsWith("/assets/")) {
      const asset = Bun.file(new URL(`../dist${url.pathname}`, import.meta.url));
      return route.fulfill({
        contentType: url.pathname.endsWith(".css") ? "text/css" : "application/javascript",
        body: await asset.text(),
      });
    }
    if (url.pathname === "/auth/launch" || url.pathname === "/auth/done") {
      return route.fulfill({
        contentType: "text/html",
        body: model.stopAtLaunch ? "<h1>Stopped before authorization</h1>" : auth,
      });
    }
    if (url.pathname === "/auth/callback") {
      model.failed = Boolean(url.searchParams.get("error"));
      model.complete = !model.failed;
      return route.fulfill({
        contentType: "text/html",
        // WebKit's route interception cannot fulfill redirects; emulate the callback navigation.
        body: `<script>location.replace(${JSON.stringify(`${origin}/auth/done?result=${model.failed ? "failed" : "success"}&state=${model.state}`)})</script>`,
      });
    }
    if (url.pathname === "/api/book/mobile-test")
      return json(
        route.request().method() === "POST"
          ? { ok: true }
          : {
              entries: Array.from({ length: entryCount }, (_, index) => ({
                ...profile,
                id: String(index + 1),
                message: entryCount === 1 ? "" : "A long guestbook message 👋 ".repeat(8),
                signedAt: Date.now() - index * 60000,
              })),
              configured: true,
            },
      );
    if (url.pathname === "/api/auth/start") {
      model.starts++;
      model.phase = "pending";
      model.complete = false;
      model.failed = false;
      const state = String(model.starts).padStart(43, "a");
      model.state = state;
      return json({
        state,
        pollToken: "P".repeat(43),
        loginUrl: `${origin}/auth/launch#${new URLSearchParams({ state, launchToken: "L".repeat(43) })}`,
        expiresAt: Date.now() + 600000,
      });
    }
    if (url.pathname === "/api/auth/authorize") {
      model.phase = "authorizing";
      return json({ url: "https://x.com/i/oauth2/authorize?test=mobile" });
    }
    if (url.pathname === "/api/auth/status") {
      return json(
        model.failed
          ? { status: "failed", error: "X authorization was declined. You can try again." }
          : model.complete
            ? { status: "complete", sessionToken: "S".repeat(43), user: profile }
            : { status: "pending", phase: model.phase },
      );
    }
    if (url.pathname === "/api/auth/cancel") {
      model.cancels++;
      return json({ ok: true });
    }
    if (url.pathname === "/api/me") return json({ user: profile });
    if (url.pathname === "/api/logout") return json({ ok: true });
    return route.fulfill({ status: 404, body: "" });
  });
  await page.goto(
    standalone ? `${origin}${standalonePath}` : "https://x.com/mobile-guestbook-test",
  );
  const frame = standalone ? page : page.frameLocator("iframe");
  await frame.locator(signedIn ? "#signed-in" : "#signin[href]").waitFor({ state: "visible" });
  return { context, page, frame, model };
}

test("iPhone WebKit opens the prepared OAuth link directly and resumes polling after page restoration", async () => {
  const { context, page, frame, model } = await mobileHarness();
  try {
    expect(model.starts).toBe(1);
    const [popup] = await Promise.all([
      context.waitForEvent("page"),
      frame.getByRole("link", { name: "Sign in with X", exact: true }).click(),
    ]);
    await popup.waitForURL("https://x.com/i/oauth2/authorize?test=mobile");
    expect(model.starts).toBe(1);
    expect(popup.url()).not.toContain("/auth/wait");
    await frame
      .locator("html")
      .evaluate(() =>
        window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })),
      );
    model.complete = true;
    await popup.close();
    await page.bringToFront();
    await frame
      .locator("html")
      .evaluate(() =>
        window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })),
      );
    await frame.locator("#signed-in").waitFor({ state: "visible" });
    expect(await frame.locator("#who").innerText()).toBe("Signed in as @mobile_guest");
    expect(
      await frame.getByRole("button", { name: "Sign the book", exact: true }).isVisible(),
    ).toBe(true);
  } finally {
    await context.close();
  }
}, 30000);

test("standalone mobile guestbook returns automatically from cross-origin OAuth in the same viewer", async () => {
  const { context, page, frame, model } = await mobileHarness({ standalone: true, entryCount: 20 });
  try {
    expect(await page.locator("body").getAttribute("class")).toContain("standalone");
    expect(await page.locator("#entries li").count()).toBe(20);
    expect(await page.evaluate(() => document.referrer)).toBe("");
    await frame.getByRole("link", { name: "Sign in with X", exact: true }).click();
    await page.waitForURL("https://x.com/i/oauth2/authorize?test=mobile");
    expect(context.pages()).toHaveLength(1);
    await page.locator("#authorize").click();
    await page.waitForURL(`${origin}/`);
    await frame.locator("#signed-in").waitFor({ state: "visible" });
    expect(model.starts).toBe(1);
    expect(await page.evaluate(() => localStorage.getItem("guestbook.session"))).toBe(
      "S".repeat(43),
    );
    expect(await page.evaluate(() => sessionStorage.getItem("guestbook.pending"))).toBe(null);
    expect(await page.evaluate(() => sessionStorage.getItem("guestbook.auth-return"))).toBe(null);
    await frame.locator("#message").fill("Hello from a normal page");
    await frame.locator("#sign").click();
    await frame.locator("#status").filter({ hasText: "You signed the book" }).waitFor();
    expect(
      await frame.locator("#sign").evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return rect.top >= 0 && rect.bottom <= innerHeight;
      }),
    ).toBe(true);
  } finally {
    await context.close();
  }
}, 30000);

test("same-view OAuth returns to the original room and reports authorization rejection with retry", async () => {
  for (const standalonePath of ["/r/mobile-test", "/play/mobile-test"]) {
    const { context, page, model } = await mobileHarness({ standalone: true, standalonePath });
    try {
      await page.locator("#signin").click();
      await page.waitForURL("https://x.com/i/oauth2/authorize?test=mobile");
      await page.locator("#deny").click();
      await page.waitForURL(`${origin}${standalonePath}`);
      await page.locator("#status").filter({ hasText: "X authorization was declined" }).waitFor();
      await page.getByRole("link", { name: "Sign in with X", exact: true }).waitFor();
      expect(model.starts).toBe(2);
      expect(context.pages()).toHaveLength(1);
      await page.locator("#signin").click();
      await page.waitForURL("https://x.com/i/oauth2/authorize?test=mobile");
      await page.locator("#authorize").click();
      await page.waitForURL(`${origin}${standalonePath}`);
      await page.locator("#signed-in").waitFor({ state: "visible" });
    } finally {
      await context.close();
    }
  }
}, 30000);

test("same-view sign-in refuses missing storage and external callback return targets", async () => {
  const { context, page, model } = await mobileHarness({ standalone: true });
  try {
    await page.evaluate(() => {
      Storage.prototype.setItem = () => {
        throw new DOMException("Blocked", "SecurityError");
      };
    });
    await page.locator("#signin").click();
    expect(page.url()).toBe(`${origin}/`);
    expect(await page.locator("#status").innerText()).toContain("session storage is required");
    await page.reload();
    await page.locator("#signin[href]").waitFor();
    await page.evaluate(
      ({ state }) => {
        sessionStorage.setItem(
          "guestbook.auth-return",
          JSON.stringify({ state, path: "https://other.test/", expiresAt: Date.now() + 600000 }),
        );
      },
      { state: model.state },
    );
    await page.goto(`${origin}/auth/done?result=success&state=${model.state}`);
    await page.locator("#auth-message").filter({ hasText: "return context is invalid" }).waitFor();
    expect(new URL(page.url()).pathname).toBe("/auth/done");
    expect(context.pages()).toHaveLength(1);
  } finally {
    await context.close();
  }
}, 30000);

test("square mobile cards keep signing and sharing controls inside the viewport as signatures grow", async () => {
  for (const size of [320, 360, 480]) {
    for (const entryCount of [1, 20]) {
      const { context, frame } = await mobileHarness({
        signedIn: true,
        entryCount,
        cardSize: { width: size, height: size },
      });
      try {
        const measure = () =>
          frame.locator("html").evaluate(() => {
            const controls = [
              "#message",
              "#sign",
              "#logout",
              "#copy-link",
              "#post",
              "#how-it-works",
            ].map((selector) => {
              const rect = document.querySelector(selector)!.getBoundingClientRect();
              return {
                selector,
                inside:
                  rect.top >= 0 &&
                  rect.left >= 0 &&
                  rect.bottom <= innerHeight &&
                  rect.right <= innerWidth,
              };
            });
            const entries = document.querySelector("#entries")!;
            return {
              controls,
              width: innerWidth,
              height: innerHeight,
              documentWidth: document.documentElement.scrollWidth,
              documentHeight: document.documentElement.scrollHeight,
              listHeight: entries.clientHeight,
              listScrollHeight: entries.scrollHeight,
            };
          });
        const initial = await measure();
        expect(initial.controls.filter((control) => !control.inside)).toEqual([]);
        expect(initial.documentWidth).toBe(initial.width);
        expect(initial.documentHeight).toBe(initial.height);
        expect(initial.listHeight).toBeGreaterThanOrEqual(32);
        if (entryCount > 1) {
          expect(initial.listScrollHeight).toBeGreaterThan(initial.listHeight);
          await frame.locator("#entries").evaluate((element) => {
            element.scrollTop = element.scrollHeight;
          });
          expect(
            await frame.locator("#entries li:last-child").evaluate((element) => {
              const list = element.parentElement!.getBoundingClientRect();
              const entry = element.getBoundingClientRect();
              return entry.bottom <= list.bottom + 1 && entry.bottom > list.top;
            }),
          ).toBe(true);
        }
        await frame.locator("#sign").click();
        await frame.locator("#status").filter({ hasText: "You signed the book" }).waitFor();
        const signed = await measure();
        expect(signed.controls.filter((control) => !control.inside)).toEqual([]);
        expect(signed.documentHeight).toBe(signed.height);
      } finally {
        await context.close();
      }
    }
  }
}, 30000);

test("iPhone WebKit can resume or cancel an unlaunched sign-in after the tab is closed and the card is refreshed", async () => {
  const { context, page, frame, model } = await mobileHarness({ stopAtLaunch: true });
  try {
    const [popup] = await Promise.all([
      context.waitForEvent("page"),
      frame.getByRole("link", { name: "Sign in with X", exact: true }).click(),
    ]);
    await popup.getByRole("heading", { name: "Stopped before authorization" }).waitFor();
    await popup.close();
    await page.bringToFront();
    await page.reload();
    await frame
      .getByRole("link", { name: "Continue sign-in", exact: true })
      .waitFor({ state: "visible" });
    expect(model.starts).toBe(1);
    await frame.getByRole("button", { name: "Cancel sign-in", exact: true }).click();
    await frame
      .getByRole("link", { name: "Sign in with X", exact: true })
      .waitFor({ state: "visible" });
    expect(model.cancels).toBe(1);
    expect(model.starts).toBe(2);
  } finally {
    await context.close();
  }
}, 30000);

test("old incomplete and expired mobile attempts no longer leave the card permanently waiting", async () => {
  const { context, page, frame, model } = await mobileHarness();
  try {
    await frame.locator("html").evaluate(() => {
      sessionStorage.setItem(
        "guestbook.pending",
        JSON.stringify({ state: "a".repeat(43), pollToken: "P".repeat(43) }),
      );
    });
    await page.reload();
    await frame
      .getByRole("link", { name: "Sign in with X", exact: true })
      .waitFor({ state: "visible" });
    expect(await frame.locator("#status").innerText()).toContain("interrupted");
    await frame.locator("html").evaluate(
      (_element, { origin }) => {
        sessionStorage.setItem(
          "guestbook.pending",
          JSON.stringify({
            state: "a".repeat(43),
            pollToken: "P".repeat(43),
            loginUrl: origin + "/auth/launch#state=test",
            expiresAt: Date.now() - 1000,
          }),
        );
      },
      { origin },
    );
    await page.reload();
    await frame
      .getByRole("link", { name: "Sign in with X", exact: true })
      .waitFor({ state: "visible" });
    expect(await frame.locator("#status").innerText()).toContain("expired");
    expect(model.starts).toBe(3);
  } finally {
    await context.close();
  }
}, 30000);
