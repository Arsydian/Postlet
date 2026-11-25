/**
 * @file src/client/lib/sanitize.ts
 * @description HTML email sanitization, inline CID image rewriting, and sandboxed iframe
 * document construction using consistent DOMPurify rules across all browsers.
 */

import DOMPurify from "dompurify";
import type { AttachmentRecord } from "../../shared/types";

const ALLOWED_EMAIL_TAGS = [
  "p",
  "br",
  "wbr",
  "div",
  "span",
  "center",
  "font",
  "b",
  "i",
  "strong",
  "em",
  "u",
  "s",
  "strike",
  "del",
  "ins",
  "mark",
  "q",
  "abbr",
  "cite",
  "a",
  "ul",
  "ol",
  "li",
  "dl",
  "dt",
  "dd",
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
  "caption",
  "colgroup",
  "col",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "th",
  "td",
  "img",
  "picture",
  "figure",
  "figcaption",
  "hr",
  "small",
  "sub",
  "sup",
  "section",
  "article",
  "header",
  "footer",
  "main",
  "aside",
  "details",
  "summary",
];

const ALLOWED_EMAIL_ATTRS = [
  "href",
  "src",
  "alt",
  "title",
  "width",
  "height",
  "align",
  "valign",
  "border",
  "cellpadding",
  "cellspacing",
  "bgcolor",
  "color",
  "colspan",
  "rowspan",
  "dir",
  "class",
  "target",
  "rel",
];

const FORBIDDEN_EMAIL_TAGS = [
  "script",
  "style",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "form",
  "input",
  "button",
  "textarea",
  "select",
  "option",
  "meta",
  "link",
  "base",
  "svg",
  "math",
  "noscript",
  "template",
  "audio",
  "video",
  "source",
  "track",
  "canvas",
];

export const SAFE_INLINE_IMAGE_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
  "image/avif",
]);

export const MAX_INLINE_CID_IMAGE_BYTES = 5 * 1024 * 1024;

const SAFE_DATA_IMAGE_URI_RE = /^data:image\/(?:png|jpe?g|gif|webp|avif);base64,[a-z0-9+/=]+$/i;
const IMG_SRC_ATTR_RE = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+))/i;
const IMG_CLASS_ATTR_RE = /\bclass\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+))/i;

/**
 * Sanitizes untrusted HTML email bodies consistently across all browsers using DOMPurify,
 * preserving safe layout markup and image attributes while stripping scripts, event handlers,
 * unsafe tags, and dangerous attributes.
 *
 * @param rawHtml Raw HTML string received from inbound email or Markdown preview.
 * @returns Sanitized HTML string safe to render inside a sandboxed iframe.
 */
