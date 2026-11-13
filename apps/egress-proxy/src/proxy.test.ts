import { request, type Server } from "node:http";
import { connect, createServer, type AddressInfo, type Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createProxy,
  isPublicAddress,
  parseTarget,
  type LogEntry,
  type ProxyOptions,
} from "./proxy.ts";

/** A TCP echo server standing in for the model API: the tunnel only relays bytes. */
let upstream: ReturnType<typeof createServer>;
let upstreamPort: number;
let proxy: Server;
let proxyPort: number;
let logs: LogEntry[];
let dialed: { address: string; port: number }[];

/** What the fake DNS answers. A public address, so the checks pass, dialed to localhost. */
const DNS: Record<string, string[]> = {
  "api.anthropic.com": ["160.79.104.10"],
  "github.com": ["140.82.112.3"],
  "rebind.example.com": ["160.79.104.10", "169.254.169.254"],
  "internal.example.com": ["10.0.1.7"],
};

async function listen(server: {
  listen: (port: number, cb: () => void) => unknown;
  address(): unknown;
}) {
  await new Promise<void>((resolve) => server.listen(0, resolve));
  return (server.address() as AddressInfo).port;
}

async function startProxy(overrides: Partial<ProxyOptions> = {}): Promise<void> {
  proxy = createProxy({
    allowedHosts: ["api.anthropic.com", "rebind.example.com", "internal.example.com"],
    resolve: async (host) => {
      const answers = DNS[host];
      if (answers === undefined) throw new Error("ENOTFOUND");
      return answers.map((address) => ({ address, family: 4 as const }));
    },
    dial: (address, port) => {
      dialed.push({ address, port });
      return connect({ host: "127.0.0.1", port: upstreamPort });
    },
    log: (entry) => logs.push(entry),
    ...overrides,
  });
  proxyPort = await listen(proxy);
}

beforeEach(async () => {
  logs = [];
  dialed = [];
  upstream = createServer((socket) => socket.pipe(socket));
  upstreamPort = await listen(upstream);
  await startProxy();
});

afterEach(async () => {
  proxy.closeAllConnections();
  await new Promise((resolve) => proxy.close(resolve));
  await new Promise((resolve) => upstream.close(resolve));
});

/** Sends CONNECT and resolves with the status and, on 200, the tunnel socket. */
function connectThrough(target: string): Promise<{ status: number; socket: Socket }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: proxyPort, method: "CONNECT", path: target });
    req.on("connect", (res, socket) => resolve({ status: res.statusCode ?? 0, socket }));
    req.on("response", (res) => resolve({ status: res.statusCode ?? 0, socket: res.socket }));
    req.on("error", reject);
    req.end();
  });
}

function echo(socket: Socket, text: string): Promise<string> {
  return new Promise((resolve) => {
    socket.once("data", (data) => resolve(data.toString()));
    socket.write(text);
  });
}

