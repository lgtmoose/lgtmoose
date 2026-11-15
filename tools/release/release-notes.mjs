#!/usr/bin/env node
// The GitHub release's notes (.github/workflows/release.yml): the changelog section for the
// version, each image's digest, the config that deploys exactly those images, and how to verify
// them first.
//
//   node tools/release/release-notes.mjs <tag> <owner> <control-digest> <sandbox-digest> <egress-proxy-digest>
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DIGEST = /^sha256:[0-9a-f]{64}$/;

/** The section of a changesets CHANGELOG.md for `version` (its `## <version>` heading to the next). */
export function changelogSection(changelog, version) {
  const lines = changelog.split("\n");
  const start = lines.findIndex((line) => line.trim() === `## ${version}`);
  if (start === -1) return undefined;
  const end = lines.findIndex((line, i) => i > start && line.startsWith("## "));
  return lines
    .slice(start + 1, end === -1 ? undefined : end)
    .join("\n")
    .trim();
}

/** The release notes, as Markdown. */
export function releaseNotes({ tag, owner, digests, changelog }) {
  for (const [name, digest] of Object.entries(digests)) {
    if (!DIGEST.test(digest)) throw new Error(`${name}'s digest isn't sha256:<64 hex>: ${digest}`);
  }
  const version = tag.replace(/^v/, "");
  const registry = `ghcr.io/${owner}`;
  const images = [
    ["control", "lgtmoose-control"],
    ["sandbox", "lgtmoose-sandbox"],
    ["egressProxy", "lgtmoose-egress-proxy"],
  ];
  const changes = changelogSection(changelog, version) ?? "See CHANGELOG.md.";
  return `${changes}

## Images

Built for linux/arm64 from this tag, scanned with Trivy (no fixable high or critical vulnerabilities), and pushed with an SBOM and a build provenance attestation. The sandbox image has no Cursor CLI: deploy from a build to use cursor-agent.

| Image | Digest |
| --- | --- |
${images.map(([key, name]) => `| \`${registry}/${name}\` | \`${digests[key]}\` |`).join("\n")}

Verify each before deploying (it checks the image was built by this repository's release workflow):

\`\`\`bash
${images.map(([key, name]) => `gh attestation verify oci://${registry}/${name}@${digests[key]} --repo ${owner}/lgtmoose`).join("\n")}
\`\`\`

## Deploy these images

Check out this tag, then set \`images\` in \`lgtmoose.config.ts\`:

\`\`\`ts
images: {
  source: "release",
  registry: "${registry}",
  version: "${version}",
  digests: {
${images.map(([key]) => `    ${key}: "${digests[key]}",`).join("\n")}
  },
},
\`\`\`

and run \`pnpm lgtmoose deploy\`. The images are copied into your account's ECR; tasks never pull from GHCR. See docs/releasing.md.
`;
}

function main(argv) {
  const [tag, owner, control, sandbox, egressProxy] = argv;
  if (egressProxy === undefined) {
    throw new Error(
      "Usage: release-notes.mjs <tag> <owner> <control-digest> <sandbox-digest> <egress-proxy-digest>",
    );
  }
  let changelog = "";
  try {
    changelog = readFileSync(new URL("../../apps/cli/CHANGELOG.md", import.meta.url), "utf8");
  } catch {
    // No changelog yet: the notes say where to look.
  }
  process.stdout.write(
    releaseNotes({ tag, owner, digests: { control, sandbox, egressProxy }, changelog }),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
