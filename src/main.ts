import "./style.css";
import { z } from "zod";
import {
  appConfigSchema,
  AUTH_RETURN_KEY,
  authReturnSchema,
  bookSchema,
  pollSchema,
  profileSchema,
  secretSchema,
  startSchema,
} from "./schema";
import { element, request, setEmbedToken } from "./api";
import { relativeTime } from "./time";

const framed = window.top !== window;
const config = appConfigSchema.parse(
  JSON.parse(element({ id: "app-config" }).textContent || "null"),
);
document.body.classList.add(framed ? "embedded" : "standalone");
element<HTMLAnchorElement>({ id: "how-it-works" }).target = framed ? "_blank" : "_self";
setEmbedToken({ token: config.embedToken });
const room = config.room;
const shareUrl = new URL("/", location.origin).href;
const status = element({ id: "status" });
const signin = element<HTMLAnchorElement>({ id: "signin" });
const resumeSignin = element<HTMLAnchorElement>({ id: "resume-signin" });
const cancelSignin = element<HTMLButtonElement>({ id: "cancel-signin" });
const message = element<HTMLTextAreaElement>({ id: "message" });
const sign = element<HTMLButtonElement>({ id: "sign" });
const okSchema = z.object({ ok: z.literal(true) });
let sessionToken: string | null = null;
let user: z.infer<typeof profileSchema> | null = null;
let configured = false;
let readyAttempt: z.infer<typeof startSchema> | null = null;
let pending: z.infer<typeof startSchema> | null = null;
let pendingPhase: "pending" | "authorizing" | "exchanging" = "pending";
let preparing: Promise<void> | null = null;
let polling: Promise<void> | null = null;
let loginGeneration = 0;
let initialized = false;
let pageActive = true;
let pollController: AbortController | null = null;
let pollTimer: ReturnType<typeof setTimeout> | undefined;
let refreshTimer: ReturnType<typeof setInterval> | undefined;

element<HTMLAnchorElement>({
  id: "post",
}).href = `https://x.com/intent/post?text=${encodeURIComponent("Sign my guestbook 👋")}&url=${encodeURIComponent(shareUrl)}`;

function showError({ error }: { error: unknown }) {
  if (error instanceof Error && "status" in error && error.status === 401) {
    sessionToken = null;
    user = null;
    storeSession();
    renderUser();
  }
  status.textContent =
    error instanceof Error ? error.message : "Something went wrong. Please try again.";
}

function renderUser() {
  signin.target = resumeSignin.target = framed ? "_blank" : "_self";
  signin.hidden = Boolean(user);
  const attempt = readyAttempt || pending;
  if (attempt) signin.href = attempt.loginUrl;
  else signin.removeAttribute("href");
  signin.setAttribute("aria-disabled", String(!configured || Boolean(pending) || !readyAttempt));
  signin.textContent = pending
    ? "Waiting for X sign-in…"
    : readyAttempt
      ? "Sign in with X"
      : "Preparing sign-in…";
  element({ id: "signin-progress" }).hidden = !pending || Boolean(user);
  resumeSignin.hidden = !pending || pendingPhase !== "pending";
  if (pending) resumeSignin.href = pending.loginUrl;
  else resumeSignin.removeAttribute("href");
  element({ id: "retry-signin" }).hidden =
    !configured || Boolean(user) || Boolean(pending) || Boolean(readyAttempt) || Boolean(preparing);
  element({ id: "signed-in" }).hidden = !user;
  element({ id: "who" }).textContent = user ? `Signed in as @${user.username}` : "";
}

function storeSession() {
  try {
    if (sessionToken) localStorage.setItem("guestbook.session", sessionToken);
    else localStorage.removeItem("guestbook.session");
  } catch {
    if (sessionToken)
      status.textContent = "Signed in for this tab. Browser storage is unavailable.";
  }
}

async function loadBook() {
  const book = await request({ path: `/api/book/${room}`, schema: bookSchema });
  configured = book.configured;
  const list = element<HTMLUListElement>({ id: "entries" });
  list.replaceChildren();
  element({ id: "entry-count" }).textContent = book.entries.length
    ? `${book.entries.length}${book.entries.length === 100 ? "+" : ""} ${book.entries.length === 1 ? "signature" : "signatures"}`
    : "Be the first to sign this book.";
  for (const entry of book.entries) {
    const item = document.createElement("li");
    if (entry.avatar) {
      const avatar = document.createElement("img");
      avatar.src = entry.avatar;
      avatar.alt = "";
      avatar.width = avatar.height = 32;
      avatar.loading = "lazy";
      avatar.referrerPolicy = "no-referrer";
      item.append(avatar);
    }
    const content = document.createElement("div");
    const link = document.createElement("a");
    link.href = `https://x.com/${entry.username}`;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = `@${entry.username}`;
    const time = document.createElement("time");
    time.dateTime = new Date(entry.signedAt).toISOString();
    time.textContent = relativeTime({ timestamp: entry.signedAt });
    time.title = new Date(entry.signedAt).toLocaleString();
    time.className = "muted";
    content.append(link, " · ", time);
    if (entry.message) {
      const text = document.createElement("p");
      text.textContent = entry.message;
      content.append(text);
    }
    item.append(content);
    list.append(item);
  }
  if (!configured) status.textContent = "X sign-in is being configured. Please check back shortly.";
  renderUser();
}

