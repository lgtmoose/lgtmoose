/**
 * The only way the dashboard builds DOM: elements with text children. Text is always a text node,
 * never parsed as HTML, so finding titles and bodies (model output and PR text) can't inject
 * markup or script. Nothing in src/ parses HTML from a string; a test checks.
 */

type Child = Node | string | undefined | false;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attributes: Record<string, string> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    // Only https: or same-page links; nothing that could run script.
    if (name === "href" && !/^(https:\/\/|#|\/)/.test(value)) continue;
    element.setAttribute(name, value);
  }
  for (const child of children) {
    if (child === undefined || child === false) continue;
    element.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return element;
}

/** A table with a header row; each cell is a node or text. */
export function table(headings: readonly string[], rows: readonly Child[][]): HTMLElement {
  const head = el("tr", {}, ...headings.map((heading) => el("th", {}, heading)));
  const body = rows.map((cells) => el("tr", {}, ...cells.map((cell) => el("td", {}, cell))));
  return el(
    "div",
    { class: "table-wrap" },
    el("table", {}, el("thead", {}, head), el("tbody", {}, ...body)),
  );
}

export function replace(target: Element, ...children: Child[]): void {
  target.replaceChildren(
    ...children.flatMap((child) =>
      child === undefined || child === false
        ? []
        : [typeof child === "string" ? document.createTextNode(child) : child],
    ),
  );
}
