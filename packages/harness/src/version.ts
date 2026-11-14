/**
 * The Claude Code version the sandbox image installs (infra/sandbox/Dockerfile). The adapter's
 * flags and tool rules were checked against it. A test keeps the two in step.
 */
export const CLAUDE_CODE_VERSION = "2.1.311";

/**
 * The Codex CLI version the sandbox image installs (infra/sandbox/Dockerfile). The codex
 * adapter's flags, `-c` settings and JSONL events were checked against it. A test keeps the two
 * in step.
 */
export const CODEX_VERSION = "0.166.0";

/**
 * The Cursor CLI (`agent`) build the sandbox image installs when a provider uses cursor-agent:
 * the Workflow stack passes it to infra/sandbox/Dockerfile as a build arg. The cursor adapter's
 * flags, permissions file and JSON result were checked against its docs.
 */
export const CURSOR_AGENT_VERSION = "2026.11.10-731fb78";

/**
 * SHA-256 of that build's tarball per Docker architecture, which the image build checks. Empty
 * until someone with access to downloads.cursor.com records them (NIC-853); until then the
 * Workflow stack refuses a cursor-agent provider unless the deploy allows an unverified CLI
 * (`LGTMOOSE_ALLOW_UNVERIFIED_CURSOR=1`). Change them together with `CURSOR_AGENT_VERSION`.
 */
export const CURSOR_AGENT_SHA256: Readonly<Record<"amd64" | "arm64", string>> = {
  amd64: "",
  arm64: "",
};
