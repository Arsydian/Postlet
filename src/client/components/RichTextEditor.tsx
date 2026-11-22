/**
 * @file src/client/components/RichTextEditor.tsx
 * @description Accessible rich-text email composer with ARIA toolbar (`focusgroup` + roving-tabindex
 * fallback), inline hyperlink popover bar, sanitized HTML hydration (`setHTML` / DOMPurify),
 * and clean paste handling.
 */

import {
  Bold,
  Code,
  Heading2,
  Italic,
  Link2,
  List,
  ListOrdered,
  Quote,
  RemoveFormatting,
  Strikethrough,
  Underline,
  Unlink,
} from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { plainTextToBasicHtml, safeSetElementHtml, sanitizeEmailHtml } from "../lib/sanitize";

interface RichTextEditorProps {
  initialHtml: string;
  syncKey: string | number;
  placeholder?: string;
  autoFocus?: boolean;
  onChange: (value: { html: string; text: string }) => void;
}

interface ActiveFormats {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  code: boolean;
  heading: boolean;
  ul: boolean;
  ol: boolean;
  blockquote: boolean;
}

interface DocumentWithParseHtml {
  parseHTML?: (html: string) => Document;
}

const DEFAULT_FORMATS: ActiveFormats = {
  bold: false,
  italic: false,
  underline: false,
  strike: false,
  code: false,
  heading: false,
  ul: false,
  ol: false,
  blockquote: false,
};

function findAncestorTag(node: Node | null, stopAt: HTMLElement, tagNames: string[]): HTMLElement | null {
  let cur: Node | null = node;
  while (cur && cur !== stopAt) {
    if (cur.nodeType === Node.ELEMENT_NODE) {
      const el = cur as HTMLElement;
      if (tagNames.includes(el.tagName)) {
        return el;
      }
    }
    cur = cur.parentNode;
  }
  return null;
}

function unwrapElement(el: HTMLElement): void {
  const parent = el.parentNode;
  if (!parent) return;
  while (el.firstChild) {
    parent.insertBefore(el.firstChild, el);
  }
  parent.removeChild(el);
}

/**
 * Validates and normalizes hyperlink destinations for email compatibility, rejecting dangerous
 * protocols such as `javascript:` or `data:`.
 */
function normalizeSafeHref(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || /\s/.test(trimmed)) return null;

  let candidate = trimmed;
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(candidate)) {
    if (candidate.startsWith("//")) return null;
    candidate = candidate.includes("@") && !candidate.includes("/")
      ? `mailto:${candidate}`
      : `https://${candidate}`;
  }

  try {
    const parsed = new URL(candidate);
    if (!["https:", "http:", "mailto:"].includes(parsed.protocol)) {
      return null;
    }
    return parsed.href;
  } catch {
    return null;
  }
}