describe("egress proxy", () => {
  it("tunnels to an allowlisted model API on 443", async () => {
    const { status, socket } = await connectThrough("api.anthropic.com:443");
    expect(status).toBe(200);
    expect(await echo(socket, "hello")).toBe("hello");
    socket.destroy();
    expect(dialed).toEqual([{ address: "160.79.104.10", port: 443 }]);
    expect(logs).toContainEqual(
      expect.objectContaining({ event: "tunnel", host: "api.anthropic.com" }),
    );
  });

  it("refuses GitHub, which isn't allowlisted, and logs it", async () => {
    const { status } = await connectThrough("github.com:443");
    expect(status).toBe(403);
    expect(dialed).toEqual([]);
    expect(logs).toContainEqual(
      expect.objectContaining({ event: "blocked", reason: "not_allowed", host: "github.com" }),
    );
  });

  it.each([
    ["an IP literal", "160.79.104.10:443", "ip_literal"],
    ["an IPv6 literal", "[2001:4860::1]:443", "ip_literal"],
    ["another port", "api.anthropic.com:80", "port"],
    ["a malformed target", "api.anthropic.com", "bad_target"],
    ["a name with userinfo", "user@api.anthropic.com:443", "bad_target"],
  ])("refuses %s", async (_, target, reason) => {
    const { status } = await connectThrough(target);
    expect(status).toBe(403);
    expect(dialed).toEqual([]);
    expect(logs).toContainEqual(expect.objectContaining({ event: "blocked", reason }));
  });

  it("matches hosts exactly, ignoring case and a trailing dot", async () => {
    const upper = await connectThrough("API.Anthropic.com.:443");
    expect(upper.status).toBe(200);
    upper.socket.destroy();
    const sub = await connectThrough("evil.api.anthropic.com:443");
    expect(sub.status).toBe(403);
  });

  it("refuses an allowlisted name that resolves to a private or metadata address", async () => {
    for (const host of ["rebind.example.com", "internal.example.com"]) {
      const { status } = await connectThrough(`${host}:443`);
      expect(status).toBe(403);
    }
    expect(dialed).toEqual([]);
    expect(logs.filter((entry) => entry.reason === "private_address")).toHaveLength(2);
  });

  it("answers 502 when the name doesn't resolve", async () => {
    proxy.closeAllConnections();
    await new Promise((resolve) => proxy.close(resolve));
    await startProxy({ allowedHosts: ["missing.example.com"] });
    const { status } = await connectThrough("missing.example.com:443");
    expect(status).toBe(502);
    expect(logs).toContainEqual(expect.objectContaining({ reason: "dns_failed" }));
  });

  it("refuses plain HTTP proxying but answers the health check", async () => {
    const get = (path: string) =>
      new Promise<number>((resolve, reject) => {
        request({ host: "127.0.0.1", port: proxyPort, path }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        })
          .on("error", reject)
          .end();
      });
    expect(await get("http://github.com/")).toBe(403);
    expect(await get("/healthz")).toBe(200);
    expect(logs).toContainEqual(expect.objectContaining({ reason: "plain_http" }));
  });

  it("dials an IPv4 answer before an IPv6 one, since the VPC is IPv4-only", async () => {
    proxy.closeAllConnections();
    await new Promise((resolve) => proxy.close(resolve));
    await startProxy({
      resolve: async () => [
        { address: "2606:4700::6810:84e5", family: 6 },
        { address: "160.79.104.10", family: 4 },
      ],
    });
    const { status, socket } = await connectThrough("api.anthropic.com:443");
    expect(status).toBe(200);
    socket.destroy();
    expect(dialed).toEqual([{ address: "160.79.104.10", port: 443 }]);
  });

  it("gives up on a resolver that hangs", async () => {
    proxy.closeAllConnections();
    await new Promise((resolve) => proxy.close(resolve));
    await startProxy({ resolve: () => new Promise(() => {}), connectTimeoutMs: 50 });
    const { status } = await connectThrough("api.anthropic.com:443");
    expect(status).toBe(502);
    expect(logs).toContainEqual(expect.objectContaining({ reason: "dns_failed" }));
  });

  it("answers 502 when the upstream refuses the connection", async () => {
    await new Promise((resolve) => upstream.close(resolve));
    upstream = createServer();
    const { status } = await connectThrough("api.anthropic.com:443");
    expect(status).toBe(502);
    expect(logs).toContainEqual(expect.objectContaining({ reason: "upstream_failed" }));
    upstreamPort = await listen(upstream);
  });

  it("closes an idle tunnel", async () => {
    proxy.closeAllConnections();
    await new Promise((resolve) => proxy.close(resolve));
    await startProxy({ idleTimeoutMs: 100 });
    const { status, socket } = await connectThrough("api.anthropic.com:443");
    expect(status).toBe(200);
    await new Promise((resolve) => socket.once("close", resolve));
  });
});

describe("isPublicAddress", () => {
  it.each([
    "10.1.2.3",
    "172.31.0.1",
    "192.168.1.1",
    "127.0.0.1",
    "169.254.169.254",
    "169.254.170.2",
    "100.100.1.1",
    "0.0.0.0",
    "::1",
    "fd00::1",
    "fe80::1",
    "::ffff:10.0.0.1",
    "64:ff9b::a00:1",
    "not-an-ip",
  ])("refuses %s", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each(["160.79.104.10", "8.8.8.8", "2606:4700::1111"])("allows %s", (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });
});

describe("parseTarget", () => {
  it("splits host and port", () => {
    expect(parseTarget("api.anthropic.com:443")).toEqual({ host: "api.anthropic.com", port: 443 });
    expect(parseTarget("[::1]:443")).toEqual({ host: "::1", port: 443 });
    expect(parseTarget("a.com:0")).toBeUndefined();
    expect(parseTarget("a.com:99999")).toBeUndefined();
    expect(parseTarget("http://a.com:443")).toBeUndefined();
  });
});
