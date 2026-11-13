/**
 * Untrusted text (PR title and body, comments, convention files, code) goes into the prompt
 * inside `<untrusted>` blocks. The prompt tells the model that block contents are data, never
 * instructions. Escaping keeps the content from opening or closing a block of its own, so the
 * boundaries the model sees are always ours. It's deterministic, so prompts snapshot cleanly.
 */

export const UNTRUSTED_TAG = "untrusted";

/**
 * Characters a reader could take for `<`: the ASCII one and its lookalikes (fullwidth, small
 * form, angle brackets and quotation marks).
 */
const OPENERS = new Set([
  "<",
  "\uFF1C",
  "\uFE64",
  "\u2039",
  "\u2329",
  "\u3008",
  "\u27E8",
  "\u276C",
]);

/** Invisible characters that could split the tag name: zero-width spaces, joiners, BOM. */
const INVISIBLE = /\u034F|[\u00AD\u180E\u200B-\u200F\u2060-\u2064\uFEFF]/g;

/** How far after an opener to look for the tag name, allowing for spaces and invisibles. */
const WINDOW = 64;

/**
 * Whether the text after an opener reads as `untrusted` or `/untrusted` to a model: compared
 * after NFKC normalisation (which folds fullwidth and other compatibility letters), with
 * invisible characters, spaces and slashes removed, in any case.
 */
function startsTagName(after: string): boolean {
  const folded = after
    .slice(0, WINDOW)
    .normalize("NFKC")
    .replace(INVISIBLE, "")
    .replace(/^[\s/]*/, "")
    .toLowerCase();
  return folded.startsWith(UNTRUSTED_TAG);
}

/**
 * Escapes text so it can't open or close an untrusted block: any `<`, or a lookalike, that
 * starts something a reader could take for an `<untrusted` or `</untrusted` tag becomes `&lt;`.
 * That covers any case and spacing (`< / UNTRUSTED >`), fullwidth forms (`＜／ｕｎｔｒｕｓｔｅｄ＞`)
 * and zero-width characters inside the name.
 */
export function escapeUntrusted(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] ?? "";
    out += OPENERS.has(ch) && startsTagName(text.slice(i + 1, i + 1 + WINDOW)) ? "&lt;" : ch;
  }
  return out;
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
