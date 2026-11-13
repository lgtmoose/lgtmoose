import { createServer, type IncomingMessage, type Server } from "node:http";
import { lookup } from "node:dns/promises";
import { BlockList, connect, isIP, type Socket } from "node:net";
import type { Duplex } from "node:stream";

/**
 * The egress proxy for sandbox tasks: the only way out of the sandbox subnets. It accepts
 * `CONNECT host:443` for exact allowlisted hostnames and nothing else: no plain HTTP, no IP
 * literals, no other ports. It resolves the name itself and refuses private, loopback,
 * link-local and metadata addresses, so an allowlisted name that resolves into the VPC (DNS
 * rebinding) can't be used to reach it. TLS stays end to end: the proxy only relays bytes.
 *
 * It is a few hundred lines with no dependencies, so it can be read in one sitting; squid would
 * do the job too, but its configuration is far harder to audit and to test.
 */

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

/** Looks a hostname up. Tests inject one; the default uses the system resolver. */
export type Resolver = (host: string) => Promise<ResolvedAddress[]>;

/** Opens a TCP connection to an address that passed the checks. Tests inject one. */
export type Dialer = (address: string, port: number) => Socket;

/** One log line, written as JSON. */
export type LogEntry = Record<string, string | number | boolean | undefined>;

export interface ProxyOptions {
  /** Exact hostnames, lowercase. Anything else is refused. */
  allowedHosts: readonly string[];
  /** The only port CONNECT may target. Default 443. */
  allowedPort?: number;
  resolve?: Resolver;
  dial?: Dialer;
  log?: (entry: LogEntry) => void;
  /** A tunnel with no traffic either way for this long is closed. Default 2 minutes. */
  idleTimeoutMs?: number;
  /** A tunnel is closed after this long, busy or not. Default 30 minutes. */
  maxConnectionMs?: number;
  /** How long to wait for the upstream TCP connection. Default 10 seconds. */
  connectTimeoutMs?: number;
}

/** Why a request was refused. Logged, and the client gets a 403 (or 502 when upstream fails). */
export type BlockReason =
  | "plain_http"
  | "bad_target"
  | "ip_literal"
  | "port"
  | "not_allowed"
  | "dns_failed"
  | "private_address"
  | "upstream_failed";

/**
 * Addresses a tunnel may never reach: private, shared, loopback, link-local (the instance
 * metadata service at 169.254.169.254 and ECS's 169.254.170.2 included), multicast, reserved
 * and documentation ranges, and the IPv6 forms that can wrap an IPv4 address.
 */
// Two lists: a BlockList applies its IPv4-mapped IPv6 rule (::ffff:0:0/96) to IPv4 lookups
// too, which would block every IPv4 address.
const BLOCKED_V4 = new BlockList();
const BLOCKED_V6 = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  BLOCKED_V4.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["::ffff:0:0", 96],
  ["64:ff9b::", 96],
  ["100::", 64],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  BLOCKED_V6.addSubnet(network, prefix, "ipv6");
}

/** Whether a tunnel may connect to this address. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  return family === 4 ? !BLOCKED_V4.check(address, "ipv4") : !BLOCKED_V6.check(address, "ipv6");
}

const systemResolver: Resolver = async (host) =>
  (await lookup(host, { all: true, verbatim: true })).map(({ address, family }) => ({
    address,
    family: family === 6 ? 6 : 4,
  }));

const systemDialer: Dialer = (address, port) => connect({ host: address, port });

function defaultLog(entry: LogEntry): void {
  process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), ...entry })}\n`);
}

/** Splits a CONNECT target (`host:port` or `[v6]:port`). Undefined when it isn't one. */
export function parseTarget(target: string): { host: string; port: number } | undefined {
  const match = /^(\[[0-9A-Fa-f:.]+\]|[^\s:[\]/@]+):(\d{1,5})$/.exec(target);
  if (match === null) return undefined;
  const [, rawHost = "", rawPort = ""] = match;
  const port = Number(rawPort);
  if (port < 1 || port > 65_535) return undefined;
  // A trailing dot names the same host; drop it so the allowlist check can't be sidestepped.
  const host = rawHost
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  // 253 is the longest DNS name; the cap also keeps log lines short.
  return host === "" || host.length > 253 ? undefined : { host, port };
}

