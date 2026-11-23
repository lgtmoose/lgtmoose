import { describe, expect, it } from "vitest";
import type { FindingRecord } from "./ports.js";
import {
  fixedByRecheck,
  fullReviewSince,
  isRelated,
  namesRelatedFile,
  rankRechecks,
  recheckJob,
  recheckReply,
  relativeImports,
  selectRechecks,
  type RecheckEntry,
} from "./recheck.js";

function record(overrides: Partial<FindingRecord> = {}): FindingRecord {
  return {
    id: "f1",
    fingerprint: "fp1",
    ruleCategory: "correctness",
    severity: "blocking",
    path: "src/pay/TeeTimePayment.tsx",
    line: 12,
    startLine: undefined,
    side: "RIGHT",
    title: "Saved card is never charged",
    body: "pay ignores savedPaymentMethodId.",
    raisedAtSha: "a".repeat(40),
    status: "open",
    githubCommentId: 1000,
    basePath: undefined,
    ...overrides,
  };
}

const entry = (overrides: Partial<RecheckEntry> = {}): RecheckEntry => ({
  id: "F1",
  findingId: "f1",
  fingerprint: "fp1",
  path: "src/pay/TeeTimePayment.tsx",
  ruleCategory: "correctness",
  severity: "blocking",
  ...overrides,
});

describe("relativeImports", () => {
  it("reads relative imports, requires and dynamic imports, from the repository root", () => {
    const text = [
      'import { pay } from "./pay";',
      "import type { Card } from '../cards/types.ts';",
      'const lazy = import("./lazy/index.js");',
      'const legacy = require("../legacy");',
      'import "./side-effect";',
      'import React from "react";',
    ].join("\n");
    expect([...relativeImports("src/pay/Payment.tsx", text)].sort()).toEqual([
      "src/cards/types",
      "src/legacy",
      "src/pay/lazy",
      "src/pay/pay",
      "src/pay/side-effect",
    ]);
  });

  it("ignores an import that climbs out of the repository", () => {
    expect([...relativeImports("a.ts", 'import x from "../../outside";')]).toEqual([]);
  });
});

describe("isRelated", () => {
  const none = new Map<string, Set<string>>();

  it("relates the same file and files in the same directory", () => {
    expect(isRelated("src/pay/A.tsx", "src/pay/A.tsx", none)).toBe(true);
    expect(isRelated("src/pay/A.tsx", "src/pay/useA.ts", none)).toBe(true);
    expect(isRelated("src/pay/A.tsx", "src/cart/B.tsx", none)).toBe(false);
  });

  it("relates files that import each other, either way", () => {
    const imports = new Map([
      ["src/pay/A.tsx", new Set(["src/lib/stripe"])],
      ["src/cart/B.tsx", new Set(["src/pay/A"])],
    ]);
    expect(isRelated("src/pay/A.tsx", "src/lib/stripe.ts", imports)).toBe(true);
    expect(isRelated("src/pay/A.tsx", "src/cart/B.tsx", imports)).toBe(true);
    expect(isRelated("src/pay/A.tsx", "src/lib/other.ts", imports)).toBe(false);
  });
});

describe("selectRechecks", () => {
  it("takes open blocking and should-fix findings near the change, blocking first, capped", () => {
    const records = [
      record({ id: "s1", severity: "should_fix" }),
      record({ id: "n1", severity: "nit" }),
      record({ id: "b1" }),
      record({ id: "far", path: "docs/guide.md" }),
      record({ id: "old", status: "outdated" }),
      record({ id: "left", side: "LEFT" }),
      record({ id: "b2" }),
    ];
    const chosen = selectRechecks(records, ["src/pay/usePayment.ts"], new Map(), 2);
    expect(chosen.map((row) => row.id)).toEqual(["b1", "b2"]);
    expect(
      selectRechecks(records, ["src/pay/usePayment.ts"], new Map()).map((row) => row.id),
    ).toEqual(["b1", "b2", "s1"]);
    expect(selectRechecks(records, [], new Map())).toEqual([]);
  });

  it("orders each severity by when the commit it was raised at was made, not input order", () => {
    const records = [
      record({ id: "late", raisedAtSha: "c".repeat(40) }),
      record({ id: "early", raisedAtSha: "b".repeat(40) }),
      record({ id: "unknown", raisedAtSha: "d".repeat(40) }),
      record({ id: "fix-early", severity: "should_fix", raisedAtSha: "b".repeat(40) }),
    ];
    const raisedAt = new Map([
      ["b".repeat(40), 100],
      ["c".repeat(40), 200],
    ]);
    expect(
      selectRechecks(records, ["src/pay/x.ts"], new Map(), 10, raisedAt).map((row) => row.id),
    ).toEqual(["early", "late", "unknown", "fix-early"]);
  });
});

