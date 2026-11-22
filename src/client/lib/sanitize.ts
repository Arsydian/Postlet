/**
 * @file src/client/lib/sanitize.ts
 * @description HTML email sanitization and sandboxed iframe document construction.
 * Uses the browser's native Sanitizer API (`Element.prototype.setHTML`) when supported,
 * and lazily code-splits DOMPurify only as a fallback in browsers lacking native support.
 */

const ALLOWED_EMAIL_TAGS = [
  "p",
  "br",
  "div",
  "span",
  "b",
  "i",
  "strong",
  "em",
  "u",
  "s",
  "strike",
  "a",
  "ul",
  "ol",
  "li",
  "blockquote",
  "pre",
  "code",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "th",
  "td",
  "img",
  "hr",
  "small",
  "sub",
  "sup",
];

const ALLOWED_EMAIL_ATTRS = [
  "href",
  "src",
  "alt",
  "title",
  "width",
  "height",
  "align",
  "colspan",
  "rowspan",
  "class",
];

interface NativeSanitizerElement extends HTMLElement {
  setHTML: (
    html: string,
    options?: { sanitizer?: { elements?: string[]; attributes?: string[] } },
  ) => void;
}

function hasNativeSetHtml(el: HTMLElement): el is NativeSanitizerElement {
  return "setHTML" in el;
}

let domPurifyPromise: Promise<typeof import("dompurify").default> | null = null;

function loadDomPurify() {
  domPurifyPromise ??= import("dompurify").then((mod) => mod.default);
  return domPurifyPromise;
}

/**
 * Sanitizes untrusted HTML email bodies by stripping scripts, event handlers, unsafe attributes,
 * and disallowed tags. Uses native `Element.prototype.setHTML` when present and falls back to
 * dynamically imported DOMPurify with matching strict rules (`ALLOW_ARIA_ATTR: false`,
 * `ALLOW_DATA_ATTR: false`, `KEEP_CONTENT: false`).
 *
 * @param rawHtml Raw HTML string received from inbound email or Markdown preview.
 * @returns Sanitized HTML string safe to render inside a sandboxed iframe.
 */
export async function sanitizeEmailHtml(rawHtml: string): Promise<string> {
  if (!rawHtml.trim()) {
    return "";
  }

  const container = document.createElement("div");
  if (hasNativeSetHtml(container)) {
    container.setHTML(rawHtml, {
      sanitizer: {
        elements: ALLOWED_EMAIL_TAGS,
        attributes: ALLOWED_EMAIL_ATTRS,
      },
    });
    return container.innerHTML;
  }

  const DOMPurify = await loadDomPurify();
  return DOMPurify.sanitize(rawHtml, {
    ALLOWED_TAGS: [...ALLOWED_EMAIL_TAGS, "#text"],
    ALLOWED_ATTR: ALLOWED_EMAIL_ATTRS,
    ALLOW_ARIA_ATTR: false,
    ALLOW_DATA_ATTR: false,
    KEEP_CONTENT: false,
  });
}

/**
 * Escapes plain text into basic semantic `<p>`/`<br>` HTML suitable for initializing
 * the rich-text composer from a plain-text body or AI draft suggestion.
 */
export function plainTextToBasicHtml(text: string): string {
  const normalized = text.replace(/\r\n/g, "\n");
  if (!normalized.trim()) {
    return "";
  }
  const escaped = normalized
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

  return escaped
    .split(/\n{2,}/)
    .map((para) => `<p>${para.replace(/\n/g, "<br>")}</p>`)
    .join("");
}

/**
 * Safely populates a live DOM container element with untrusted or editable HTML,
 * preferring native `Element.prototype.setHTML` and lazily falling back to DOMPurify.
 */
export async function safeSetElementHtml(el: HTMLElement, rawHtml: string): Promise<void> {
  if (!rawHtml.trim()) {
    el.replaceChildren();
    return;
  }

  if (hasNativeSetHtml(el)) {
    el.setHTML(rawHtml, {
      sanitizer: {
        elements: ALLOWED_EMAIL_TAGS,
        attributes: ALLOWED_EMAIL_ATTRS,
      },
    });
    return;
  }

  const DOMPurify = await loadDomPurify();
  el.innerHTML = DOMPurify.sanitize(rawHtml, {
    ALLOWED_TAGS: [...ALLOWED_EMAIL_TAGS, "#text"],
    ALLOWED_ATTR: ALLOWED_EMAIL_ATTRS,
    ALLOW_ARIA_ATTR: false,
    ALLOW_DATA_ATTR: false,
    KEEP_CONTENT: false,
  });
}

/**
 * Returns true if raw email HTML references external `http://` or `https://` images.
 */
export function hasRemoteImages(rawHtml: string): boolean {
  return /<img\b[^>]*\bsrc\s*=\s*["']?\s*https?:\/\//i.test(rawHtml);
}

/**
 * Builds a complete, isolated `srcDoc` HTML document for rendering sanitized email markup
 * inside a `<iframe sandbox="allow-popups allow-popups-to-escape-sandbox">`.
 * Remote images are blocked by default (`img-src data: cid:`) to prevent tracking pixels unless
 * `allowRemoteImages` is explicitly set to `true` by the owner.
 *
 * @param sanitizedBody Already-sanitized email HTML fragment.
 * @param options Rendering options (`allowRemoteImages`).
 * @returns Complete HTML document string with CSP and base target attributes.
 */
export function buildEmailIframeSrcDoc(
  sanitizedBody: string,
  options?: { allowRemoteImages?: boolean },
): string {
  const imgSrc = options?.allowRemoteImages ? "https: http: data: cid:" : "data: cid:";
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${imgSrc}; style-src 'unsafe-inline';" />
    <base target="_blank" rel="noopener noreferrer" />
    <style>
      :root { color-scheme: light; }
      body {
        margin: 0;
        padding: 4px 2px;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Inter, sans-serif;
        font-size: 14px;
        line-height: 1.6;
        color: #1e293b;
        word-break: break-word;
      }
      a { color: #4f46e5; text-decoration: underline; }
      img { max-width: 100%; height: auto; border-radius: 6px; }
      blockquote {
        margin: 12px 0;
        padding-left: 12px;
        border-left: 3px solid #cbd5e1;
        color: #475569;
      }
      pre, code {
        background: #f1f5f9;
        border-radius: 6px;
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 13px;
      }
      pre { padding: 10px 12px; overflow-x: auto; }
      code { padding: 2px 5px; }
      table { border-collapse: collapse; max-width: 100%; }
      th, td { border: 1px solid #e2e8f0; padding: 6px 10px; text-align: left; }
    </style>
  </head>
  <body>${sanitizedBody}</body>
</html>`;
}
