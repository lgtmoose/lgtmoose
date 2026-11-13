import { request, type Server } from "node:http";
import { connect, createServer, type AddressInfo, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createProxy,
  isPublicAddress,
  parseTarget,
  readClientHello,
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

function echo(socket: Socket, data: Buffer): Promise<Buffer> {
  return new Promise((resolve) => {
    socket.once("data", resolve);
    socket.write(data);
  });
}

/** A minimal TLS 1.2-framed ClientHello, with a server_name extension when given a name. */
function clientHello(serverName?: string): Buffer {
  const parts: Buffer[] = [];
  if (serverName !== undefined) {
    const name = Buffer.from(serverName, "latin1");
    const entry = Buffer.concat([Buffer.from([0]), u16(name.length), name]);
    const list = Buffer.concat([u16(entry.length), entry]);
    parts.push(Buffer.concat([u16(0), u16(list.length), list]));
  }
  const extensions = Buffer.concat(parts);
  const hello = Buffer.concat([
    Buffer.from([3, 3]),
    Buffer.alloc(32),
    Buffer.from([0]),
    u16(2),
    Buffer.from([0x13, 0x01]),
    Buffer.from([1, 0]),
    u16(extensions.length),
    extensions,
  ]);
  const handshake = Buffer.concat([
    Buffer.from([1, 0, hello.length >> 8, hello.length & 0xff]),
    hello,
  ]);
  return Buffer.concat([Buffer.from([0x16, 3, 1]), u16(handshake.length), handshake]);
}

function u16(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n);
  return b;
}

/** Resolves when the socket closes, or with false after `ms`. */
function closes(socket: Socket, ms = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    socket.once("close", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

describe("egress proxy", () => {
  it("tunnels to an allowlisted model API on 443", async () => {
    const { status, socket } = await connectThrough("api.anthropic.com:443");
    expect(status).toBe(200);
    const hello = clientHello("api.anthropic.com");
    expect(await echo(socket, hello)).toEqual(hello);
    socket.destroy();
    expect(dialed).toEqual([{ address: "160.79.104.10", port: 443 }]);
    expect(logs).toContainEqual(
      expect.objectContaining({ event: "tunnel", host: "api.anthropic.com" }),
    );
  });

  it("refuses a tunnel whose TLS names another host, as a CDN would serve it", async () => {
    const { status, socket } = await connectThrough("api.anthropic.com:443");
    expect(status).toBe(200);
    socket.write(clientHello("exfil.attacker.example"));
    expect(await closes(socket)).toBe(true);
    expect(logs).toContainEqual(
      expect.objectContaining({
        reason: "sni_mismatch",
        host: "api.anthropic.com",
        serverName: "exfil.attacker.example",
      }),
    );
    expect(logs).not.toContainEqual(expect.objectContaining({ event: "tunnel" }));
  });

  it.each([
    ["a ClientHello without a server name", clientHello()],
    ["bytes that aren't TLS", Buffer.from("GET / HTTP/1.1\r\nHost: x\r\n\r\n")],
  ])("refuses %s", async (_, data) => {
    const { socket } = await connectThrough("api.anthropic.com:443");
    socket.write(data);
    expect(await closes(socket)).toBe(true);
    expect(logs).toContainEqual(
      expect.objectContaining({ event: "blocked", host: "api.anthropic.com" }),
    );
  });

  it("accepts a ClientHello split across packets", async () => {
    const { socket } = await connectThrough("api.anthropic.com:443");
    const hello = clientHello("api.anthropic.com");
    const received = new Promise<Buffer>((resolve) => {
      const chunks: Buffer[] = [];
      socket.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
        if (Buffer.concat(chunks).length >= hello.length) resolve(Buffer.concat(chunks));
      });
    });
    socket.write(hello.subarray(0, 7));
    await new Promise((resolve) => setTimeout(resolve, 20));
    socket.write(hello.subarray(7));
    expect(await received).toEqual(hello);
    socket.destroy();
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

describe("readClientHello", () => {
  it("reads the server name from a real ClientHello", async () => {
    const captured = await new Promise<Buffer>((resolve, reject) => {
      const server = createServer((socket) => {
        socket.once("data", (data: Buffer) => {
          resolve(data);
          socket.destroy();
          server.close();
        });
      });
      server.listen(0, () => {
        const { port } = server.address() as AddressInfo;
        const tls = tlsConnect({ host: "127.0.0.1", port, servername: "api.anthropic.com" });
        tls.on("error", () => undefined);
      });
      server.on("error", reject);
    });
    expect(readClientHello(captured)).toEqual({ kind: "hello", serverName: "api.anthropic.com" });
  });

  it("asks for more bytes until the record is complete, and rejects other data", () => {
    const hello = clientHello("api.anthropic.com");
    expect(readClientHello(hello.subarray(0, 10))).toEqual({ kind: "incomplete" });
    expect(readClientHello(Buffer.from("GET / HTTP/1.1"))).toEqual({ kind: "invalid" });
    expect(readClientHello(clientHello())).toEqual({ kind: "hello", serverName: undefined });
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
