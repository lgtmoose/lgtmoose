import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname } from "node:path";
import { createGunzip } from "node:zlib";

export interface HttpGitServer {
  /** Clone URL for the repository. */
  url: string;
  /** Authorization headers of every request, in order. */
  authorizations: (string | undefined)[];
  /** Makes every request after the next `count` fail with this status. */
  failAfter(count: number, status: number): void;
  close(): Promise<void>;
}

/**
 * Serves a bare repository over smart HTTP with `git http-backend`, like GitHub does, and turns
 * away requests without the expected `Authorization` header, so tests can check that the token
 * reaches every kind of fetch.
 */
export async function serveOverHttp(
  bareRepo: string,
  expectedAuthorization: string,
): Promise<HttpGitServer> {
  const authorizations: (string | undefined)[] = [];
  let budget = Infinity;
  let failStatus = 500;
  const server: Server = createServer((req: IncomingMessage, res) => {
    const auth = req.headers.authorization;
    authorizations.push(auth);
    if (budget-- <= 0) {
      res.writeHead(failStatus).end("failing on purpose");
      return;
    }
    if (auth !== expectedAuthorization) {
      res.writeHead(401, { "WWW-Authenticate": 'Basic realm="git"' }).end();
      return;
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    const backend = spawn("git", ["http-backend"], {
      env: {
        ...process.env,
        GIT_PROJECT_ROOT: dirname(bareRepo),
        GIT_HTTP_EXPORT_ALL: "1",
        PATH_INFO: url.pathname,
        QUERY_STRING: url.search.slice(1),
        REQUEST_METHOD: req.method ?? "GET",
        CONTENT_TYPE: req.headers["content-type"] ?? "",
        GIT_PROTOCOL: String(req.headers["git-protocol"] ?? ""),
        REMOTE_ADDR: "127.0.0.1",
      },
    });
    const body = req.headers["content-encoding"] === "gzip" ? req.pipe(createGunzip()) : req;
    body.pipe(backend.stdin);
    // CGI output: headers, a blank line, then the body.
    let head = Buffer.alloc(0);
    let headersSent = false;
    backend.stdout.on("data", (chunk: Buffer) => {
      if (headersSent) {
        res.write(chunk);
        return;
      }
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end === -1) return;
      let status = 200;
      for (const line of head.subarray(0, end).toString("utf8").split("\r\n")) {
        const colon = line.indexOf(":");
        const name = line.slice(0, colon).trim();
        const value = line.slice(colon + 1).trim();
        if (name.toLowerCase() === "status") status = Number(value.split(" ")[0]);
        else res.setHeader(name, value);
      }
      res.writeHead(status);
      headersSent = true;
      res.write(head.subarray(end + 4));
    });
    backend.on("close", () => res.end());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/${bareRepo.split("/").pop() ?? ""}`,
    authorizations,
    failAfter(count, status) {
      budget = count;
      failStatus = status;
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
