import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Docker, socketTransport, type DockerTransport } from "./docker.js";
import { readTar, writeTar } from "./tar.js";

/**
 * The sandbox container settings against a real Docker daemon: read-only root filesystem, no
 * route out of its internal network, files in and out of its batch volume, and removal. Runs
 * when LGTMOOSE_TEST_DOCKER is set (CI's compose job), with LGTMOOSE_TEST_IMAGE pulled first.
 */
const enabled = process.env.LGTMOOSE_TEST_DOCKER === "1";
const image = process.env.LGTMOOSE_TEST_IMAGE ?? "busybox:1.37";
const NETWORK = `lgtmoose-test-sandbox-${process.pid}`;

describe.skipIf(!enabled)("sandbox containers on Docker", () => {
  let transport: DockerTransport;
  let docker: Docker;

  beforeAll(async () => {
    transport = socketTransport(process.env.DOCKER_SOCKET ?? "/var/run/docker.sock");
    docker = new Docker(transport);
    const reply = await transport({
      method: "POST",
      path: "/v1.43/networks/create",
      body: JSON.stringify({ Name: NETWORK, Internal: true }),
    });
    expect(reply.status).toBe(201);
  }, 60_000);

  afterAll(async () => {
    for (const { id } of await docker.listByLabel(`lgtmoose.test=${NETWORK}`)) {
      await docker.remove(id);
    }
    await transport({ method: "DELETE", path: `/v1.43/networks/${NETWORK}` });
  });

  it("refuses a network that isn't internal", async () => {
    await expect(docker.networkExists("bridge")).rejects.toThrow(/isn't internal/);
    expect(await docker.networkExists(NETWORK)).toBe(true);
    expect(await docker.networkExists("lgtmoose-no-such-network")).toBe(false);
  });

  it("runs locked down, reads its batch and hands back what it wrote", async () => {
    const script = [
      "cat /batch/io/input.json > /batch/io/output.json",
      "touch /rootfs-probe 2>/dev/null && echo rootfs-writable >> /batch/io/output.json",
      "wget -q -T 3 -O /dev/null http://1.1.1.1 2>/dev/null && echo network-open >> /batch/io/output.json",
      "ln -s /etc/passwd /batch/io/link",
      "exit 0",
    ].join("; ");
    const id = await docker.createSandbox({
      image,
      network: NETWORK,
      env: { LGTMOOSE_PROVIDER: "test" },
      batchPath: "/batch",
      memoryBytes: 256 * 1024 * 1024,
      cpus: 0.5,
      name: `lgtmoose-test-${process.pid}-${Date.now()}`,
      labels: { "lgtmoose.test": NETWORK },
      command: ["sh", "-c", script],
    });
    try {
      await docker.putArchive(
        id,
        "/batch",
        writeTar([
          { name: "io", mode: 0o777, uid: 0, gid: 0 },
          { name: "io/input.json", body: Buffer.from("hello"), mode: 0o644, uid: 0, gid: 0 },
        ]),
      );
      await docker.start(id);
      expect(await docker.wait(id, 60_000)).toBe(0);
      const archive = await docker.getArchive(id, "/batch/io");
      expect(archive).toBeDefined();
      const files = readTar(archive ?? Buffer.alloc(0), 1_000_000);
      // Exactly what it was given: it couldn't write its root filesystem or reach out.
      expect(files.get("io/output.json")?.toString()).toBe("hello");
      // The symlink it made isn't handed back as a file.
      expect(files.has("io/link")).toBe(false);
    } finally {
      await docker.remove(id);
    }
    const left = await docker.listByLabel(`lgtmoose.test=${NETWORK}`);
    expect(left.map((container) => container.id)).not.toContain(id);
  }, 120_000);
});
