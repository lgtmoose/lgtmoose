import { createProxy } from "./proxy.ts";

/**
 * Starts the egress proxy from its environment:
 * - ALLOWED_HOSTS: comma-separated exact hostnames (the CDK stack builds it from the config)
 * - PORT: where to listen, default 3128
 */
function main(): void {
  const allowedHosts = (process.env.ALLOWED_HOSTS ?? "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter((host) => host !== "");
  const port = Number(process.env.PORT ?? "3128");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`PORT must be a port number, got ${process.env.PORT}`);
  }

  const server = createProxy({ allowedHosts });
  server.listen(port, () => {
    process.stdout.write(
      `${JSON.stringify({ time: new Date().toISOString(), event: "listening", port, allowedHosts })}\n`,
    );
  });
  // ECS stops tasks with SIGTERM: stop accepting, let open tunnels end, then exit.
  process.on("SIGTERM", () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
  });
}

main();
