import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Batch I/O for the docker compose deployment (NIC-843), where a sandbox has no S3. The runner
 * writes the batch's presigned-URL set with URLs under `LOCAL_BATCH_ORIGIN` and copies just this
 * batch's objects (its `urls.json`, input and checkout) into the container's `/batch/io` before
 * it starts. A GET reads one of those files; a PUT writes one, which the runner copies back to
 * the artifact store when the container stops. The container holds no other run's data, and
 * this never touches the network.
 */

/** The origin the runner's local URLs use. `.invalid` never resolves, so nothing leaves. */
export const LOCAL_BATCH_ORIGIN = "https://batch.invalid";

/** A file name the runner gave an object: the URL path, one segment, no dots of its own. */
const NAME = /^[A-Za-z0-9_%-][A-Za-z0-9._%-]{0,511}$/;

/** The file a local batch URL names, or undefined for anything else. */
export function localBatchFile(dir: string, url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.origin !== LOCAL_BATCH_ORIGIN || parsed.search !== "" || parsed.hash !== "") {
    return undefined;
  }
  const name = parsed.pathname.slice(1);
  if (!NAME.test(name) || name.includes("..")) return undefined;
  return join(dir, name);
}

/**
 * A `fetch` for local batch URLs: GET reads the file, PUT writes it. Any other URL or method is
 * refused, so the sandbox's batch code can't reach out by this route.
 */
export function localBatchFetch(dir: string): typeof fetch {
  const local = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    let url: string;
    if (typeof input === "string") url = input;
    else if (input instanceof URL) url = input.href;
    else url = input.url;
    const file = localBatchFile(dir, url);
    if (file === undefined) return new Response("not a local batch URL", { status: 403 });
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "GET") {
      try {
        return new Response(await readFile(file));
      } catch {
        return new Response("not found", { status: 404 });
      }
    }
    if (method === "PUT") {
      const body = init?.body;
      if (typeof body !== "string") return new Response("a string body", { status: 400 });
      await mkdir(dir, { recursive: true });
      await writeFile(file, body, { mode: 0o600 });
      return new Response(null, { status: 200 });
    }
    return new Response("method not allowed", { status: 405 });
  };
  return local as typeof fetch;
}
