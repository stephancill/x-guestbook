import "./style.css";
import "./webview.css";
import { z } from "zod";
import { element } from "./api";
import { secretSchema } from "./schema";
import {
  contextSchema,
  eventSchema,
  probeConfigSchema,
  probeModeSchema,
  reportSchema,
  runIdSchema,
  runSchema,
} from "./webview-schema";

const config = probeConfigSchema.parse(
  JSON.parse(element({ id: "probe-config" }).textContent || "null"),
);
const status = element({ id: "probe-status" });
const path = location.pathname.split("/");
const stage = path[1] === "popup" ? "popup" : path[1] === "complete" ? "complete" : "viewer";
const mode = probeModeSchema.parse(new URLSearchParams(location.search).get("mode") || "manual");
const page = crypto.randomUUID();
const started = performance.now();
let run: z.infer<typeof runSchema>;
let queue: z.infer<typeof eventSchema>[] = [];
let sending: Promise<void> | null = null;
let report: z.infer<typeof reportSchema>["events"] = [];
let after = 0;
let fetching = false;
let channel: BroadcastChannel | undefined;
let lastHeartbeat = performance.now();
let timer: ReturnType<typeof setInterval> | undefined;

function inspect({ read }: { read: () => unknown }) {
  try {
    return read();
  } catch (error) {
    return { unavailable: error instanceof Error ? error.name : "error" };
  }
}
function originOf({ value }: { value: string }) {
  try {
    return new URL(value).origin;
  } catch {
    return value ? "unavailable" : "";
  }
}
function storageProbe({ storage }: { storage: Storage }) {
  const key = `x-webview-probe:${run.id}`;
  const before = storage.getItem(key);
  storage.setItem(key, page);
  return { writable: storage.getItem(key) === page, previousPage: before };
}
function snapshot() {
  const extended = window as unknown as Record<string, unknown>;
  return {
    mode,
    path: location.pathname.replace(run.id, ":run"),
    elapsedMs: Math.round(performance.now() - started),
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    language: navigator.language,
    framed: window.top !== window,
    referrerOrigin: originOf({ value: document.referrer }),
    ancestorOrigins: inspect({ read: () => Array.from(location.ancestorOrigins || []) }),
    historyLength: history.length,
    historyStateKeys: inspect({ read: () => history.state && Object.keys(history.state) }),
    visibility: document.visibilityState,
    focused: document.hasFocus(),
    opener: {
      present: Boolean(window.opener),
      closed: inspect({ read: () => window.opener?.closed }),
      origin: inspect({ read: () => (window.opener ? window.opener.location.origin : null) }),
    },
    parent: {
      sameWindow: window.parent === window,
      origin: inspect({ read: () => window.parent.location.origin }),
    },
    windowNameLength: window.name.length,
    viewport: {
      width: innerWidth,
      height: innerHeight,
      visualWidth: visualViewport?.width,
      visualHeight: visualViewport?.height,
      scale: visualViewport?.scale,
    },
    navigation: inspect({
      read: () => {
        const entry = performance.getEntriesByType("navigation")[0] as
          | PerformanceNavigationTiming
          | undefined;
        return { type: entry?.type, redirectCount: entry?.redirectCount };
      },
    }),
    localStorage: inspect({ read: () => storageProbe({ storage: localStorage }) }),
    sessionStorage: inspect({ read: () => storageProbe({ storage: sessionStorage }) }),
    cookies: inspect({
      read: () => {
        document.cookie = "x_webview_probe=1; Path=/; SameSite=Lax; Secure";
        const writable = document.cookie.split("; ").includes("x_webview_probe=1");
        document.cookie = "x_webview_probe=; Path=/; Max-Age=0; Secure";
        return { writable };
      },
    }),
    features: {
      broadcastChannel: typeof BroadcastChannel,
      postMessage: typeof postMessage,
      close: typeof window.close,
      storageAccess: typeof document.hasStorageAccess,
      standalone: Reflect.get(navigator, "standalone"),
      secureContext: isSecureContext,
    },
    nativeGlobals: inspect({
      read: () =>
        Object.getOwnPropertyNames(window)
          .filter((name) =>
            /webkit|twitter|bridge|native|external|android|flutter|cordova|messageHandler/i.test(
              name,
            ),
          )
          .slice(0, 100)
          .map((name) => ({ name, type: typeof extended[name] })),
    }),
    webkitHandlers: inspect({
      read: () => {
        const webkit = extended.webkit as { messageHandlers?: object } | undefined;
        return webkit?.messageHandlers
          ? Object.getOwnPropertyNames(webkit.messageHandlers).slice(0, 100)
          : [];
      },
    }),
  };
}
async function api<T extends z.ZodType>({
  path,
  body,
  schema,
  token = run?.token,
  keepalive = false,
}: {
  path: string;
  body?: unknown;
  schema: T;
  token?: string;
  keepalive?: boolean;
}): Promise<z.output<T>> {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    keepalive,
    signal: AbortSignal.timeout(10000),
  });
  const data: unknown = await response.json();
  if (!response.ok) throw new Error(z.object({ error: z.string() }).parse(data).error);
  return schema.parse(data);
}
function record({ type, data = {} }: { type: string; data?: Record<string, unknown> }) {
  if (!run) return;
  queue.push(eventSchema.parse({ page, stage, type, at: Date.now(), data }));
  queue = queue.slice(-40);
  void flush();
}
function flush(): Promise<void> {
  if (sending) return sending;
  if (!queue.length) return Promise.resolve();
  sending = (async () => {
    try {
      for (let batches = 0; queue.length && batches < 4; batches++) {
        const batch = queue.splice(0, 10);
        try {
          await api({
            path: `/api/runs/${run.id}/events`,
            body: { events: batch },
            schema: z.object({ ok: z.literal(true) }),
            keepalive: true,
          });
        } catch (error) {
          queue.unshift(...batch);
          queue = queue.slice(-40);
          status.textContent = error instanceof Error ? error.message : "Could not save events";
          break;
        }
      }
    } finally {
      sending = null;
    }
  })();
  return sending;
}
function link({
  id,
  stage: target,
  mode: targetMode = mode,
  origin = location.origin,
}: {
  id: string;
  stage: string;
  mode?: string;
  origin?: string;
}) {
  const anchor = element<HTMLAnchorElement>({ id });
  anchor.href = `${origin}/${target}/${run.id}?mode=${targetMode}#${run.token}`;
  anchor.addEventListener("click", () =>
    record({
      type: "navigation.tap",
      data: { control: id, target, mode: targetMode, targetOrigin: origin },
    }),
  );
}
async function refreshReport() {
  if (fetching || !run) return;
  fetching = true;
  try {
    const result = await api({
      path: `/api/runs/${run.id}/report?after=${after}`,
      schema: reportSchema,
    });
    if (result.events.length) {
      after = result.events.at(-1)!.id;
      report = [...report, ...result.events].slice(-300);
      element({ id: "report" }).textContent = JSON.stringify(
        { run: run.id, events: report },
        null,
        2,
      );
      if (stage === "viewer") {
        const completions = report.filter((event) => event.type === "flow.complete");
        status.textContent = completions.length
          ? `${completions.length} completion(s) detected. Latest mode: ${String(completions.at(-1)!.data.mode)}. Events saved: ${report.length}.`
          : `Ready. ${report.length} events saved.`;
      }
    }
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : "Could not read report";
  } finally {
    fetching = false;
  }
}
const messageSchema = z
  .object({
    kind: z.literal("x-webview-probe"),
    run: runIdSchema,
    page: z.string().uuid(),
    stage: z.enum(["viewer", "popup", "complete"]),
  })
  .strict();
