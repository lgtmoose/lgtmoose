/**
 * The protected rule categories, on their own with no imports, so code built for the browser (the
 * dashboard bundles `agent-markdown.ts`) can use them without pulling in `node:crypto`.
 */

/**
 * Categories where a wrongly dropped finding is expensive. They're only dropped on an exact
 * fingerprint match, never a fuzzy one.
 */
export const PROTECTED_CATEGORIES: readonly string[] = [
  "authz",
  "tenant_scoping",
  "money",
  "secrets",
];

export function isProtectedCategory(category: string): boolean {
  return PROTECTED_CATEGORIES.includes(category);
}
