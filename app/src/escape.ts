// HTML escaping, in one place because several views now build markup.

/** Escapes text for interpolation into element content. */
export function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

// Escapes text for interpolation into a double-quoted attribute value.
//
// The same function, which is the point of naming it separately: escaping only the
// quote would leave `&` alone, and an attribute value is entity-decoded when it is
// read back, so a file called `a&quot;b.yar` would come out of `title` - or out of
// a `data-` attribute a handler trusted - as `a"b.yar`. That is a wrong path, and
// with the wrong `&` it is a wrong path of the author's choosing.
export const escapeAttr = escapeHtml;
