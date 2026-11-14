/** Longest error or problem text kept in a HarnessError message or a repair prompt. */
const MAX_MESSAGE = 2000;

export function truncate(text: string): string {
  return text.length > MAX_MESSAGE ? `${text.slice(0, MAX_MESSAGE)}…` : text;
}

/**
 * The model's final message as JSON: the whole message, or the last Markdown code fence in it
 * when the model wrapped the JSON in a fence, with or without prose around it.
 */
export function parseAnswer(
  answer: string | undefined,
): { ok: true; value: unknown } | { ok: false; error: string } {
  if (answer === undefined || answer.trim() === "") {
    return { ok: false, error: "There was no answer." };
  }
  const fences = [...answer.matchAll(/```(?:json)?[ \t]*\n([\s\S]*?)\n[ \t]*```/g)];
  for (const text of [answer, fences.at(-1)?.[1]]) {
    if (text === undefined) continue;
    try {
      return { ok: true, value: JSON.parse(text) };
    } catch {
      // Try the next form.
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
