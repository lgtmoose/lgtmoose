import { request as httpRequest } from "node:http";

/**
 * The few Docker Engine API calls the docker compose runner makes to run one sandbox per batch
 * (NIC-843), over the Docker socket. No Docker CLI is needed in the image. Only the runner holds
 * the socket: never the gateway, never a sandbox. See docs/compose.md for what that means.
 */

/** The Engine API version every call names; 1.43 is Docker 24. */
const API = "/v1.43";

/** One HTTP exchange with the daemon. Injected in tests. */
export type DockerTransport = (call: {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  body?: Buffer | string;
  contentType?: string;
  timeoutMs?: number;
}) => Promise<{ status: number; body: Buffer }>;

/** A transport over the daemon's unix socket. */
export function socketTransport(socketPath: string): DockerTransport {
  return (call) =>
    new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          socketPath,
          method: call.method,
          path: call.path,
          headers:
            call.body === undefined
              ? {}
              : {
                  "content-type": call.contentType ?? "application/json",
                  "content-length": Buffer.byteLength(call.body),
                },
          timeout: call.timeoutMs ?? 60_000,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () =>
            resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }),
          );
          res.on("error", reject);
        },
      );
      req.on("timeout", () =>
        req.destroy(new Error(`Docker ${call.method} ${call.path} timed out.`)),
      );
      req.on("error", reject);
      if (call.body !== undefined) req.write(call.body);
      req.end();
    });
}

/** How one sandbox container is set up: everything locked down that can be. */
export interface SandboxContainer {
  image: string;
  /** Only the internal network, whose other member is the egress proxy. */
  network: string;
  env: Record<string, string>;
  /** Where the batch's files go: an anonymous volume, the only writable place but /tmp and /work. */
  batchPath: string;
  memoryBytes: number;
  cpus: number;
  /** A name the runner can find it by, to remove it after a crash. */
  name: string;
  labels: Record<string, string>;
  /** In place of the image's command: the integration test runs a shell, the runner never does. */
  command?: string[];
}

export class DockerError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "DockerError";
  }
}

/** Docker's own error text, never a request body (which can hold a credential). */
function failure(what: string, status: number, body: Buffer): DockerError {
  let reason = "";
  try {
    const parsed = JSON.parse(body.toString("utf8")) as { message?: unknown };
    if (typeof parsed.message === "string") reason = `: ${parsed.message.slice(0, 300)}`;
  } catch {
    // Not JSON.
  }
  return new DockerError(`Docker ${what} failed with HTTP ${status}${reason}`, status);
}

export class Docker {
  constructor(private readonly transport: DockerTransport) {}

  private async call(
    what: string,
    call: Parameters<DockerTransport>[0],
    ok: readonly number[] = [200, 201, 204],
  ): Promise<Buffer> {
    const reply = await this.transport({ ...call, path: `${API}${call.path}` });
    if (!ok.includes(reply.status)) throw failure(what, reply.status, reply.body);
    return reply.body;
  }

  /** Whether a network exists (the compose project's internal sandbox network). */
  async networkExists(name: string): Promise<boolean> {
    const reply = await this.transport({
      method: "GET",
      path: `${API}/networks/${encodeURIComponent(name)}`,
    });
    if (reply.status === 404) return false;
    if (reply.status !== 200) throw failure("network inspect", reply.status, reply.body);
    const network = JSON.parse(reply.body.toString("utf8")) as { Internal?: unknown };
    if (network.Internal !== true) {
      throw new DockerError(`The sandbox network ${name} isn't internal: refusing to use it.`, 0);
    }
    return true;
  }

