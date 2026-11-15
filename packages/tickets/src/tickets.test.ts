import { describe, expect, it, vi } from "vitest";
import { findTicketKeys } from "./find.js";
import { LINEAR_LIMITS, linearProvider } from "./linear.js";
import { TicketProviderError } from "./ticket.js";

const empty = { branch: "", title: "", body: "", commits: [] };

describe("findTicketKeys", () => {
  it("reads the branch case-insensitively and other text upper case only", () => {
    const refs = findTicketKeys({
      branch: "alice/eng-123-fix-totals",
      title: "Fix totals (ENG-124)",
      body: "Also see web-9 and OPS-7.",
      commits: ["ENG-123: first", "Refs CORE-1"],
    });
    expect(refs).toEqual([
      { key: "ENG-123", source: "branch" },
      { key: "ENG-124", source: "title" },
      { key: "OPS-7", source: "body" },
      { key: "CORE-1", source: "commit" },
    ]);
  });

  it("leaves out standards and encodings, numbers with a leading zero, and parts of words", () => {
    const refs = findTicketKeys({
      ...empty,
      body: "UTF-8, SHA-256, ISO-8601, RFC-2119, CVE-2024, ENG-007, pre-ENG-5, ENG-5x, ENG_5",
    });
    expect(refs).toEqual([]);
  });

  it("keeps only the configured teams' keys", () => {
    const refs = findTicketKeys(
      { ...empty, title: "ENG-1 WEB-2 UTF-8", branch: "x/ops-3" },
      { teamKeys: ["eng", "UTF"] },
    );
    expect(refs.map((ref) => ref.key)).toEqual(["ENG-1", "UTF-8"]);
  });

  it("lists each key once, where it was found first", () => {
    const refs = findTicketKeys({ ...empty, title: "ENG-1", body: "ENG-1", commits: ["ENG-1"] });
    expect(refs).toEqual([{ key: "ENG-1", source: "title" }]);
  });
});

function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const issue = {
  identifier: "ENG-123",
  title: "Totals",
  description: "- Must round to cents\n- Should log",
  url: "https://linear.app/acme/issue/ENG-123/totals",
  updatedAt: "2026-11-14T10:00:00.000Z",
  state: { name: "In Progress" },
  parent: { identifier: "ENG-100", title: "Billing", description: "Parent text", state: null },
  children: { nodes: [{ identifier: "ENG-124", title: "Rounding", state: { name: "Todo" } }] },
  comments: {
    nodes: [{ body: "Also cents", createdAt: "2026-11-14T09:00:00.000Z", user: { name: "Bo" } }],
  },
};

describe("linearProvider", () => {
  it("queries by identifier with the key in the Authorization header only", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => reply({ data: { issue } }));
    const provider = linearProvider({ apiKey: " lin_api_secret ", fetch });
    const ticket = await provider.fetch("ENG-123");
    expect(ticket).toEqual({
      key: "ENG-123",
      title: "Totals",
      description: "- Must round to cents\n- Should log",
      url: "https://linear.app/acme/issue/ENG-123/totals",
      updatedAt: "2026-11-14T10:00:00.000Z",
      state: "In Progress",
      comments: [{ author: "Bo", body: "Also cents", createdAt: "2026-11-14T09:00:00.000Z" }],
      parent: { key: "ENG-100", title: "Billing", description: "Parent text" },
      children: [{ key: "ENG-124", title: "Rounding", state: "Todo" }],
    });
    const [url, init] = fetch.mock.calls[0] ?? [];
    if (init === undefined) throw new Error("no request");
    expect(url).toBe("https://api.linear.app/graphql");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe("lin_api_secret");
    const sent = typeof init.body === "string" ? init.body : "";
    const body = JSON.parse(sent) as { query: string; variables: unknown };
    expect(body.variables).toEqual({ id: "ENG-123" });
    expect(body.query).not.toMatch(/mutation/i);
    expect(sent).not.toContain("lin_api_secret");
  });

  it("caps long text", async () => {
    const long = "x".repeat(LINEAR_LIMITS.description + 50);
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      reply({ data: { issue: { ...issue, description: long } } }),
    );
    const ticket = await linearProvider({ apiKey: "k", fetch }).fetch("ENG-123");
    expect(ticket?.description.length).toBe(LINEAR_LIMITS.description + 1);
  });

  it("is undefined for a key Linear doesn't know", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      reply({ data: null, errors: [{ message: "Entity not found: Issue" }] }),
    );
    expect(await linearProvider({ apiKey: "k", fetch }).fetch("ABC-1")).toBeUndefined();
    const nullIssue = vi.fn<typeof globalThis.fetch>(async () => reply({ data: { issue: null } }));
    expect(await linearProvider({ apiKey: "k", fetch: nullIssue }).fetch("ABC-1")).toBeUndefined();
  });

  it("fails without the key in the message when Linear refuses it or errs", async () => {
    const refused = vi.fn<typeof globalThis.fetch>(async () => reply({}, 401));
    const error = await linearProvider({ apiKey: "lin_api_secret", fetch: refused })
      .fetch("ENG-1")
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TicketProviderError);
    expect(String(error)).toContain("HTTP 401");
    expect(String(error)).not.toContain("lin_api_secret");

    const failing = vi.fn<typeof globalThis.fetch>(async () =>
      reply({ errors: [{ message: "Rate limited" }] }),
    );
    await expect(linearProvider({ apiKey: "k", fetch: failing }).fetch("ENG-1")).rejects.toThrow(
      "Rate limited",
    );

    const down = vi.fn<typeof globalThis.fetch>(async () => {
      throw new TypeError("fetch failed lin_api_secret");
    });
    const unreachable = await linearProvider({ apiKey: "lin_api_secret", fetch: down })
      .fetch("ENG-1")
      .catch((caught: unknown) => caught);
    expect(String(unreachable)).not.toContain("lin_api_secret");
  });

  it("refuses an empty key", () => {
    expect(() => linearProvider({ apiKey: "  " })).toThrow(TicketProviderError);
  });

  it("finds keys with its configured teams", () => {
    const provider = linearProvider({ apiKey: "k", teamKeys: ["ENG"] });
    expect(provider.find({ ...empty, title: "ENG-1 WEB-2" }).map((ref) => ref.key)).toEqual([
      "ENG-1",
    ]);
  });
});