function savePending() {
  try {
    if (pending) sessionStorage.setItem("guestbook.pending", JSON.stringify(pending));
    else sessionStorage.removeItem("guestbook.pending");
    return !pending || sessionStorage.getItem("guestbook.pending") === JSON.stringify(pending);
  } catch {
    /* Pending sign-in is kept in memory when storage is unavailable. */
    return false;
  }
}

function saveSameViewReturn() {
  if (!pending || !savePending())
    throw new Error(
      "Browser session storage is required to return from sign-in. Enable it and try again.",
    );
  const context = authReturnSchema.parse({
    state: pending.state,
    path: location.pathname,
    expiresAt: pending.expiresAt,
  });
  sessionStorage.setItem(AUTH_RETURN_KEY, JSON.stringify(context));
  if (sessionStorage.getItem(AUTH_RETURN_KEY) !== JSON.stringify(context))
    throw new Error("Could not save the sign-in return context. Please try again.");
}

async function pollLogin() {
  if (!pending || polling) return polling;
  clearTimeout(pollTimer);
  const attempt = pending;
  if (attempt.expiresAt <= Date.now()) {
    pending = null;
    savePending();
    renderUser();
    showError({ error: new Error("Sign-in expired. Please try again.") });
    return prepareLogin();
  }
  const generation = loginGeneration;
  const controller = new AbortController();
  pollController = controller;
  polling = (async () => {
    try {
      const result = await request({
        path: "/api/auth/status",
        body: { state: attempt.state, pollToken: attempt.pollToken },
        schema: pollSchema,
        signal: controller.signal,
      });
      if (generation !== loginGeneration) {
        if (result.status === "complete")
          await request({
            path: "/api/logout",
            body: {},
            sessionToken: result.sessionToken,
            schema: okSchema,
          });
        return;
      }
      if (result.status === "complete") {
        sessionToken = result.sessionToken;
        user = result.user;
        pending = null;
        savePending();
        status.textContent = `Welcome, @${user.username}. You can sign the book now.`;
        storeSession();
        renderUser();
        message.focus();
        return;
      }
      if (result.status === "failed") throw new Error(result.error);
      pendingPhase = result.phase;
      renderUser();
      if (!document.hidden)
        pollTimer = setTimeout(() => {
          void pollLogin();
        }, 1500);
    } catch (error) {
      if (generation !== loginGeneration) return;
      if (error instanceof Error && "network" in error && error.network === true) {
        if (!controller.signal.aborted) showError({ error });
        if (pageActive && !document.hidden)
          pollTimer = setTimeout(() => {
            void pollLogin();
          }, 3000);
        return;
      }
      pending = null;
      savePending();
      renderUser();
      showError({ error });
      void prepareLogin();
    } finally {
      polling = null;
      if (pollController === controller) pollController = null;
    }
  })();
  return polling;
}

function prepareLogin() {
  if (!configured || user || pending || readyAttempt || preparing) return preparing;
  const generation = loginGeneration;
  preparing = (async () => {
    try {
      const attempt = await request({ path: "/api/auth/start", body: {}, schema: startSchema });
      const url = new URL(attempt.loginUrl);
      if (url.origin !== location.origin || url.pathname !== "/auth/launch")
        throw new Error("Unexpected sign-in URL");
      if (generation === loginGeneration && !user && !pending) readyAttempt = attempt;
    } catch (error) {
      if (generation === loginGeneration) showError({ error });
    } finally {
      preparing = null;
      renderUser();
    }
  })();
  renderUser();
  return preparing;
}

