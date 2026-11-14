import { z } from "zod";

/** Longest error or problem text kept in a HarnessError message or a repair prompt. */
const MAX_MESSAGE = 2000;

export function truncate(text: string): string {
  return text.length > MAX_MESSAGE ? `${text.slice(0, MAX_MESSAGE)}…` : text;
}

/** A line that opens a Markdown code fence, with an optional info string (`json`, `diff`). */
const FENCE_OPEN = /^[ \t]*```[ \t]*([^`\s]*)[^`]*$/;
/** A line that closes one. */
const FENCE_CLOSE = /^[ \t]*```[ \t]*$/;

/**
 * The bodies of the Markdown code fences in a text, in order, each with its info string. Fences
 * are paired opener to closer line by line, so a `diff` block before the JSON one can't be
 * mistaken for the gap between them. CRLF line ends are fine.
 */
function fences(text: string): { info: string; body: string }[] {
  const found: { info: string; body: string }[] = [];
  let open: { info: string; lines: string[] } | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (open === undefined) {
      const opener = FENCE_OPEN.exec(line);
      if (opener) open = { info: (opener[1] ?? "").toLowerCase(), lines: [] };
    } else if (FENCE_CLOSE.test(line)) {
      found.push({ info: open.info, body: open.lines.join("\n") });
      open = undefined;
    } else {
      open.lines.push(line);
    }
  }
  return found;
}

/**
 * The model's final message as JSON: the whole message, or else the last code fence in it that
 * holds valid JSON, untagged or tagged `json`, with or without prose around it.
 */
export function parseAnswer(
  answer: string | undefined,
): { ok: true; value: unknown } | { ok: false; error: string } {
  if (answer === undefined || answer.trim() === "") {
    return { ok: false, error: "There was no answer." };
  }
  const candidates = [
    answer,
    ...fences(answer)
      .filter((fence) => fence.info === "" || fence.info === "json")
      .map((fence) => fence.body)
      .reverse(),
  ];
  for (const text of candidates) {
    try {
      return { ok: true, value: JSON.parse(text) };
    } catch {
      // Try the next candidate.
    }
  }
  return { ok: false, error: "The answer wasn't valid JSON." };
}

/** The follow-up turn after an answer failed validation. */
export function repairPrompt(problems: string): string {
  return [
    "Your answer did not match the required JSON schema.",
    "",
    "Problems:",
    truncate(problems),
    "",
    "Reply again with only the corrected JSON. Keep everything that was right. Don't explain.",
  ].join("\n");
}

/**
 * The schema as draft-7 JSON Schema without `$schema` (the CLIs' validators know draft 7 and
 * reject a `$schema` they have no copy of). Undefined when zod can't express it.
 */
export function schemaJson(schema: z.ZodType): Record<string, unknown> | undefined {
  try {
    const json: Record<string, unknown> = {
      ...z.toJSONSchema(schema, { io: "input", target: "draft-7" }),
    };
    delete json.$schema;
    return json;
  } catch {
    return undefined;
  }
}

/** Asks for the answer in the prompt, for a schema the CLI isn't given as a flag. */
export function schemaPromptSuffix(json: Record<string, unknown> | undefined): string {
  if (json === undefined) return "\n\nReply with only a JSON value, with no other text.";
  return `\n\nReply with only a JSON value that matches this JSON Schema, with no other text:\n${JSON.stringify(json)}`;
}