describe("namesRelatedFile", () => {
  it("matches a related file's full path standing on its own", () => {
    expect(namesRelatedFile("src/pay/Section.tsx line 4 maps it.", ["src/pay/Section.tsx"])).toBe(
      true,
    );
    expect(namesRelatedFile("Fixed in `src/db.ts`.", ["src/db.ts"])).toBe(true);
    expect(namesRelatedFile("See src/db.ts: line 2", ["src/db.ts"])).toBe(true);
  });

  it("doesn't match a file name alone, or a path inside a longer one", () => {
    // Another directory's index.ts isn't this one.
    expect(namesRelatedFile("src/web/index.ts guards it.", ["src/api/index.ts"])).toBe(false);
    expect(namesRelatedFile("index.ts guards it.", ["src/api/index.ts"])).toBe(false);
    // mydb.ts isn't db.ts, nor is a longer path that ends in it.
    expect(namesRelatedFile("src/mydb.ts line 3 checks it.", ["src/db.ts"])).toBe(false);
    expect(namesRelatedFile("lib/src/db.ts checks it.", ["src/db.ts"])).toBe(false);
    expect(namesRelatedFile("src/db.tsx checks it.", ["src/db.ts"])).toBe(false);
    expect(namesRelatedFile("src/db.ts.bak checks it.", ["src/db.ts"])).toBe(false);
  });
});

describe("fixedByRecheck", () => {
  const related = ["src/pay/PaymentSection.tsx"];
  const context = { reraised: new Set<string>(), open: new Set(["f1", "f2"]) };

  it("closes only what a verdict says is gone, the first verdict for an id counting", () => {
    const job = {
      targets: [entry(), entry({ id: "F2", findingId: "f2", fingerprint: "fp2" })],
    };
    const fixes = fixedByRecheck(
      job,
      [
        { id: "F1", confirmed: false, reason: "PaymentSection.tsx maps the saved card." },
        { id: "F1", confirmed: true, reason: "ignored: a later verdict" },
        { id: "F2", confirmed: true, reason: "Still there." },
        { id: "F9", confirmed: false, reason: "no such finding" },
      ],
      context,
    );
    expect(fixes.map((fix) => fix.entry.findingId)).toEqual(["f1"]);
  });

  it("keeps one raised again, one no longer open, and one with no verdict", () => {
    const job = { targets: [entry()] };
    const gone = [{ id: "F1", confirmed: false, reason: "fixed" }];
    expect(fixedByRecheck(job, gone, { ...context, reraised: new Set(["fp1"]) })).toEqual([]);
    expect(fixedByRecheck(job, gone, { ...context, open: new Set() })).toEqual([]);
    expect(fixedByRecheck(job, [], context)).toEqual([]);
  });

  it("needs a protected-category verdict to name a related changed file by its path", () => {
    const job = { targets: [entry({ ruleCategory: "authz", related })] };
    const verdict = (reason: string) => [{ id: "F1", confirmed: false, reason }];
    expect(fixedByRecheck(job, verdict("Looks handled."), context)).toEqual([]);
    // Its file name alone, or a changed file that isn't related to the finding, isn't enough.
    expect(fixedByRecheck(job, verdict("PaymentSection.tsx line 4 checks it."), context)).toEqual(
      [],
    );
    expect(fixedByRecheck(job, verdict("src/cart/Unrelated.tsx checks it."), context)).toEqual([]);
    expect(
      fixedByRecheck(job, verdict("src/pay/PaymentSection.tsx line 4 checks it."), context),
    ).toHaveLength(1);
    // A manifest from before `related` was kept: no path counts.
    const old = { targets: [entry({ ruleCategory: "authz" })] };
    expect(
      fixedByRecheck(old, verdict("src/pay/PaymentSection.tsx line 4 checks it."), context),
    ).toEqual([]);
  });
});

