/** Longest error or problem text kept in a HarnessError message or a repair prompt. */
const MAX_MESSAGE = 2000;

export function truncate(text: string): string {
  return text.length > MAX_MESSAGE ? `${text.slice(0, MAX_MESSAGE)}…` : text;
}

/** The model's final message as JSON, also when it's wrapped in a Markdown code fence. */
export function parseAnswer(
  answer: string | undefined,
): { ok: true; value: unknown } | { ok: false; error: string } {
  if (answer === undefined || answer.trim() === "") {
    return { ok: false, error: "There was no answer." };
  }
  const fenced = /^\s*```(?:json)?\s*\n([\s\S]*?)\n\s*```\s*$/.exec(answer);
  try {
    return { ok: true, value: JSON.parse(fenced?.[1] ?? answer) };
  } catch {
    return { ok: false, error: "The answer wasn't valid JSON." };
  }
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
