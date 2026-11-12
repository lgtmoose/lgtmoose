import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { AppManifest } from "./manifest.js";
import { MANIFEST_CODE } from "./github.js";

export const CALLBACK_PATH = "/callback";
export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export interface CallbackServerOptions<T> {
  /** Built once the port is known, because the redirect URL contains it. */
  manifestFor: (redirectUrl: string) => AppManifest;
  /** GitHub's "new App" form URL, including `?state=`. */
  formAction: string;
  state: string;
  /** Turns GitHub's one-time code into App credentials. */
  exchange: (code: string) => Promise<T>;
  timeoutMs?: number;
}

export interface CallbackServer<T> {
  /** The local page to open in a browser. It posts the manifest to GitHub. */
  url: string;
  /** Settles once with the exchanged credentials, or with an error (timeout, failed exchange). */
  result: Promise<T>;
  close(): Promise<void>;
}

/** A random value GitHub echoes back on the redirect, so we only accept our own round trip. */
export function newState(): string {
  return randomBytes(24).toString("base64url");
}

function sameState(expected: string, received: string | null): boolean {
  if (received === null) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  return a.length === b.length && timingSafeEqual(a, b);
}

function describeWait(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return `${ms}ms`;
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}

export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function page(title: string, body: string, nonce?: string, script?: string): string {
  const scriptTag = nonce && script ? `<script nonce="${nonce}">${script}</script>` : "";
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:36rem;margin:4rem auto;padding:0 1rem}</style>
</head>
<body>${body}${scriptTag}</body>
</html>
`;
}

function send(
  res: ServerResponse,
  status: number,
  html: string,
  extraCsp = "",
  formAction = "'none'",
): void {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    // The callback URL carries the one-time code: keep it out of caches and Referer headers.
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; form-action ${formAction}; frame-ancestors 'none'${extraCsp}`,
  });
  res.end(html);
}

/**
 * Serves the manifest form on 127.0.0.1 and waits for GitHub's redirect. A wrong `state` gets
 * a 400 and the server keeps waiting, so a stray or forged request can't end setup.
 */
export async function startCallbackServer<T>(
  options: CallbackServerOptions<T>,
): Promise<CallbackServer<T>> {
  let settle: { resolve: (value: T) => void; reject: (error: Error) => void } | undefined;
  const result = new Promise<T>((resolve, reject) => {
    settle = { resolve, reject };
  });
  // Callers may close before awaiting; don't let an unobserved rejection crash the process.
  result.catch(() => undefined);
  let finished = false;

  // Listen first: the manifest's redirect URL needs the port the OS picked.
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    // Port 0 asks the OS for a free port.
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;
  const manifest: AppManifest = options.manifestFor(`${origin}${CALLBACK_PATH}`);
  server.on("request", (req: IncomingMessage, res: ServerResponse) => {
    void handle(req, res);
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Only answer requests addressed to us by IP, which blocks DNS-rebinding pages.
    if (req.headers.host !== new URL(origin).host || req.method !== "GET") {
      send(res, 400, page("Bad request", "<p>Bad request.</p>"));
      return;
    }
    const url = new URL(req.url ?? "/", origin);
    if (url.pathname === "/") {
      const nonce = randomBytes(16).toString("base64");
      const body = `<h1>Creating your GitHub App</h1>
<p>Sending you to GitHub to confirm the App…</p>
<form method="post" action="${escapeHtml(options.formAction)}">
<input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(manifest))}">
<button type="submit">Continue to GitHub</button>
</form>`;
      send(
        res,
        200,
        page("lgtmoose setup", body, nonce, "document.forms[0].submit();"),
        `; script-src 'nonce-${nonce}'`,
        "https://github.com",
      );
      return;
    }
    if (url.pathname !== CALLBACK_PATH) {
      send(res, 404, page("Not found", "<p>Not found.</p>"));
      return;
    }
    if (finished) {
      send(
        res,
        410,
        page("Already done", "<p>Setup already finished. You can close this tab.</p>"),
      );
      return;
    }
    if (!sameState(options.state, url.searchParams.get("state"))) {
      send(
        res,
        400,
        page(
          "Setup link mismatch",
          "<p>This request doesn't match the setup running in your terminal, so it was ignored.</p>",
        ),
      );
      return;
    }
    const code = url.searchParams.get("code");
    if (code === null || !MANIFEST_CODE.test(code)) {
      send(res, 400, page("Missing code", "<p>GitHub didn't send a valid code.</p>"));
      return;
    }
    finished = true;
    try {
      const value = await options.exchange(code);
      send(
        res,
        200,
        page(
          "GitHub App created",
          "<h1>GitHub App created</h1><p>You can close this tab and go back to your terminal.</p>",
        ),
      );
      settle?.resolve(value);
    } catch (error) {
      send(
        res,
        502,
        page(
          "Setup failed",
          "<h1>Setup failed</h1><p>Check your terminal for details, then run setup again.</p>",
        ),
      );
      settle?.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => {
    if (finished) return;
    finished = true;
    settle?.reject(
      new Error(
        `Gave up waiting for GitHub after ${describeWait(timeoutMs)}. Run \`pnpm lgtmoose setup\` again.`,
      ),
    );
  }, timeoutMs);

  async function close(): Promise<void> {
    clearTimeout(timer);
    if (!finished) {
      finished = true;
      settle?.reject(new Error("Setup was stopped before GitHub responded."));
    }
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  return { url: `${origin}/`, result, close };
}