describe("recheckReply", () => {
  it("names the commit and escapes the verdict's reason", () => {
    const reply = recheckReply("0123456789abcdef", "See @dev's [link](https://x.test).");
    expect(reply).toMatch(/^This looks fixed at 0123456,/);
    expect(reply).not.toContain("@dev");
    expect(reply).not.toContain("](https://");
  });
});

describe("recheckJob", () => {
  it("puts the PR's own changed files before those a base merge brought in", async () => {
    // Since the last review: the PR's own fix in src/pay/checkout.ts, and many files a merge
    // of the base branch brought in, all in the same folder as the finding.
    const merged = Array.from(
      { length: 60 },
      (_, i) => `src/pay/aa${String(i).padStart(2, "0")}.ts`,
    );
    const diffs: string[] = [];
    const repo = {
      fetchCommits: async () => {},
      git: async (args: string[]) => {
        if (args[0] === "diff" && args.includes("--name-only")) {
          return args.some((arg) => arg.includes("..."))
            ? "src/pay/checkout.ts\nsrc/pay/TeeTimePayment.tsx\n"
            : [...merged, "src/pay/checkout.ts"].join("\n");
        }
        if (args[0] === "diff") {
          const path = args.at(-1) ?? "";
          diffs.push(path);
          return `diff --git a/${path} b/${path}\n`;
        }
        if (args[0] === "cat-file") return "10";
        if (args[0] === "show" && args[1] === "-s") return "1700000000";
        return "export const x = 1;\n";
      },
    };
    const job = await recheckJob({
      repo: repo as unknown as Parameters<typeof recheckJob>[0]["repo"],
      records: [record()],
      skip: new Set(),
      sinceSha: "a".repeat(40),
      headSha: "b".repeat(40),
      baseSha: "c".repeat(40),
      index: 0,
      log: () => {},
    });
    expect(job?.changed[0]).toBe("src/pay/checkout.ts");
    expect(job?.changed).toHaveLength(61);
    // The PR's own change is the first diff read, ahead of the merged ones.
    expect(diffs[0]).toBe("src/pay/checkout.ts");
  });
});

describe("findings someone said are fixed (NIC-1140)", () => {
  const claimed = "2026-11-23T10:00:00.000Z";

  it("come first, whatever their severity or line", () => {
    const records = [
      record({ id: "blocking" }),
      record({ id: "claimed-nit", severity: "nit", fixClaimedAt: claimed }),
      record({ id: "claimed-outdated", status: "outdated", fixClaimedAt: claimed }),
      record({ id: "nit", severity: "nit" }),
      record({ id: "claimed-left", side: "LEFT", fixClaimedAt: claimed }),
    ];
    expect(rankRechecks(records, 10).map((row) => row.id)).toEqual([
      "claimed-nit",
      "claimed-outdated",
      "blocking",
    ]);
    expect(rankRechecks(records, 1).map((row) => row.id)).toEqual(["claimed-nit"]);
  });

  it("count on an incremental review when anything changed, near the finding or not", () => {
    const records = [
      record({ id: "far", path: "docs/guide.md", severity: "nit", fixClaimedAt: claimed }),
      record({ id: "unclaimed-far", path: "docs/other.md" }),
    ];
    expect(
      selectRechecks(records, ["src/pay/usePayment.ts"], new Map()).map((row) => row.id),
    ).toEqual(["far"]);
    // Nothing changed: nothing could have fixed it.
    expect(selectRechecks(records, [], new Map())).toEqual([]);
  });
});