export async function sanitizeEmailHtml(rawHtml: string): Promise<string> {
  if (!rawHtml.trim()) {
    return "";
  }

  return DOMPurify.sanitize(rawHtml, {
    ALLOWED_TAGS: [...ALLOWED_EMAIL_TAGS, "#text"],
    ALLOWED_ATTR: ALLOWED_EMAIL_ATTRS,
    FORBID_TAGS: FORBIDDEN_EMAIL_TAGS,
    ALLOW_ARIA_ATTR: false,
    ALLOW_DATA_ATTR: false,
    KEEP_CONTENT: true,
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
 * Safely populates a live DOM container element with sanitized HTML using DOMPurify.
 */
export async function safeSetElementHtml(el: HTMLElement, rawHtml: string): Promise<void> {
  if (!rawHtml.trim()) {
    el.replaceChildren();
    return;
  }

  el.innerHTML = await sanitizeEmailHtml(rawHtml);
}

/**
 * Normalizes a MIME `Content-ID` header value or `cid:` URI into a canonical lowercase key.
 */
export function normalizeContentId(raw: string | null | undefined): string {
  if (!raw) return "";
  let cleaned = raw.trim().replace(/^cid:/i, "").trim();
  if (cleaned.startsWith("<") && cleaned.endsWith(">")) {
    cleaned = cleaned.slice(1, -1);
  } else {
    cleaned = cleaned.replace(/^<+|>+$/g, "");
  }
  try {
    cleaned = decodeURIComponent(cleaned);
  } catch {
    // Keep raw token if percent-encoding is malformed
  }
  return cleaned.trim().toLowerCase();
}

/**
 * Matches `cid:` image references inside email HTML to safe raster attachments stored in R2.
 */
export function matchCidAttachments(
  rawHtml: string,
  attachments: AttachmentRecord[],
): Array<{ cidKey: string; attachment: AttachmentRecord }> {
  if (!rawHtml || attachments.length === 0) {
    return [];
  }

  const eligible = attachments.filter((att) => {
    const mime = (att.contentType || "").split(";")[0].trim().toLowerCase();
    return (
      SAFE_INLINE_IMAGE_MIMES.has(mime) &&
      att.sizeBytes >= 0 &&
      att.sizeBytes <= MAX_INLINE_CID_IMAGE_BYTES
    );
  });
  if (eligible.length === 0) {
    return [];
  }

  const seenCids = new Set<string>();
  const matches: Array<{ cidKey: string; attachment: AttachmentRecord }> = [];
  const imgTagRe = /<img\b[^>]*>/gi;
  let imgMatch: RegExpExecArray | null;

  while ((imgMatch = imgTagRe.exec(rawHtml)) !== null) {
    const srcMatch = IMG_SRC_ATTR_RE.exec(imgMatch[0]);
    const rawSrc = (srcMatch?.[1] ?? srcMatch?.[2] ?? srcMatch?.[3] ?? "").trim();
    if (!/^cid:/i.test(rawSrc)) continue;

    const cidKey = normalizeContentId(rawSrc);
    if (!cidKey || seenCids.has(cidKey)) continue;

    const attachment =
      eligible.find((att) => normalizeContentId(att.contentId) === cidKey) ??
      eligible.find(
        (att) =>
          att.contentDisposition.trim().toLowerCase() === "inline" &&
          att.filename.trim().toLowerCase() === cidKey,
      );

    if (attachment) {
      seenCids.add(cidKey);
      matches.push({ cidKey, attachment });
    }
  }

  return matches;
}

/**
 * Returns true if raw email HTML references external `http://` or `https://` images.
 */
export function hasRemoteImages(rawHtml: string): boolean {
  return /<img\b[^>]*\bsrc\s*=\s*["']?\s*https?:\/\//i.test(rawHtml);
}

/**
 * Strips the `src` attribute from an `<img ...>` attribute substring and ensures
 * `postlet-blocked-img` is present in its `class` list so blocked images hide cleanly.
 */
function stripSrcAndHideImgAttrs(attrs: string): string {
  const selfClosing = /\/\s*$/.test(attrs);
  let nextAttrs = attrs.replace(/\/\s*$/, "").replace(
    /\s*\bsrc\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>"']+)/i,
    "",
  );

  const classMatch = IMG_CLASS_ATTR_RE.exec(nextAttrs);
  if (classMatch) {
    const existing = (classMatch[1] ?? classMatch[2] ?? classMatch[3] ?? "").trim();
    const tokens = existing ? existing.split(/\s+/) : [];
    if (!tokens.includes("postlet-blocked-img")) {
      tokens.push("postlet-blocked-img");
    }
    const updatedClass = `class="${tokens.join(" ")}"`;
    nextAttrs =
      nextAttrs.slice(0, classMatch.index) +
      updatedClass +
      nextAttrs.slice(classMatch.index + classMatch[0].length);
  } else {
    nextAttrs = `${nextAttrs} class="postlet-blocked-img"`;
  }

  return selfClosing ? `${nextAttrs} /` : nextAttrs;
}

/**
 * Rewrites `<img>` tags inside already-sanitized email HTML to resolve safe `cid:` inline images
 * to `data:` URIs and hide blocked external or unresolved `cid:` images without broken icons.
 */
export function prepareEmailHtmlForIframe(
  sanitizedHtml: string,
  options?: { allowRemoteImages?: boolean; cidDataUris?: ReadonlyMap<string, string> },
): string {
  if (!sanitizedHtml) {
    return "";
  }

  return sanitizedHtml.replace(/<img\b([^>]*)>/gi, (fullTag, attrs: string) => {
    const srcMatch = IMG_SRC_ATTR_RE.exec(attrs);
    if (!srcMatch) {
      return fullTag;
    }

    const rawSrc = (srcMatch[1] ?? srcMatch[2] ?? srcMatch[3] ?? "").trim();

    if (/^cid:/i.test(rawSrc)) {
      const cidKey = normalizeContentId(rawSrc);
      const dataUri = options?.cidDataUris?.get(cidKey);
      if (dataUri && SAFE_DATA_IMAGE_URI_RE.test(dataUri)) {
        const updatedAttrs =
          attrs.slice(0, srcMatch.index) +
          `src="${dataUri}"` +
          attrs.slice(srcMatch.index + srcMatch[0].length);
        return `<img${updatedAttrs}>`;
      }
      return `<img${stripSrcAndHideImgAttrs(attrs)}>`;
    }

    if (/^https?:\/\//i.test(rawSrc)) {
      if (options?.allowRemoteImages) {
        return fullTag;
      }
      return `<img${stripSrcAndHideImgAttrs(attrs)}>`;
    }

    return fullTag;
  });
}

/**
 * Builds a complete, isolated `srcDoc` HTML document for rendering sanitized email markup
 * inside a `<iframe sandbox="allow-popups allow-popups-to-escape-sandbox">`.
 * Remote images are blocked by default (`img-src data:`) to prevent tracking pixels unless
 * `allowRemoteImages` is explicitly set to `true` by the owner.
 *
 * @param sanitizedBody Already-sanitized email HTML fragment.
 * @param options Rendering options (`allowRemoteImages`, `theme`, `cidDataUris`).
 * @returns Complete HTML document string with CSP and base target attributes.
 */
export function buildEmailIframeSrcDoc(
  sanitizedBody: string,
  options?: {
    allowRemoteImages?: boolean;
    theme?: "light" | "dark";
    cidDataUris?: ReadonlyMap<string, string>;
  },
): string {
  const preparedBody = prepareEmailHtmlForIframe(sanitizedBody, {
    allowRemoteImages: options?.allowRemoteImages,
    cidDataUris: options?.cidDataUris,
  });
  const imgSrc = options?.allowRemoteImages ? "https: http: data:" : "data:";
  const theme = options?.theme ?? "light";
  const isDark = theme === "dark";
  const bg = isDark ? "#1f1d1b" : "#f6f3ee";
  const fg = isDark ? "#ece7df" : "#2a2623";
  const linkColor = isDark ? "#ff8e73" : "#be3b22";
  const quoteBorder = isDark ? "#544e47" : "#c9c0b4";
  const quoteColor = isDark ? "#c4bdb4" : "#575049";
  const codeBg = isDark ? "#2c2926" : "#e8e3db";
  const tableBorder = isDark ? "#3b3732" : "#d8d1c7";

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="color-scheme" content="${theme}" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${imgSrc}; style-src 'unsafe-inline';" />
    <base target="_blank" rel="noopener noreferrer" />
    <style>
      :root { color-scheme: ${theme}; }
      body {
        margin: 0;
        padding: 12px 14px;
        background: ${bg};
        color: ${fg};
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Inter, sans-serif;
        font-size: 14px;
        line-height: 1.6;
        word-break: break-word;
      }
      a { color: ${linkColor}; text-decoration: underline; }
      img { max-width: 100%; height: auto; }
      img.postlet-blocked-img { display: none !important; }
      blockquote {
        margin: 12px 0;
        padding-left: 12px;
        border-left: 3px solid ${quoteBorder};
        color: ${quoteColor};
      }
      pre, code {
        background: ${codeBg};
        border-radius: 6px;
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 13px;
      }
      pre { padding: 10px 12px; overflow-x: auto; }
      code { padding: 2px 5px; }
      table { border-collapse: collapse; max-width: 100%; }
      th, td { border: 1px solid ${tableBorder}; padding: 6px 10px; text-align: left; }
    </style>
  </head>
  <body>${preparedBody}</body>
</html>`;
}
