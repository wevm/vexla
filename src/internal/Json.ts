/** @module JSON for an HTML `<script>` element. */

/**
 * Returns `value` as JSON that a `<script>` element can hold: `<`, `>`, `&`, U+2028, and U+2029
 * are escaped, so a value cannot close the element or start a comment.
 */
export function safe(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029')
}
