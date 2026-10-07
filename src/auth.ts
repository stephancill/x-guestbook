import "./style.css";
import { z } from "zod";
import {
  AUTH_RETURN_KEY,
  authReturnSchema,
  authorizeSchema,
  secretSchema,
  startSchema,
} from "./schema";
import { element, request } from "./api";

const message = element({ id: "auth-message" });
element({ id: "close" }).addEventListener("click", () => window.close());

function returnContext({ state }: { state: string }) {
  let stored: string | null;
  try {
    stored = sessionStorage.getItem(AUTH_RETURN_KEY);
  } catch {
    return null;
  }
  if (!stored) return null;
  const context = authReturnSchema.safeParse(JSON.parse(stored));
  if (!context.success)
    throw new Error(
      "Saved sign-in return context is invalid. Return to the guestbook and try again.",
    );
  if (context.data.state !== state) return null;
  const pending = startSchema.safeParse(
    JSON.parse(sessionStorage.getItem("guestbook.pending") || "null"),
  );
  if (
    !pending.success ||
    pending.data.state !== state ||
    pending.data.expiresAt !== context.data.expiresAt
  )
    throw new Error("Saved sign-in attempt is missing. Return to the guestbook and try again.");
  const link = element<HTMLAnchorElement>({ id: "return-guestbook" });
  link.href = context.data.path;
  link.hidden = false;
  element({ id: "close" }).hidden = true;
  element({ id: "auth-hint" }).textContent =
    "You’ll return to the guestbook automatically after sign-in.";
  return context.data;
}

async function start() {
  if (location.pathname === "/auth/done") {
    const state = secretSchema.safeParse(new URLSearchParams(location.search).get("state"));
    if (state.success) {
      const context = returnContext({ state: state.data });
      if (context) {
        message.textContent = "Returning to the guestbook…";
        sessionStorage.removeItem(AUTH_RETURN_KEY);
        location.replace(context.path);
        return;
      }
    }
    message.textContent =
      new URLSearchParams(location.search).get("result") === "success"
        ? "You’re signed in. Return to the guestbook to sign it."
        : "Sign-in failed. Return to the guestbook for details and try again.";
    return;
  }
  const params = new URLSearchParams(location.hash.slice(1));
  const credentials = authorizeSchema.parse(Object.fromEntries(params));
  returnContext({ state: credentials.state });
  history.replaceState(null, "", location.pathname);
  const { url } = await request({
    path: "/api/auth/authorize",
    body: credentials,
    schema: z.object({ url: z.string().url() }),
  });
  const target = new URL(url);
  if (target.origin !== "https://x.com" || target.pathname !== "/i/oauth2/authorize")
    throw new Error("Unexpected authorization URL");
  location.assign(url);
}

void start().catch((error) => {
  message.textContent =
    error instanceof Error ? error.message : "Sign-in could not start. Please try again.";
});
