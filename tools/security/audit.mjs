#!/usr/bin/env node
// The dependency gate for CI (.github/workflows/security.yml): runs `pnpm audit` over every
// dependency, dev ones included, and fails on a high or critical advisory unless it's listed in
// .github/security/accepted-advisories.json with a reason and an expiry that hasn't passed. Lower
// severities are printed and don't fail. An accepted entry past its expiry fails too, so an
// acceptance is looked at again rather than kept forever.
//
//   node tools/security/audit.mjs            run pnpm audit and gate on it
//   node tools/security/audit.mjs file.json  gate on a saved `pnpm audit --json` report
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Severities that fail the gate. */
export const FAILING = new Set(["high", "critical"]);

const ACCEPTED_FILE = new URL("../../.github/security/accepted-advisories.json", import.meta.url);

/**
 * Checks the accepted list's shape: each entry names a GHSA ID, the package, a reason and an
 * expiry date (YYYY-MM-DD). Throws on anything else, so a typo can't quietly accept everything.
 */
export function parseAccepted(text) {
  const data = JSON.parse(text);
  if (!Array.isArray(data.accepted))
    throw new Error("accepted-advisories.json needs an `accepted` list");
  return data.accepted.map((entry, i) => {
    const where = `accepted[${i}]`;
    if (typeof entry.id !== "string" || !/^GHSA(-[23456789cfghjmpqrvwx]{4}){3}$/.test(entry.id)) {
      throw new Error(`${where}: id must be a GHSA ID such as GHSA-xxxx-xxxx-xxxx`);
    }
    if (typeof entry.package !== "string" || entry.package === "") {
      throw new Error(`${where}: package is required`);
    }
    if (typeof entry.reason !== "string" || entry.reason.trim().length < 20) {
      throw new Error(`${where}: reason must say why it's accepted (at least 20 characters)`);
    }
    if (typeof entry.expires !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(entry.expires)) {
      throw new Error(`${where}: expires must be a date, YYYY-MM-DD`);
    }
    return entry;
  });
}

/**
 * The gate's verdict for a `pnpm audit --json` report: what fails, what's accepted, and what's
 * only reported. `today` is YYYY-MM-DD; an entry is valid through its expiry day.
 */
export function evaluate(report, accepted, today) {
  const valid = new Map();
  const expired = [];
  for (const entry of accepted) {
    if (entry.expires < today) expired.push(entry);
    else valid.set(`${entry.id}|${entry.package}`, entry);
  }
  const failing = [];
  const acceptedHits = [];
  const reported = [];
  for (const advisory of Object.values(report.advisories ?? {})) {
    const item = {
      id: advisory.github_advisory_id ?? String(advisory.id),
      package: advisory.module_name,
      severity: advisory.severity,
      title: advisory.title,
      patched: advisory.patched_versions,
    };
    if (!FAILING.has(item.severity)) reported.push(item);
    else if (valid.has(`${item.id}|${item.package}`)) acceptedHits.push(item);
    else failing.push(item);
  }
  return { failing, accepted: acceptedHits, reported, expired };
}

function line(item) {
  return `  ${item.severity.padEnd(8)} ${item.package} ${item.id}: ${item.title} (fixed in ${item.patched})`;
}

function main(argv) {
  const accepted = parseAccepted(readFileSync(ACCEPTED_FILE, "utf8"));
  let json;
  if (argv[0] !== undefined) {
    json = readFileSync(argv[0], "utf8");
  } else {
    try {
      json = execFileSync("pnpm", ["audit", "--json"], { encoding: "utf8", maxBuffer: 64 << 20 });
    } catch (error) {
      // pnpm audit exits non-zero when it finds anything; the report is still on stdout.
      if (typeof error.stdout !== "string" || error.stdout.trim() === "") throw error;
      json = error.stdout;
    }
  }
  const today = new Date().toISOString().slice(0, 10);
  const result = evaluate(JSON.parse(json), accepted, today);
  if (result.reported.length > 0) {
    console.log(
      `Advisories below high (reported, not failing):\n${result.reported.map(line).join("\n")}`,
    );
  }
  if (result.accepted.length > 0) {
    console.log(`Accepted until their expiry:\n${result.accepted.map(line).join("\n")}`);
  }
  for (const entry of result.expired) {
    console.log(
      `::error::Accepted advisory ${entry.id} (${entry.package}) expired on ${entry.expires}: fix it or accept it again with a new reason.`,
    );
  }
  for (const item of result.failing) {
    console.log(
      `::error::${item.severity} advisory ${item.id} in ${item.package}: ${item.title} (fixed in ${item.patched})`,
    );
  }
  const ok = result.failing.length === 0 && result.expired.length === 0;
  console.log(ok ? "Dependency audit passed." : "Dependency audit failed.");
  return ok ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
