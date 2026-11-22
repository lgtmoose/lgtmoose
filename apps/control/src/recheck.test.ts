import { describe, expect, it } from "vitest";
import type { FindingRecord } from "./ports.js";
import {
  fixedByRecheck,
  isRelated,
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
});

describe("fixedByRecheck", () => {
  const changed = ["src/pay/PaymentSection.tsx"];
  const context = { reraised: new Set<string>(), open: new Set(["f1", "f2"]) };

  it("closes only what a verdict says is gone, the first verdict for an id counting", () => {
    const job = {
      changed,
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
    const job = { changed, targets: [entry()] };
    const gone = [{ id: "F1", confirmed: false, reason: "fixed" }];
    expect(fixedByRecheck(job, gone, { ...context, reraised: new Set(["fp1"]) })).toEqual([]);
    expect(fixedByRecheck(job, gone, { ...context, open: new Set() })).toEqual([]);
    expect(fixedByRecheck(job, [], context)).toEqual([]);
  });

  it("needs a protected-category verdict to name a changed file as the fix", () => {
    const job = { changed, targets: [entry({ ruleCategory: "authz" })] };
    expect(
      fixedByRecheck(job, [{ id: "F1", confirmed: false, reason: "Looks handled." }], context),
    ).toEqual([]);
    expect(
      fixedByRecheck(
        job,
        [{ id: "F1", confirmed: false, reason: "src/pay/PaymentSection.tsx line 4 checks it." }],
        context,
      ),
    ).toHaveLength(1);
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