function notify() {
  const payload = { kind: "x-webview-probe", run: run.id, page, stage };
  record({
    type: "notify.opener",
    data: {
      result: inspect({
        read: () => {
          if (!window.opener) return "no opener";
          window.opener.postMessage(payload, location.origin);
          return "sent";
        },
      }),
    },
  });
  record({
    type: "notify.broadcast",
    data: {
      result: inspect({
        read: () => {
          if (!channel) return "unavailable";
          channel.postMessage(payload);
          return "sent";
        },
      }),
    },
  });
}
async function closeWindow() {
  record({ type: "close.requested", data: snapshot() });
  await flush();
  window.close();
  setTimeout(() => {
    status.textContent =
      "window.close() did not dismiss this page. Try the native back control or return link.";
    record({ type: "close.still-open", data: snapshot() });
  }, 800);
}
async function start() {
  if (path[1] === "return") {
    const id = runIdSchema.parse(path[2]);
    const token = secretSchema.parse(location.hash.slice(1));
    location.replace(`${config.origin}/complete/${id}?mode=${mode}&hop=1#${token}`);
    return;
  }
  if (path[2]) {
    run = {
      id: runIdSchema.parse(path[2]),
      token: secretSchema.parse(location.hash.slice(1)),
      expiresAt: Date.now() + 86400000,
    };
  } else {
    run = await api({ path: "/api/runs", body: {}, schema: runSchema });
    history.replaceState(null, "", `/test/${run.id}#${run.token}`);
  }
  element({ id: "run" }).textContent = run.id;
  element({ id: stage }).hidden = false;
  record({ type: "context.loaded", data: snapshot() });
  const server = await api({ path: "/api/context", schema: contextSchema });
  record({ type: "context.request", data: server });
  if (document.hasStorageAccess) {
    try {
      record({
        type: "context.storage-access",
        data: { granted: await document.hasStorageAccess() },
      });
    } catch (error) {
      record({
        type: "context.storage-access",
        data: { error: error instanceof Error ? error.name : "error" },
      });
    }
  }
  try {
    channel = new BroadcastChannel(`x-webview-probe:${run.id}`);
    channel.addEventListener("message", (event) => {
      const parsed = messageSchema.safeParse(event.data);
      if (parsed.success && parsed.data.run === run.id)
        record({ type: "broadcast.received", data: parsed.data });
    });
  } catch (error) {
    record({
      type: "broadcast.unavailable",
      data: { error: error instanceof Error ? error.name : "error" },
    });
  }
  window.addEventListener("message", (event) => {
    const parsed = messageSchema.safeParse(event.data);
    record({
      type: "message.observed",
      data: {
        origin: originOf({ value: event.origin }),
        source:
          event.source === window.opener
            ? "opener"
            : event.source === window.parent
              ? "parent"
              : "other",
        payloadType: typeof event.data,
        keys: inspect({
          read: () =>
            event.data && typeof event.data === "object"
              ? Object.keys(event.data).slice(0, 30)
              : [],
        }),
        recognized: parsed.success && parsed.data.run === run.id,
      },
    });
  });
  window.addEventListener("storage", (event) => {
    if (event.key === `x-webview-probe:${run.id}`)
      record({
        type: "storage.observed",
        data: {
          area: event.storageArea === localStorage ? "local" : "session",
          newPage: event.newValue,
        },
      });
  });
  for (const type of ["pageshow", "pagehide", "focus", "blur", "popstate", "visibilitychange"]) {
    const target = type === "visibilitychange" ? document : window;
    target.addEventListener(type, (event) => {
      record({
        type: `lifecycle.${type}`,
        data: { ...snapshot(), persisted: "persisted" in event ? event.persisted : undefined },
      });
      if (
        type === "pageshow" ||
        type === "focus" ||
        (type === "visibilitychange" && !document.hidden)
      )
        void refreshReport();
    });
  }
  link({ id: "manual", stage: "popup", mode: "manual" });
  link({ id: "auto-close", stage: "popup", mode: "close" });
  link({ id: "with-opener", stage: "popup", mode: "opener" });
  link({ id: "same-view", stage: "popup", mode: "same-view" });
  link({ id: "auto-return", stage: "popup", mode: "return" });
  link({ id: "finish", stage: "complete" });
  link({ id: "cross-origin", stage: "return", origin: config.hopOrigin });
  link({ id: "return-viewer", stage: "test" });
  element({ id: "snapshot" }).addEventListener("click", () =>
    record({ type: "context.manual", data: snapshot() }),
  );
  element({ id: "notify-opener" }).addEventListener("click", notify);
  element({ id: "close-window" }).addEventListener("click", () => {
    void closeWindow();
  });
  element({ id: "go-back" }).addEventListener("click", async () => {
    record({ type: "back.requested", data: snapshot() });
    await flush();
    history.back();
  });
  element({ id: "refresh-report" }).addEventListener("click", () => {
    void refreshReport();
  });
  element({ id: "copy-report" }).addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify({ run: run.id, events: report }, null, 2));
      status.textContent = "Report copied (no run credential included).";
    } catch {
      status.textContent = "Select and copy the report below, or share the run ID.";
    }
  });
  timer = setInterval(() => {
    if (document.hidden) return;
    void flush();
    void refreshReport();
    if (performance.now() - lastHeartbeat >= 10000) {
      record({ type: "heartbeat", data: { elapsedMs: Math.round(performance.now() - started) } });
      lastHeartbeat = performance.now();
    }
  }, 2000);
  if (stage === "complete") {
    record({
      type: "flow.complete",
      data: {
        crossOriginHop: new URLSearchParams(location.search).get("hop") === "1",
        ...snapshot(),
      },
    });
    notify();
    await flush();
    if (mode === "close") {
      await closeWindow();
      return;
    }
    if (mode === "return" || mode === "same-view") {
      location.replace(`${config.origin}/test/${run.id}#${run.token}`);
      return;
    }
  }
  await flush();
  await refreshReport();
}
void start().catch((error) => {
  status.textContent = error instanceof Error ? error.message : "Probe could not start";
});
window.addEventListener("pagehide", () => {
  clearInterval(timer);
  timer = undefined;
});
window.addEventListener("pageshow", () => {
  if (run && !timer)
    timer = setInterval(() => {
      if (!document.hidden) {
        void flush();
        void refreshReport();
      }
    }, 2000);
});
