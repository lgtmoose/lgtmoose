import type { Finding } from "@lgtmoose/core";
import { parsePatch, type FileDiff } from "@lgtmoose/git";

export const PATCH = `diff --git a/src/total.ts b/src/total.ts
--- a/src/total.ts
+++ b/src/total.ts
@@ -8,7 +8,8 @@ export function total(items: Item[]): number {
   let sum = 0;
-  for (let i = 0; i < items.length; i++) {
+  for (let i = 0; i < items.length - 1; i++) {
     sum += items[i].price;
   }
+  // a comment
   return sum;
 }
`;

export function fileDiff(patch = PATCH): FileDiff {
  const [parsed] = parsePatch(patch);
  return {
    path: parsed?.newPath ?? "src/total.ts",
    status: "modified",
    oldBlob: "1".repeat(40),
    newBlob: "2".repeat(40),
    submodule: false,
    moved: false,
    mechanical: false,
    binary: false,
    hunks: parsed?.hunks ?? [],
  };
}

export function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    rule_category: "correctness",
    severity: "blocking",
    path: "src/total.ts",
    line: 9,
    side: "RIGHT",
    title: "Off by one",
    body: "The loop skips the last item.",
    evidence: "for (let i = 0; i < items.length - 1; i++) {",
    ...overrides,
  };
}

function urlOf(url: string | URL | Request): string {
  if (typeof url === "string") return url;
  return url instanceof URL ? url.href : url.url;
}

/** A fetch that answers from a queue and records each request. */
export function fakeFetch(responses: { status: number; body?: unknown }[]): {
  fetch: typeof fetch;
  calls: { method: string; url: string; body: unknown; auth: string }[];
} {
  const calls: { method: string; url: string; body: unknown; auth: string }[] = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({
      method: init?.method ?? "GET",
      url: urlOf(url),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      auth: headers.get("authorization") ?? "",
    });
    const next = responses.shift() ?? { status: 200, body: {} };
    return new Response(next.status === 204 ? null : JSON.stringify(next.body ?? {}), {
      status: next.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { fetch: fetchFn, calls };
}