const FORBIDDEN = "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
const BAD_GATEWAY = "HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
const ESTABLISHED = "HTTP/1.1 200 Connection Established\r\n\r\n";

/** Builds the proxy server. Call `listen` on it. */
export function createProxy(options: ProxyOptions): Server {
  const allowed = new Set(options.allowedHosts.map((host) => host.toLowerCase()));
  const allowedPort = options.allowedPort ?? 443;
  const resolve = options.resolve ?? systemResolver;
  const dial = options.dial ?? systemDialer;
  const log = options.log ?? defaultLog;
  const idleTimeoutMs = options.idleTimeoutMs ?? 120_000;
  const maxConnectionMs = options.maxConnectionMs ?? 30 * 60_000;
  const connectTimeoutMs = options.connectTimeoutMs ?? 10_000;

  const server = createServer((req, res) => {
    // Only the health check is served over plain HTTP; a proxied `GET http://…` is refused.
    if (req.method === "GET" && req.url === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain" }).end("ok\n");
      return;
    }
    log({
      event: "blocked",
      reason: "plain_http",
      method: req.method,
      target: (req.url ?? "").slice(0, 200),
      client: req.socket.remoteAddress,
    });
    res.writeHead(403, { connection: "close" }).end();
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  server.maxConnections = 2_048;

  server.on("clientError", (_error, socket) => socket.destroy());

  server.on("connect", (req: IncomingMessage, client: Duplex, head: Buffer) => {
    const remote = req.socket.remoteAddress;
    const refuse = (reason: BlockReason, extra: LogEntry, response = FORBIDDEN) => {
      log({ event: "blocked", reason, client: remote, ...extra });
      client.end(response);
    };
    client.on("error", () => client.destroy());

    const target = parseTarget(req.url ?? "");
    if (target === undefined) {
      refuse("bad_target", { target: (req.url ?? "").slice(0, 200) });
      return;
    }
    const { host, port } = target;
    if (isIP(host) !== 0) {
      refuse("ip_literal", { host, port });
      return;
    }
    if (port !== allowedPort) {
      refuse("port", { host, port });
      return;
    }
    if (!allowed.has(host)) {
      refuse("not_allowed", { host, port });
      return;
    }

    void (async () => {
      let addresses: ResolvedAddress[];
      try {
        addresses = await resolve(host);
      } catch {
        refuse("dns_failed", { host, port }, BAD_GATEWAY);
        return;
      }
      // All of them must be public: a name with one private answer is treated as hostile.
      const blocked = addresses.find((entry) => !isPublicAddress(entry.address));
      const [first] = addresses;
      if (first === undefined || blocked !== undefined) {
        refuse("private_address", { host, port, address: blocked?.address });
        return;
      }
      if (client.destroyed) return;

      const upstream = dial(first.address, port);
      let established = false;
      const close = () => {
        clearTimeout(lifetime);
        upstream.destroy();
        client.destroy();
      };
      const lifetime = setTimeout(close, maxConnectionMs);
      upstream.setTimeout(connectTimeoutMs, () => {
        if (!established) {
          clearTimeout(lifetime);
          upstream.destroy();
          refuse("upstream_failed", { host, port, address: first.address }, BAD_GATEWAY);
        }
      });
      upstream.once("connect", () => {
        established = true;
        upstream.setTimeout(idleTimeoutMs, close);
        // The CONNECT socket is a net.Socket; Node types it as a plain Duplex.
        (client as Socket).setTimeout(idleTimeoutMs, close);
        log({ event: "tunnel", host, port, address: first.address, client: remote });
        client.write(ESTABLISHED);
        if (head.length > 0) upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
      upstream.on("error", () => {
        if (!established) {
          clearTimeout(lifetime);
          refuse("upstream_failed", { host, port, address: first.address }, BAD_GATEWAY);
          return;
        }
        close();
      });
      // Before the tunnel is up, a failed dial answers 502 above; closing the client here as
      // well could drop that answer.
      upstream.on("close", () => {
        if (established) close();
      });
      client.on("close", close);
    })();
  });

  return server;
}