export function RichTextEditor({
  initialHtml,
  syncKey,
  placeholder = "Write your message...",
  autoFocus = false,
  onChange,
}: RichTextEditorProps) {
  const editorId = useId();
  const toolbarRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const linkUrlInputRef = useRef<HTMLInputElement>(null);
  const savedRangeRef = useRef<Range | null>(null);
  const activeAnchorRef = useRef<HTMLAnchorElement | null>(null);

  const [formats, setFormats] = useState<ActiveFormats>(DEFAULT_FORMATS);
  const [statusMessage, setStatusMessage] = useState("");
  const [linkBarOpen, setLinkBarOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");
  const [linkText, setLinkText] = useState("");
  const [linkError, setLinkError] = useState("");
  const [editingExistingLink, setEditingExistingLink] = useState(false);

  const emitChange = useCallback(() => {
    const el = editorRef.current;
    if (!el) return;
    const rawInner = el.innerHTML;
    // Browsers frequently leave a lone `<br>` when all content is deleted; normalize to empty.
    const normalizedHtml = rawInner === "<br>" || rawInner === "<p><br></p>" ? "" : rawInner;
    const text = el.innerText.replace(/\r\n/g, "\n").replace(/\u00a0/g, " ");
    onChange({
      html: normalizedHtml.trim() ? normalizedHtml : "",
      text: text.trim() ? text.replace(/\n+$/, "") : "",
    });
  }, [onChange]);

  const refreshActiveFormats = useCallback(() => {
    const el = editorRef.current;
    const sel = document.getSelection();
    if (!el || !sel || sel.rangeCount === 0) {
      setFormats(DEFAULT_FORMATS);
      return;
    }

    const anchorNode = sel.anchorNode;
    if (!anchorNode || !el.contains(anchorNode)) {
      return;
    }

    const queryState = (cmd: string): boolean => {
      try {
        return document.queryCommandState(cmd);
      } catch {
        return false;
      }
    };

    setFormats({
      bold: queryState("bold"),
      italic: queryState("italic"),
      underline: queryState("underline"),
      strike: queryState("strikeThrough"),
      code: Boolean(findAncestorTag(anchorNode, el, ["CODE"])),
      heading: Boolean(findAncestorTag(anchorNode, el, ["H1", "H2", "H3"])),
      ul: queryState("insertUnorderedList"),
      ol: queryState("insertOrderedList"),
      blockquote: Boolean(findAncestorTag(anchorNode, el, ["BLOCKQUOTE"])),
    });
  }, []);

  // Hydrate editor DOM only when syncKey changes (open modal, switch mode, AI fill) so typing never jumps cursor.
  useEffect(() => {
    let cancelled = false;
    const el = editorRef.current;
    if (!el) return;

    void safeSetElementHtml(el, initialHtml).then(() => {
      if (cancelled) return;
      if (autoFocus) {
        el.focus();
      }
      refreshActiveFormats();
    });

    return () => {
      cancelled = true;
    };
    // Intentionally keyed ONLY on `syncKey` to prevent caret resets while typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncKey]);

  // Keep ARIA toolbar pressed states synced with selection changes inside the editor.
  useEffect(() => {
    const handleSelectionChange = () => {
      refreshActiveFormats();
    };
    document.addEventListener("selectionchange", handleSelectionChange);
    return () => document.removeEventListener("selectionchange", handleSelectionChange);
  }, [refreshActiveFormats]);

  // Progressive roving-tabindex fallback ONLY when native HTML `focusgroup` is unsupported.
  useEffect(() => {
    const bar = toolbarRef.current;
    if (!bar || "focusGroup" in HTMLElement.prototype) {
      return;
    }

    const buttons = Array.from(bar.querySelectorAll<HTMLButtonElement>("button"));
    if (buttons.length === 0) return;

    buttons.forEach((btn, i) => {
      btn.tabIndex = i === 0 ? 0 : -1;
    });

    const handleFocusIn = (event: FocusEvent) => {
      const target = event.target;
      if (target instanceof HTMLButtonElement && buttons.includes(target)) {
        buttons.forEach((b) => {
          b.tabIndex = b === target ? 0 : -1;
        });
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLButtonElement)) return;
      const idx = buttons.indexOf(target);
      if (idx === -1) return;

      const rtl = getComputedStyle(bar).direction === "rtl";
      let nextIdx: number | null = null;
      if (event.key === "ArrowRight") {
        nextIdx = (idx + (rtl ? -1 : 1) + buttons.length) % buttons.length;
      } else if (event.key === "ArrowLeft") {
        nextIdx = (idx + (rtl ? 1 : -1) + buttons.length) % buttons.length;
      } else if (event.key === "Home") {
        nextIdx = 0;
      } else if (event.key === "End") {
        nextIdx = buttons.length - 1;
      }

      if (nextIdx !== null) {
        event.preventDefault();
        buttons.forEach((b, i) => {
          b.tabIndex = i === nextIdx ? 0 : -1;
        });
        buttons[nextIdx].focus();
      }
    };

    bar.addEventListener("focusin", handleFocusIn);
    bar.addEventListener("keydown", handleKeyDown);
    return () => {
      bar.removeEventListener("focusin", handleFocusIn);
      bar.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  function ensureSelectionInsideEditor(): Selection | null {
    const el = editorRef.current;
    if (!el) return null;
    if (document.activeElement !== el) {
      el.focus();
    }
    const sel = document.getSelection();
    if (!sel) return null;
    if (sel.rangeCount === 0 || !el.contains(sel.anchorNode)) {
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
    }
    return sel;
  }

  function runCommand(command: string, value?: string) {
    ensureSelectionInsideEditor();
    document.execCommand(command, false, value);
    emitChange();
    refreshActiveFormats();
  }

  function toggleBlockTag(tag: "H2" | "BLOCKQUOTE") {
    const el = editorRef.current;
    const sel = ensureSelectionInsideEditor();
    if (!el || !sel || sel.rangeCount === 0) return;

    const match = findAncestorTag(
      sel.anchorNode,
      el,
      tag === "H2" ? ["H1", "H2", "H3"] : ["BLOCKQUOTE"],
    );
    document.execCommand("formatBlock", false, match ? "P" : tag);
    emitChange();
    refreshActiveFormats();
  }

  function toggleInlineCode() {
    const el = editorRef.current;
    const sel = ensureSelectionInsideEditor();
    if (!el || !sel || sel.rangeCount === 0) return;

    const existingCode = findAncestorTag(sel.anchorNode, el, ["CODE"]);
    if (existingCode) {
      const range = document.createRange();
      range.selectNodeContents(existingCode);
      unwrapElement(existingCode);
      sel.removeAllRanges();
      sel.addRange(range);
      emitChange();
      refreshActiveFormats();
      return;
    }

    const range = sel.getRangeAt(0);
    const codeEl = document.createElement("code");
    if (range.collapsed) {
      codeEl.textContent = "code";
      range.insertNode(codeEl);
      const nextRange = document.createRange();
      nextRange.selectNodeContents(codeEl);
      sel.removeAllRanges();
      sel.addRange(nextRange);
    } else {
      codeEl.appendChild(range.extractContents());
      range.insertNode(codeEl);
      const nextRange = document.createRange();
      nextRange.selectNodeContents(codeEl);
      sel.removeAllRanges();
      sel.addRange(nextRange);
    }
    emitChange();
    refreshActiveFormats();
  }

  function clearAllFormatting() {
    const el = editorRef.current;
    const sel = ensureSelectionInsideEditor();
    if (!el || !sel || sel.rangeCount === 0) return;

    document.execCommand("removeFormat", false);
    // Unwrap any inline <code> elements intersecting the selection.
    const anchorCode = findAncestorTag(sel.anchorNode, el, ["CODE"]);
    if (anchorCode) {
      unwrapElement(anchorCode);
    }
    document.execCommand("formatBlock", false, "P");
    emitChange();
    refreshActiveFormats();
    setStatusMessage("Formatting cleared");
  }

  function openLinkEditor() {
    const el = editorRef.current;
    if (!el) return;
    const sel = ensureSelectionInsideEditor();
    const range = sel && sel.rangeCount > 0 ? sel.getRangeAt(0).cloneRange() : null;
    savedRangeRef.current = range;

    const existingAnchor = findAncestorTag(
      sel?.anchorNode ?? null,
      el,
      ["A"],
    ) as HTMLAnchorElement | null;
    activeAnchorRef.current = existingAnchor;

    if (existingAnchor) {
      setEditingExistingLink(true);
      setLinkUrl(existingAnchor.getAttribute("href") ?? "");
      setLinkText(existingAnchor.textContent ?? "");
    } else {
      setEditingExistingLink(false);
      setLinkUrl("");
      setLinkText(range?.toString() ?? "");
    }
    setLinkError("");
    setLinkBarOpen(true);
    queueMicrotask(() => linkUrlInputRef.current?.focus());
  }

  function applyLink() {
    const el = editorRef.current;
    if (!el) return;
    const normalized = normalizeSafeHref(linkUrl);
    if (!normalized) {
      setLinkError("Enter a valid https://, http://, or mailto: URL.");
      return;
    }

    const existingAnchor = activeAnchorRef.current;
    const sel = document.getSelection();
    el.focus();

    if (existingAnchor && el.contains(existingAnchor)) {
      existingAnchor.setAttribute("href", normalized);
      existingAnchor.setAttribute("target", "_blank");
      existingAnchor.setAttribute("rel", "noopener noreferrer");
      if (linkText.trim()) {
        existingAnchor.textContent = linkText.trim();
      }
      const range = document.createRange();
      range.setStartAfter(existingAnchor);
      range.collapse(true);
      sel?.removeAllRanges();
      sel?.addRange(range);
    } else {
      const range = savedRangeRef.current ?? document.createRange();
      if (!savedRangeRef.current) {
        range.selectNodeContents(el);
        range.collapse(false);
      }
      const anchor = document.createElement("a");
      anchor.setAttribute("href", normalized);
      anchor.setAttribute("target", "_blank");
      anchor.setAttribute("rel", "noopener noreferrer");

      const displayText = linkText.trim() || normalized;
      if (!range.collapsed && displayText === range.toString()) {
        anchor.appendChild(range.extractContents());
      } else {
        range.deleteContents();
        anchor.textContent = displayText;
      }
      range.insertNode(anchor);

      const afterRange = document.createRange();
      afterRange.setStartAfter(anchor);
      afterRange.collapse(true);
      sel?.removeAllRanges();
      sel?.addRange(afterRange);
    }

    setLinkBarOpen(false);
    setLinkError("");
    activeAnchorRef.current = null;
    savedRangeRef.current = null;
    emitChange();
    refreshActiveFormats();
    setStatusMessage("Link inserted");
  }

  function removeActiveLink() {
    const el = editorRef.current;
    const anchor = activeAnchorRef.current;
    if (el && anchor && el.contains(anchor)) {
      unwrapElement(anchor);
      emitChange();
      refreshActiveFormats();
      setStatusMessage("Link removed");
    }
    setLinkBarOpen(false);
    setLinkError("");
    activeAnchorRef.current = null;
    savedRangeRef.current = null;
    el?.focus();
  }

  async function handlePaste(event: React.ClipboardEvent<HTMLDivElement>) {
    const el = editorRef.current;
    if (!el) return;
    event.preventDefault();

    const pastedHtml = event.clipboardData.getData("text/html");
    const pastedPlain = event.clipboardData.getData("text/plain");
    const cleanHtml = pastedHtml.trim()
      ? await sanitizeEmailHtml(pastedHtml)
      : plainTextToBasicHtml(pastedPlain);

    if (!cleanHtml.trim()) return;

    const sel = ensureSelectionInsideEditor();
    if (!sel || sel.rangeCount === 0) return;

    const range = sel.getRangeAt(0);
    range.deleteContents();

    const fragment = document.createDocumentFragment();
    const docWithParseHtml = Document as unknown as DocumentWithParseHtml;
    if (typeof docWithParseHtml.parseHTML === "function") {
      const parsedDoc = docWithParseHtml.parseHTML(cleanHtml);
      while (parsedDoc.body.firstChild) {
        fragment.appendChild(parsedDoc.body.firstChild);
      }
    } else {
      const fallback = range.createContextualFragment(cleanHtml);
      fragment.appendChild(fallback);
    }

    const lastInserted = fragment.lastChild;
    range.insertNode(fragment);
    if (lastInserted) {
      const afterRange = document.createRange();
      afterRange.setStartAfter(lastInserted);
      afterRange.collapse(true);
      sel.removeAllRanges();
      sel.addRange(afterRange);
    }

    emitChange();
    refreshActiveFormats();
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-white focus-within:border-indigo-500">
      {/* Accessible Rich Text Formatting Toolbar */}
      <div
        ref={toolbarRef}
        role="toolbar"
        {...({ focusgroup: "toolbar wrap" } as Record<string, string>)}
        aria-label="Text formatting"
        aria-controls={editorId}
        className="flex flex-wrap items-center gap-0.5 border-b border-slate-200 bg-slate-50/80 px-2 py-1.5 rounded-t-xl"
      >
        <div role="group" aria-label="Text style" className="flex items-center gap-0.5">
          <button
            type="button"
            className="postlet-toolbar-btn"
            aria-label="Bold"
            title="Bold (Ctrl+B)"
            aria-pressed={formats.bold}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => runCommand("bold")}
          >
            <Bold className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
          <button
            type="button"
            className="postlet-toolbar-btn"
            aria-label="Italic"
            title="Italic (Ctrl+I)"
            aria-pressed={formats.italic}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => runCommand("italic")}
          >
            <Italic className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
          <button
            type="button"
            className="postlet-toolbar-btn"
            aria-label="Underline"
            title="Underline (Ctrl+U)"
            aria-pressed={formats.underline}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => runCommand("underline")}
          >
            <Underline className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
          <button
            type="button"
            className="postlet-toolbar-btn"
            aria-label="Strikethrough"
            title="Strikethrough"
            aria-pressed={formats.strike}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => runCommand("strikeThrough")}
          >
            <Strikethrough className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
          <button
            type="button"
            className="postlet-toolbar-btn"
            aria-label="Inline Code"
            title="Inline Code"
            aria-pressed={formats.code}
            onMouseDown={(e) => e.preventDefault()}
            onClick={toggleInlineCode}
          >
            <Code className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>

        <span role="separator" aria-orientation="vertical" className="postlet-toolbar-sep" />

        <div role="group" aria-label="Blocks and lists" className="flex items-center gap-0.5">
          <button
            type="button"
            className="postlet-toolbar-btn"
            aria-label="Heading"
            title="Heading"
            aria-pressed={formats.heading}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => toggleBlockTag("H2")}
          >
            <Heading2 className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
          <button
            type="button"
            className="postlet-toolbar-btn"
            aria-label="Bulleted list"
            title="Bulleted list"
            aria-pressed={formats.ul}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => runCommand("insertUnorderedList")}
          >
            <List className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
          <button
            type="button"
            className="postlet-toolbar-btn"
            aria-label="Numbered list"
            title="Numbered list"
            aria-pressed={formats.ol}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => runCommand("insertOrderedList")}
          >
            <ListOrdered className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
          <button
            type="button"
            className="postlet-toolbar-btn"
            aria-label="Blockquote"
            title="Blockquote"
            aria-pressed={formats.blockquote}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => toggleBlockTag("BLOCKQUOTE")}
          >
            <Quote className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>

        <span role="separator" aria-orientation="vertical" className="postlet-toolbar-sep" />

        <div role="group" aria-label="Links and cleanup" className="flex items-center gap-0.5">
          <button
            type="button"
            className="postlet-toolbar-btn"
            aria-label="Insert link"
            title="Insert link (Ctrl+K)"
            onMouseDown={(e) => e.preventDefault()}
            onClick={openLinkEditor}
          >
            <Link2 className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
          <button
            type="button"
            className="postlet-toolbar-btn"
            aria-label="Clear formatting"
            title="Clear formatting"
            onMouseDown={(e) => e.preventDefault()}
            onClick={clearAllFormatting}
          >
            <RemoveFormatting className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
      </div>

      {/* Inline Hyperlink Input Bar (replaces browser prompt) */}
      {linkBarOpen && (
        <div
          className="flex flex-wrap items-center gap-2 border-b border-indigo-100 bg-indigo-50/70 px-3 py-2 text-xs"
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              setLinkBarOpen(false);
              editorRef.current?.focus();
            } else if (e.key === "Enter") {
              e.preventDefault();
              applyLink();
            }
          }}
        >
          <input
            ref={linkUrlInputRef}
            type="url"
            value={linkUrl}
            onChange={(e) => {
              setLinkUrl(e.target.value);
              setLinkError("");
            }}
            placeholder="https://example.com or mailto:..."
            aria-label="Link URL"
            className="min-w-[180px] flex-1 rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs text-slate-900 focus:border-indigo-500 focus:outline-none"
          />
          <input
            type="text"
            value={linkText}
            onChange={(e) => setLinkText(e.target.value)}
            placeholder="Link text (optional)"
            aria-label="Link text"
            className="min-w-[140px] flex-1 rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs text-slate-900 focus:border-indigo-500 focus:outline-none"
          />
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={applyLink}
              className="rounded-md bg-indigo-600 px-2.5 py-1 font-semibold text-white hover:bg-indigo-700"
            >
              Apply
            </button>
            {editingExistingLink && (
              <button
                type="button"
                onClick={removeActiveLink}
                className="inline-flex items-center gap-1 rounded-md border border-rose-200 bg-white px-2 py-1 font-medium text-rose-700 hover:bg-rose-50"
              >
                <Unlink className="h-3 w-3" aria-hidden="true" />
                Remove
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                setLinkBarOpen(false);
                editorRef.current?.focus();
              }}
              className="rounded-md border border-slate-200 bg-white px-2 py-1 font-medium text-slate-700 hover:bg-slate-100"
            >
              Cancel
            </button>
          </div>
          {linkError && <p className="w-full text-[11px] font-medium text-rose-600">{linkError}</p>}
        </div>
      )}

      {/* ContentEditable Canvas */}
      <div
        id={editorId}
        ref={editorRef}
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-label="Email body"
        data-placeholder={placeholder}
        onInput={() => {
          emitChange();
          refreshActiveFormats();
        }}
        onKeyUp={refreshActiveFormats}
        onMouseUp={refreshActiveFormats}
        onPaste={(e) => void handlePaste(e)}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && !e.altKey) {
            const lower = e.key.toLowerCase();
            if (lower === "k") {
              e.preventDefault();
              openLinkEditor();
            } else if (lower === "b" || lower === "i" || lower === "u") {
              // Ensure keyboard shortcuts trigger immediate state/ARIA sync alongside browser formatting.
              queueMicrotask(() => {
                emitChange();
                refreshActiveFormats();
              });
            }
          }
        }}
        className="postlet-richtext p-3"
      />

      {/* Screen-reader feedback live region kept strictly outside role="toolbar" */}
      <p role="status" className="sr-only">
        {statusMessage}
      </p>
    </div>
  );
}
