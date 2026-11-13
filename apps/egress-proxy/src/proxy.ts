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
  | "upstream_failed"
  | "sni_mismatch"
  | "not_tls";

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

/** The most bytes read while waiting for the TLS ClientHello: one full TLS record and its header. */
const MAX_HELLO_BYTES = 5 + 16_384;

export type ClientHello =
  { kind: "incomplete" } | { kind: "invalid" } | { kind: "hello"; serverName: string | undefined };

/**
 * Reads the server name (SNI) from the start of a TLS connection: a handshake record holding a
 * ClientHello. The tunnel's host is checked against the allowlist, but the TLS inside it could
 * name another site on the same IP (a CDN serves many customers per address), so the proxy
 * checks that the ClientHello names the same host. The ClientHello must fit in the first record.
 */
export function readClientHello(data: Buffer): ClientHello {
  if (data.length < 5) return { kind: "incomplete" };
  // A handshake record, TLS 1.0 to 1.3 framing.
  if (data[0] !== 0x16 || data[1] !== 0x03) return { kind: "invalid" };
  const recordLength = data.readUInt16BE(3);
  if (recordLength < 4 || recordLength > 16_384) return { kind: "invalid" };
  if (data.length < 5 + recordLength) return { kind: "incomplete" };
  const record = data.subarray(5, 5 + recordLength);
  if (record[0] !== 0x01) return { kind: "invalid" };
  const helloLength = (record.readUInt16BE(1) << 8) | (record[3] ?? 0);
  if (helloLength + 4 > record.length) return { kind: "invalid" };
  const hello = record.subarray(4, 4 + helloLength);
  let at = 2 + 32; // version, random
  const skip = (lengthBytes: 1 | 2): boolean => {
    if (at + lengthBytes > hello.length) return false;
    const length = lengthBytes === 1 ? (hello[at] ?? 0) : hello.readUInt16BE(at);
    at += lengthBytes + length;
    return at <= hello.length;
  };
  // Session ID, cipher suites, compression methods.
  if (!skip(1) || !skip(2) || !skip(1)) return { kind: "invalid" };
  if (at === hello.length) return { kind: "hello", serverName: undefined };
  if (at + 2 > hello.length) return { kind: "invalid" };
  const extensionsEnd = at + 2 + hello.readUInt16BE(at);
  if (extensionsEnd > hello.length) return { kind: "invalid" };
  at += 2;
  while (at + 4 <= extensionsEnd) {
    const type = hello.readUInt16BE(at);
    const length = hello.readUInt16BE(at + 2);
    const body = hello.subarray(at + 4, at + 4 + length);
    at += 4 + length;
    if (at > extensionsEnd) return { kind: "invalid" };
    if (type !== 0) continue;
    // server_name: a list of (type, name); only host_name (0) is defined.
    if (body.length < 5 || body[2] !== 0) return { kind: "invalid" };
    const nameLength = body.readUInt16BE(3);
    if (5 + nameLength > body.length) return { kind: "invalid" };
    return { kind: "hello", serverName: body.subarray(5, 5 + nameLength).toString("latin1") };
  }
  return { kind: "hello", serverName: undefined };
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
      let dnsTimer: NodeJS.Timeout | undefined;
      try {
        // A resolver that hangs mustn't hold the client open: give up after the connect timeout.
        addresses = await Promise.race([
          resolve(host),
          new Promise<never>((_, reject) => {
            dnsTimer = setTimeout(() => reject(new Error("DNS timeout")), connectTimeoutMs);
          }),
        ]);
      } catch {
        refuse("dns_failed", { host, port }, BAD_GATEWAY);
        return;
      } finally {
        clearTimeout(dnsTimer);
      }
      // All of them must be public: a name with one private answer is treated as hostile.
      const blocked = addresses.find((entry) => !isPublicAddress(entry.address));
      // The VPC is IPv4-only, so an IPv6 answer is dialed only when there's no IPv4 one.
      const [first] = [...addresses].sort((a, b) => a.family - b.family);
      if (first === undefined || blocked !== undefined) {
        refuse("private_address", { host, port, address: blocked?.address });
        return;
      }
      if (client.destroyed) return;

      const upstream = dial(first.address, port);
      let established = false;
      let helloTimer: NodeJS.Timeout | undefined;
      const close = () => {
        clearTimeout(lifetime);
        clearTimeout(helloTimer);
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
        client.write(ESTABLISHED);
        // Nothing goes upstream until the client's ClientHello names the tunnel's host.
        let buffered = head;
        helloTimer = setTimeout(() => {
          log({ event: "blocked", reason: "not_tls", client: remote, host, port });
          close();
        }, connectTimeoutMs);
        const check = (): boolean => {
          const hello = readClientHello(buffered);
          if (hello.kind === "incomplete" && buffered.length < MAX_HELLO_BYTES) return false;
          client.off("data", onData);
          client.off("end", close);
          clearTimeout(helloTimer);
          const name =
            hello.kind === "hello" ? hello.serverName?.toLowerCase().replace(/\.$/, "") : undefined;
          if (hello.kind !== "hello" || name !== host) {
            log({
              event: "blocked",
              reason: hello.kind === "hello" ? "sni_mismatch" : "not_tls",
              client: remote,
              host,
              port,
              ...(hello.kind === "hello"
                ? { serverName: (hello.serverName ?? "").slice(0, 253) }
                : {}),
            });
            close();
            return true;
          }
          log({ event: "tunnel", host, port, address: first.address, client: remote });
          upstream.write(buffered);
          upstream.pipe(client);
          client.pipe(upstream);
          return true;
        };
        const onData = (chunk: Buffer) => {
          buffered = Buffer.concat([buffered, chunk]);
          check();
        };
        if (!check()) {
          client.on("data", onData);
          // The HTTP server keeps sockets half-open: a client that ends before its ClientHello
          // would otherwise leave the tunnel waiting.
          client.once("end", close);
          client.resume();
        }
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
