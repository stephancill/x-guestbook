import { z } from "zod";

let embedToken: string | undefined;
export function setEmbedToken({ token }: { token: string }) {
  embedToken = token;
}

export async function request<T extends z.ZodType>({
  path,
  body,
  schema,
  sessionToken,
  signal,
}: {
  path: string;
  body?: unknown;
  schema: T;
  sessionToken?: string | null;
  signal?: AbortSignal;
}): Promise<z.output<T>> {
  const headers = new Headers();
  if (embedToken) headers.set("x-embed-token", embedToken);
  if (body !== undefined) headers.set("content-type", "application/json");
  if (sessionToken) headers.set("authorization", `Bearer ${sessionToken}`);
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) abort();
  signal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(abort, 15000);
  let response: Response;
  let data: unknown;
  try {
    response = await fetch(path, {
      method: body === undefined ? "GET" : "POST",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    data = await response.json();
  } catch (error) {
    if (error instanceof SyntaxError)
      throw new Error("The server returned an invalid response. Please try again.");
    throw Object.assign(
      new Error(
        controller.signal.aborted
          ? "Request interrupted. Check sign-in again when you return."
          : "Could not connect. Check your connection and try again.",
      ),
      { network: true },
    );
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
  if (!response.ok) {
    const parsed = z.object({ error: z.string() }).safeParse(data);
    throw Object.assign(
      new Error(parsed.success ? parsed.data.error : `Request failed (HTTP ${response.status})`),
      { status: response.status },
    );
  }
  return schema.parse(data);
}

export function element<T extends HTMLElement>({ id }: { id: string }): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element: ${id}`);
  return node as T;
}