  /**
   * Creates a sandbox container, not started. Read-only root filesystem, every capability
   * dropped, no new privileges, a pid limit, memory and CPU caps, its own user (the image's),
   * and an anonymous volume for the batch's files. No socket, no host path is mounted.
   */
  async createSandbox(spec: SandboxContainer): Promise<string> {
    const body = JSON.stringify({
      Image: spec.image,
      ...(spec.command === undefined ? {} : { Cmd: spec.command, Entrypoint: [] }),
      Env: Object.entries(spec.env).map(([key, value]) => `${key}=${value}`),
      Labels: spec.labels,
      NetworkDisabled: false,
      HostConfig: {
        NetworkMode: spec.network,
        ReadonlyRootfs: true,
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges"],
        PidsLimit: 512,
        Memory: spec.memoryBytes,
        NanoCpus: Math.round(spec.cpus * 1e9),
        Tmpfs: { "/tmp": "rw,nosuid,size=1g", "/work": "rw,nosuid,size=8g" },
        Mounts: [{ Type: "volume", Target: spec.batchPath }],
        Privileged: false,
        AutoRemove: false,
      },
    });
    const reply = await this.call("create", {
      method: "POST",
      path: `/containers/create?name=${encodeURIComponent(spec.name)}`,
      body,
    });
    const created = JSON.parse(reply.toString("utf8")) as { Id?: unknown };
    if (typeof created.Id !== "string") throw new DockerError("Docker create returned no ID.", 0);
    return created.Id;
  }

  /** Extracts an uncompressed tar archive into `path` in the container. */
  async putArchive(id: string, path: string, tar: Buffer): Promise<void> {
    await this.call("copy in", {
      method: "PUT",
      path: `/containers/${id}/archive?path=${encodeURIComponent(path)}`,
      body: tar,
      contentType: "application/x-tar",
      timeoutMs: 300_000,
    });
  }

  /** `path` in the container as an uncompressed tar archive, or undefined when it's not there. */
  async getArchive(id: string, path: string): Promise<Buffer | undefined> {
    const reply = await this.transport({
      method: "GET",
      path: `${API}/containers/${id}/archive?path=${encodeURIComponent(path)}`,
      timeoutMs: 300_000,
    });
    if (reply.status === 404) return undefined;
    if (reply.status !== 200) throw failure("copy out", reply.status, reply.body);
    return reply.body;
  }

  async start(id: string): Promise<void> {
    await this.call("start", { method: "POST", path: `/containers/${id}/start` }, [204, 304]);
  }

  /** Waits for the container to stop and returns its exit code; kills it after `timeoutMs`. */
  async wait(id: string, timeoutMs: number): Promise<number> {
    try {
      const reply = await this.call("wait", {
        method: "POST",
        path: `/containers/${id}/wait`,
        timeoutMs,
      });
      const waited = JSON.parse(reply.toString("utf8")) as { StatusCode?: unknown };
      return typeof waited.StatusCode === "number" ? waited.StatusCode : -1;
    } catch (error) {
      await this.kill(id);
      throw error;
    }
  }

  async kill(id: string): Promise<void> {
    await this.call("kill", { method: "POST", path: `/containers/${id}/kill` }, [204, 404, 409]);
  }

  /** The container's last output lines (stdout and stderr), for the log. */
  async logs(id: string, tail = 50): Promise<string> {
    const reply = await this.call("logs", {
      method: "GET",
      path: `/containers/${id}/logs?stdout=1&stderr=1&tail=${tail}`,
    });
    return demux(reply);
  }

  /** Removes the container and its anonymous volume. */
  async remove(id: string): Promise<void> {
    await this.call(
      "remove",
      { method: "DELETE", path: `/containers/${id}?v=1&force=1` },
      [204, 404],
    );
  }

  /** Containers with a label, to clean up what a crashed runner left. */
  async listByLabel(label: string): Promise<string[]> {
    const filters = encodeURIComponent(JSON.stringify({ label: [label] }));
    const reply = await this.call("list", {
      method: "GET",
      path: `/containers/json?all=1&filters=${filters}`,
    });
    const containers = JSON.parse(reply.toString("utf8")) as { Id?: unknown }[];
    return containers.flatMap((container) =>
      typeof container.Id === "string" ? [container.Id] : [],
    );
  }
}

/** Docker's multiplexed log stream (8-byte frame headers) as text. */
export function demux(stream: Buffer): string {
  const parts: string[] = [];
  let offset = 0;
  while (offset + 8 <= stream.length) {
    const size = stream.readUInt32BE(offset + 4);
    parts.push(stream.subarray(offset + 8, offset + 8 + size).toString("utf8"));
    offset += 8 + size;
  }
  // A container with a TTY sends raw text, without frames.
  return offset === 0 ? stream.toString("utf8") : parts.join("");
}