describe("rankRechecks (NIC-1123)", () => {
  it("takes open blocking and should-fix findings anywhere, blocking first, oldest first", () => {
    const old = "b".repeat(40);
    const records = [
      record({ id: "s", severity: "should_fix", path: "far/away.ts" }),
      record({ id: "n", severity: "nit" }),
      record({ id: "new", raisedAtSha: "a".repeat(40) }),
      record({ id: "old", raisedAtSha: old, path: "other/place.ts" }),
      record({ id: "left", side: "LEFT" }),
    ];
    const times = new Map([
      ["a".repeat(40), 200],
      [old, 100],
    ]);
    expect(rankRechecks(records, 10, times).map((row) => row.id)).toEqual(["old", "new", "s"]);
    expect(rankRechecks(records, 1, times).map((row) => row.id)).toEqual(["old"]);
  });

  it("puts findings whose cited line is gone after open blocking and should-fix ones (NIC-1124)", () => {
    const records = [
      record({ id: "earlier-nit", severity: "nit", status: "outdated" }),
      record({ id: "gone-nit", severity: "nit" }),
      record({ id: "gone-blocking" }),
      record({ id: "nit", severity: "nit" }),
      record({ id: "earlier-blocking", status: "outdated" }),
      record({ id: "should", severity: "should_fix" }),
      record({ id: "blocking" }),
      record({ id: "gone-should", severity: "should_fix" }),
    ];
    const outdating = new Map(
      ["gone-nit", "gone-blocking", "gone-should"].map((id) => [id, "gone" as const]),
    );
    expect(rankRechecks(records, 10, new Map(), outdating).map((row) => row.id)).toEqual([
      "blocking",
      "should",
      "gone-blocking",
      "gone-should",
      "gone-nit",
      "earlier-blocking",
      "earlier-nit",
    ]);
    // The cap keeps open blocking findings ahead of outdated nits.
    expect(rankRechecks(records, 2, new Map(), outdating).map((row) => row.id)).toEqual([
      "blocking",
      "should",
    ]);
  });

  it("counts an outdated finding whose cited line is back as open: no nits", () => {
    const records = [
      record({ id: "back-nit", severity: "nit", status: "outdated" }),
      record({ id: "back", status: "outdated" }),
      record({ id: "gone", severity: "nit", status: "outdated" }),
    ];
    const lines = new Map([
      ["back-nit", "there" as const],
      ["back", "there" as const],
      ["gone", "gone" as const],
    ]);
    expect(rankRechecks(records, 10, new Map(), lines).map((row) => row.id)).toEqual([
      "back",
      "gone",
    ]);
  });

  it("takes one whose line is gone only when its own file changed, on an incremental review", () => {
    const records = [
      record({ id: "gone", severity: "nit", path: "src/cart/Cart.tsx" }),
      record({ id: "earlier", status: "outdated", path: "src/cart/Total.tsx" }),
    ];
    const outdating = new Map([["gone", "gone" as const]]);
    // A file next to them changed: not enough for these.
    expect(
      selectRechecks(records, ["src/cart/Other.tsx"], new Map(), 10, new Map(), outdating),
    ).toEqual([]);
    expect(
      selectRechecks(
        records,
        ["src/cart/Cart.tsx", "src/cart/Total.tsx"],
        new Map(),
        10,
        new Map(),
        outdating,
      ).map((row) => row.id),
    ).toEqual(["gone", "earlier"]);
  });
});

describe("fullReviewSince (NIC-1123)", () => {
  const a = "a".repeat(40);
  const b = "b".repeat(40);
  const base = "m".repeat(40);
  const times = new Map([
    [a, 200],
    [b, 100],
  ]);
  const repo = (ancestors: readonly string[]) => ({
    git: async (args: readonly string[]) => {
      if (args[0] === "merge-base" && args[1] === "--is-ancestor") {
        if (ancestors.includes(args[2] ?? "")) return "";
        throw new Error("not an ancestor");
      }
      if (args[0] === "merge-base") return `${base}\n`;
      throw new Error(`unexpected: ${args.join(" ")}`);
    },
  });
  const since = (
    ancestors: readonly string[],
    chosen: { raisedAtSha: string }[],
    baseSha: string | undefined,
  ) =>
    fullReviewSince(
      repo(ancestors) as unknown as Parameters<typeof fullReviewSince>[0],
      chosen,
      times,
      "h".repeat(40),
      baseSha,
    );

  it("measures from the oldest raised commit still in head's history", async () => {
    const chosen = [{ raisedAtSha: a }, { raisedAtSha: b }];
    expect(await since([a, b], chosen, "c".repeat(40))).toBe(b);
    expect(await since([a], chosen, "c".repeat(40))).toBe(a);
  });

  it("falls back to the merge base when no raised commit is reachable", async () => {
    expect(await since([], [{ raisedAtSha: a }], "c".repeat(40))).toBe(base);
    expect(await since([], [{ raisedAtSha: a }], undefined)).toBeUndefined();
  });
});