signin.addEventListener("click", (event) => {
  if (!readyAttempt || pending || readyAttempt.expiresAt <= Date.now()) {
    event.preventDefault();
    if (readyAttempt?.expiresAt && readyAttempt.expiresAt <= Date.now()) readyAttempt = null;
    if (!pending) void prepareLogin();
    return;
  }
  pending = readyAttempt;
  readyAttempt = null;
  pendingPhase = "pending";
  loginGeneration++;
  savePending();
  if (!framed) {
    try {
      saveSameViewReturn();
    } catch (error) {
      event.preventDefault();
      readyAttempt = pending;
      pending = null;
      savePending();
      renderUser();
      showError({ error });
      return;
    }
  }
  status.textContent = framed
    ? "Finish signing in in the new tab, then return to this post."
    : "Opening X sign-in. You’ll return here automatically.";
  // Keep the same href so Safari follows the native link without waiting for any async work.
  renderUser();
  if (framed) void pollLogin();
});

resumeSignin.addEventListener("click", (event) => {
  if (!pending || pendingPhase !== "pending" || pending.expiresAt <= Date.now()) {
    event.preventDefault();
    void resumeLogin();
    return;
  }
  if (!framed) {
    try {
      saveSameViewReturn();
    } catch (error) {
      event.preventDefault();
      showError({ error });
    }
  }
});
element({ id: "check-signin" }).addEventListener("click", () => {
  void pollLogin();
});
element({ id: "retry-signin" }).addEventListener("click", () => {
  void prepareLogin();
});
cancelSignin.addEventListener("click", async () => {
  if (!pending) return;
  const attempt = pending;
  cancelSignin.disabled = true;
  loginGeneration++;
  try {
    await request({
      path: "/api/auth/cancel",
      body: { state: attempt.state, pollToken: attempt.pollToken },
      schema: okSchema,
    });
    clearTimeout(pollTimer);
    pending = null;
    savePending();
    renderUser();
    status.textContent = "Sign-in cancelled. You can try again.";
    void prepareLogin();
  } catch (error) {
    showError({ error });
  } finally {
    cancelSignin.disabled = false;
  }
});

sign.addEventListener("click", async () => {
  sign.disabled = true;
  sign.textContent = "Signing…";
  try {
    await request({
      path: `/api/book/${room}`,
      body: { message: message.value },
      sessionToken,
      schema: okSchema,
    });
    status.textContent = "You signed the book. Thanks for stopping by!";
    await loadBook();
  } catch (error) {
    showError({ error });
  } finally {
    sign.disabled = false;
    sign.textContent = "Sign the book";
  }
});

element({ id: "logout" }).addEventListener("click", async () => {
  try {
    await request({ path: "/api/logout", body: {}, sessionToken, schema: okSchema });
    sessionToken = null;
    user = null;
    storeSession();
    renderUser();
    status.textContent = "Signed out.";
    void prepareLogin();
  } catch (error) {
    showError({ error });
  }
});

element({ id: "copy-link" }).addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(shareUrl);
    status.textContent = "Share link copied.";
  } catch {
    status.textContent = `Copy this link: ${shareUrl}`;
  }
});

async function boot() {
  await loadBook();
  try {
    sessionToken = secretSchema.safeParse(localStorage.getItem("guestbook.session")).data ?? null;
  } catch {
    sessionToken = null;
  }
  if (sessionToken) {
    try {
      ({ user } = await request({
        path: "/api/me",
        sessionToken,
        schema: z.object({ user: profileSchema }),
      }));
    } catch (error) {
      if (error instanceof Error && "status" in error && error.status === 401) {
        sessionToken = null;
        storeSession();
      }
      showError({ error });
    }
  }
  try {
    const stored = sessionStorage.getItem("guestbook.pending");
    pending = startSchema.safeParse(JSON.parse(stored || "null")).data ?? null;
    if (stored && !pending) {
      savePending();
      status.textContent = "The previous sign-in was interrupted. Please try again.";
    }
  } catch {
    pending = null;
  }
  if (user) {
    pending = null;
    savePending();
  }
  initialized = true;
  renderUser();
  await resumeLogin();
}

void boot().catch((error) => showError({ error }));
function startRefresh() {
  if (refreshTimer) return;
  refreshTimer = setInterval(() => {
    if (!document.hidden) void loadBook().catch((error) => showError({ error }));
  }, 10000);
}
async function resumeLogin() {
  if (!initialized) return;
  if (readyAttempt && readyAttempt.expiresAt <= Date.now()) readyAttempt = null;
  if (pending) await pollLogin();
  else await prepareLogin();
}
function resumePage() {
  pageActive = true;
  startRefresh();
  void resumeLogin();
}
startRefresh();
window.addEventListener("pagehide", () => {
  pageActive = false;
  clearInterval(refreshTimer);
  refreshTimer = undefined;
  clearTimeout(pollTimer);
  pollController?.abort();
});
window.addEventListener("pageshow", resumePage);
window.addEventListener("focus", resumePage);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    pageActive = false;
    clearTimeout(pollTimer);
    pollController?.abort();
  } else resumePage();
});
