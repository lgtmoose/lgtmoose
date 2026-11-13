/**
 * Untrusted text (PR title and body, comments, convention files, code) goes into the prompt
 * inside `<untrusted>` blocks. The prompt tells the model that block contents are data, never
 * instructions. Escaping keeps the content from opening or closing a block of its own, so the
 * boundaries the model sees are always ours. It's deterministic, so prompts snapshot cleanly.
 */

export const UNTRUSTED_TAG = "untrusted";

/**
 * Anything a reader could take for an `<untrusted` or `</untrusted` tag, in any case and with
 * any spacing: `</untrusted>`, `< / UNTRUSTED >`, `<untrusted source="x">`.
 */
const TAG_LIKE = /<(\s*\/?\s*)untrusted/gi;

/** Escapes text so it can't open or close an untrusted block. */
export function escapeUntrusted(text: string): string {
  return text.replace(TAG_LIKE, "&lt;$1untrusted");
}

const ATTRIBUTE_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "\n": "&#10;",
  "\r": "&#13;",
};

/** Escapes an attribute value (a file path, say) so it can't end the attribute or the tag. */
export function escapeAttribute(value: string): string {
  return value.replace(/[&<>"\n\r]/g, (char) => ATTRIBUTE_ESCAPES[char] ?? char);
}

const ATTRIBUTE_NAME = /^[a-z][a-z0-9_]*$/;

export type UntrustedAttributes = Record<string, string | number | undefined>;

/**
 * Wraps untrusted text in a delimited block. `source` says where it came from (`pr_body`,
 * `diff`, ...); attributes add details such as the path. Undefined attributes are left out.
 */
export function wrapUntrusted(
  source: string,
  text: string,
  attributes: UntrustedAttributes = {},
): string {
  const parts = [`source="${escapeAttribute(source)}"`];
  for (const [name, value] of Object.entries({ ...attributes })) {
    if (!ATTRIBUTE_NAME.test(name)) throw new Error(`Invalid attribute name: ${name}`);
    if (value !== undefined) parts.push(`${name}="${escapeAttribute(String(value))}"`);
  }
  const body = escapeUntrusted(text);
  const newline = body.endsWith("\n") || body === "" ? "" : "\n";
  return `<${UNTRUSTED_TAG} ${parts.join(" ")}>\n${body}${newline}</${UNTRUSTED_TAG}>`;
}
