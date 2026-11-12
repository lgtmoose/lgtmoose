import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CALLBACK_PATH,
  escapeHtml,
  startCallbackServer,
  type CallbackServer,
} from "./callback-server.js";
import { buildManifest, newAppUrl } from "./manifest.js";

const owner = { login: "acme", kind: "org" } as const;
const state = "expected-state";
let server: CallbackServer<string> | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function start(exchange: (code: string) => Promise<string>, timeoutMs?: number) {
  server = await startCallbackServer({
    manifestFor: (redirectUrl) => buildManifest({ name: "lgtmoose-acme", owner, redirectUrl }),
    formAction: newAppUrl(owner, state),
    state,
    exchange,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
  return server;
}

function callback(base: string, query: string) {
  return fetch(new URL(`${CALLBACK_PATH}?${query}`, base));
}

describe("startCallbackServer", () => {
  it("listens on 127.0.0.1 and serves a form that posts the manifest to GitHub", async () => {
    const { url } = await start(() => Promise.resolve("ok"));
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toContain(
      "form-action https://github.com",
    );
    const html = await response.text();
    expect(html).toContain(
      `action="${escapeHtml("https://github.com/organizations/acme/settings/apps/new?state=expected-state")}"`,
    );
    const value = /name="manifest" value="([^"]*)"/.exec(html)?.[1] ?? "";
    const manifest = JSON.parse(value.replaceAll("&quot;", '"').replaceAll("&amp;", "&")) as {
      redirect_url: string;
    };
    expect(manifest.redirect_url).toBe(`${url.slice(0, -1)}${CALLBACK_PATH}`);
  });

  it("exchanges the code once the state matches, then shows a closing page", async () => {
    const exchange = vi.fn((code: string) => Promise.resolve(`app-for-${code}`));
    const { url, result } = await start(exchange);
    const response = await callback(url, `code=abc123&state=${state}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(await response.text()).toContain("You can close this tab");
    await expect(result).resolves.toBe("app-for-abc123");
    expect(exchange).toHaveBeenCalledWith("abc123");

    // The code is single-use; a replay is turned away without another exchange.
    expect((await callback(url, `code=abc123&state=${state}`)).status).toBe(410);
    expect(exchange).toHaveBeenCalledTimes(1);
  });

  it("rejects a mismatched or missing state and keeps waiting for the real one", async () => {
    const exchange = vi.fn(() => Promise.resolve("app"));
    const { url, result } = await start(exchange);
    expect((await callback(url, "code=abc123&state=forged")).status).toBe(400);
    expect((await callback(url, "code=abc123")).status).toBe(400);
    expect(exchange).not.toHaveBeenCalled();

    expect((await callback(url, `code=real&state=${state}`)).status).toBe(200);
    await expect(result).resolves.toBe("app");
  });

  it("rejects a malformed code without calling GitHub", async () => {
    const exchange = vi.fn(() => Promise.resolve("app"));
    const { url } = await start(exchange);
    expect((await callback(url, `code=${encodeURIComponent("../x")}&state=${state}`)).status).toBe(
      400,
    );
    expect(exchange).not.toHaveBeenCalled();
  });

  it("ignores requests sent under another Host name", async () => {
    const { url } = await start(() => Promise.resolve("app"));
    const port = new URL(url).port;
    const response = await fetch(`http://localhost:${port}/`);
    expect(response.status).toBe(400);
  });

  it("reports a failed exchange", async () => {
    const { url, result } = await start(() => Promise.reject(new Error("HTTP 404")));
    expect((await callback(url, `code=abc&state=${state}`)).status).toBe(502);
    await expect(result).rejects.toThrow("HTTP 404");
  });

  it("gives up after the timeout with a clear message", async () => {
    const { result } = await start(() => Promise.resolve("app"), 20);
    await expect(result).rejects.toThrow(/Gave up waiting for GitHub.*setup` again/);
  });

  it("says ten minutes by default", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { result } = await start(() => Promise.resolve("app"));
      vi.advanceTimersByTime(10 * 60 * 1000);
      await expect(result).rejects.toThrow("after 10 minutes");
    } finally {
      vi.useRealTimers();
    }
  });
});

it("escapes HTML attribute values", () => {
  expect(escapeHtml(`"<a href='x'>&</a>"`)).toBe(
    "&quot;&lt;a href=&#39;x&#39;&gt;&amp;&lt;/a&gt;&quot;",
  );
});
