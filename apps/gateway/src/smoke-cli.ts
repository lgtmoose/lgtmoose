import { appendFileSync } from "node:fs";
import { report, runWebhookSmoke } from "./smoke.js";

/**
 * `pnpm --filter @lgtmoose/gateway smoke:webhook`, from the AWS smoke workflow. Reads
 * SMOKE_WEBHOOK_URL, SMOKE_WEBHOOK_SECRET and SMOKE_OWNER; writes `delivery_id` to
 * $GITHUB_OUTPUT. The secret is never printed.
 */
async function main(): Promise<number> {
  const webhookUrl = process.env.SMOKE_WEBHOOK_URL?.trim();
  const secret = process.env.SMOKE_WEBHOOK_SECRET ?? "";
  const owner = process.env.SMOKE_OWNER?.trim();
  const missing = [
    ...(webhookUrl ? [] : ["SMOKE_WEBHOOK_URL"]),
    ...(secret ? [] : ["SMOKE_WEBHOOK_SECRET"]),
    ...(owner ? [] : ["SMOKE_OWNER"]),
  ];
  if (webhookUrl === undefined || owner === undefined || missing.length > 0) {
    process.stderr.write(`Missing ${missing.join(", ")}.\n`);
    return 2;
  }
  const result = await runWebhookSmoke({ webhookUrl, secret, owner });
  const { lines, ok } = report(result);
  for (const line of lines) process.stdout.write(`${line}\n`);
  const output = process.env.GITHUB_OUTPUT;
  if (output) appendFileSync(output, `delivery_id=${result.deliveryId}\n`);
  return ok ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(
      `Smoke test failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  },
);
