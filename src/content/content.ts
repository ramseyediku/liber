// Watches every page for apply-flow clicks and reports them to background.js,
// which runs field extraction (Claude API via src/shared/extraction.ts) —
// never this file.
//
// Single-click, consent-first: a trigger click captures one snapshot, scoped
// to the specific job, then asks "Save this job to your tracker?" before
// touching the model at all. Only "yes" triggers background.js's
// JSON-LD-then-LLM-if-needed save. Earlier designs tried to detect "has the
// user actually finished applying" (grace timers, continuation signals,
// cross-tab carryover) — see docs/roadmap.md's capture-flow history for why
// that was dropped in favor of just asking.
//
// Once "yes", background.js pushes LIBER_EXTRACTION_STATUS messages here to
// drive the on-page popup: "working" progress, then a saved/duplicate/failed
// result.
//
// What gets captured is the job's cleaned HTML (page chrome stripped), which
// Claude reads to find the fields and to propose CSS selectors for them.
// Those selectors are stored per hostname (the shared site_structures table)
// so a later visit can be read straight from the DOM with no Claude call —
// background.js asks this script to run them (LIBER_RUN_SELECTORS) against
// the captured HTML. Every step is logged (LIBER_LOG / background.ts); the
// dashboard's capture log button shows them.

interface JobFieldSnapshot {
  jobTitle: string;
  company: string;
  location: string;
}

(function () {
  // Trigger words: applying ("Apply", "Easy Apply", "Apply now") or submitting
  // ("Submit", "Submit application"), plus the ways sites phrase the same
  // thing: "Send (my/your) application / CV / resume" and "Finish / complete /
  // finalise application". "Next", "Continue" and "Review" deliberately do NOT
  // trigger: they sit in the middle of wizards and on unrelated pages, and the
  // user only wants the prompt for the apply/submit action itself.
  // Word-boundary matching: `\b` avoids hits inside "applied"/"resubmit".
  const TRIGGER_PATTERN =
    /\b(apply|submit)\b|\bsend\s+(?:in\s+)?(?:my\s+|your\s+|an?\s+|the\s+)?(?:application|cv|resume|résumé)\b|\b(?:finish|finalise|finalize|complete)\s+(?:my\s+|your\s+|the\s+)?application\b/i;

  // Buttons that contain a trigger word but aren't a job application: search
  // filters, coupons, form changes, feedback. Checked after the pattern above.
  const NOT_A_TRIGGER_PATTERN =
    /\b(apply|submit)\s+(?:the\s+|a\s+|an\s+|your\s+|my\s+)?(?:filters?|changes?|coupon|code|promo|discount|settings|feedback|review|comment|search|query|payment|vote|report)\b/i;

  // Synonym hints for counting visible job titles (see countVisibleJobTitles).
  const JOB_TITLE_HINTS = {
    specific: ["job-title", "jobtitle", "job_title"],
    broad: ["position", "role"],
  };

  const JOB_TITLE_MAX_LENGTH = 120; // guards against a wrapper swallowing sibling text
  const SCOPE_TEXT_MAX_LENGTH = 4000; // caps worst-case payload size per scan

  // Repetition-detection tuning for resolveMultiJobScope — reasoned defaults,
  // not measured against a broad site sample.
  const CLASS_OVERLAP_THRESHOLD = 0.5; // Jaccard class-list overlap to count as "same card shape"
  const MIN_CARD_TEXT_LENGTH = 40; // skip ancestors too small to be a real card (e.g. the button's own wrapper)
  const MAX_REPEAT_WALK_DEPTH = 8; // bound on how far up the DOM the repetition search climbs

  // Logs to this page's console and relays to background.js's logStorage, so
  // the dashboard's activity log shows it even without devtools open.
  function logStep(step: string, detail: unknown = null): void {
    console.log(`Liber: ${step}`, detail || {});
    browser.runtime
      .sendMessage({ type: "LIBER_LOG", url: location.href, step, detail: detail ?? null })
      .catch(() => {});
  }

  function synonymSelector(tags: string[], attrs: string[], words: string[]): string {
    return tags
      .flatMap((tag) => attrs.flatMap((attr) => words.map((w) => `${tag}[${attr}*="${w}" i]`)))
      .join(", ");
  }

  function getClickableText(el: Element): string {
    return (
      (el as HTMLElement).innerText ||
      (el as HTMLInputElement).value ||
      el.getAttribute("aria-label") ||
      ""
    ).trim();
  }

  // Anything a user clicks to apply: real buttons and links, and the
  // div-as-button controls popups often use.
  const CLICKABLE_SELECTOR = "button, a, input[type='submit'], [role='button']";

  function clickedControl(event: Event): Element | null {
    for (const node of event.composedPath()) {
      if (node === document) break;
      if (node instanceof Element && node.matches(CLICKABLE_SELECTOR)) return node;
    }
    return null;
  }

  function isTrigger(el: Element | null): boolean {
    if (!el) return false;
    const text = getClickableText(el);
    return !!text && TRIGGER_PATTERN.test(text) && !NOT_A_TRIGGER_PATTERN.test(text);
  }

  function describeEl(el: Element) {
    return { tag: el.tagName, id: el.id || undefined, className: el.className || undefined };
  }

  // "Visible" = actually topmost at its on-screen point right now, not just
  // present in the layout — checked via elementFromPoint rather than
  // offsetParent/aria-hidden. Needed because Indeed's Easy Apply modal
  // overlays the background job list without hiding or aria-hiding it, so a
  // layout-only check still saw background cards as "visible" at the final
  // step. A modal backdrop sits on top of background content in virtually
  // every real implementation regardless of ARIA hygiene.
  function isVisible(el: Element): boolean {
    const htmlEl = el as HTMLElement;
    if (!htmlEl.offsetParent) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;

    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    if (cx < 0 || cy < 0 || cx > window.innerWidth || cy > window.innerHeight) {
      return false; // scrolled out of the current viewport
    }

    const topEl = document.elementFromPoint(cx, cy);
    return !!topEl && (topEl === el || el.contains(topEl) || topEl.contains(el));
  }

  // "broad" hints (position/role) also match a real form's own fields
  // ("Current role") — excluding form controls avoids double-counting those
  // as a second job title.
  const JOB_TITLE_EXCLUDE_SELECTOR = "input, select, textarea, label, button";

  // Counts distinct visible job titles right now (capped at 2 — every
  // caller only asks "more than one?"). Gates which scope-resolution path a
  // trigger click uses.
  function countVisibleJobTitles(): number {
    const { specific, broad } = JOB_TITLE_HINTS;
    const stableAttrs = ["data-testid", "data-test", "aria-label"];
    const selector = [
      "h1, h2",
      synonymSelector([""], stableAttrs, specific),
      synonymSelector([""], ["id", "class"], specific),
      synonymSelector([""], stableAttrs, broad),
      synonymSelector([""], ["id", "class"], broad),
    ]
      .filter(Boolean)
      .join(", ");

    const titles = new Set<string>();
    for (const el of document.querySelectorAll(selector)) {
      if (titles.size >= 2) break; // early exit — only "more than one?" matters
      if (el.matches(JOB_TITLE_EXCLUDE_SELECTOR)) continue;
      if (!isVisible(el)) continue;
      const text = (el.textContent || "").trim();
      if (text && text.length <= JOB_TITLE_MAX_LENGTH) titles.add(text);
    }
    return titles.size;
  }

  const DIALOG_SELECTOR = '[role="dialog"], [aria-modal="true"], dialog';

  // --- Shadow DOM ---------------------------------------------------------
  // Popups built as web components live in shadow roots. closest() and
  // parentElement stop at a shadow root, so these walk up through the host as
  // well. Only open shadow roots are reachable; closed ones are invisible to
  // any extension.

  function composedParent(el: Element): Element | null {
    if (el.parentElement) return el.parentElement;
    const root = el.getRootNode();
    return root instanceof ShadowRoot ? root.host : null;
  }

  function closestComposed(el: Element, selector: string): Element | null {
    for (let node: Element | null = el; node; ) {
      const hit = node.closest(selector);
      if (hit) return hit;
      const root = node.getRootNode();
      node = root instanceof ShadowRoot ? root.host : null;
    }
    return null;
  }

  // Fallback for modals with no ARIA semantics: a fixed/absolute,
  // high-z-index element covering a large chunk of the viewport. Same
  // accepted false-positive risk as isVisible() (a large promo banner could
  // qualify; a small toast won't).
  function findOverlayFallback(): Element | null {
    for (const el of document.querySelectorAll("body *")) {
      if (!isVisible(el)) continue;
      const style = getComputedStyle(el);
      if (style.position !== "fixed" && style.position !== "absolute") continue;
      if ((Number(style.zIndex) || 0) < 100) continue;

      const rect = el.getBoundingClientRect();
      const viewportArea = window.innerWidth * window.innerHeight;
      if ((rect.width * rect.height) / viewportArea >= 0.3) return el;
    }
    return null;
  }

  function findVisibleDialog(): Element | null {
    const el = Array.from(document.querySelectorAll(DIALOG_SELECTOR)).find(isVisible);
    return el || findOverlayFallback();
  }

  // Shared fallback: whatever dialog is open, else a bounded landmark
  // (covers split-view list+detail too), else document.body.
  function resolvePageScope(): Element {
    return (
      findVisibleDialog() ||
      document.querySelector('form, main, [role="main"], article') ||
      document.body
    );
  }

  // Single-job page: scope to the container around the clicked element
  // (proximity to the click), not just the nearest landmark anywhere.
  function resolveSingleJobScope(clickedEl: Element): Element {
    return (
      closestComposed(clickedEl, DIALOG_SELECTOR) ||
      closestComposed(clickedEl, 'form, main, [role="main"], article') ||
      resolvePageScope()
    );
  }

  // Two elements count as "the same repeated structure" if same tag + a
  // majority of shared classes (order-independent) — ignores text/ids/data-*
  // values, which is exactly what differs between two repeated cards.
  function sameStructure(a: Element, b: Element): boolean {
    if (a.tagName !== b.tagName) return false;
    const aClasses = new Set(a.classList);
    const bClasses = new Set(b.classList);
    if (aClasses.size === 0 && bClasses.size === 0) return true;
    const union = new Set([...aClasses, ...bClasses]);
    const shared = [...aClasses].filter((c) => bClasses.has(c)).length;
    return union.size > 0 && shared / union.size >= CLASS_OVERLAP_THRESHOLD;
  }

  // Walks up from the click looking for the first ancestor with a
  // structurally-similar sibling — that's "the repeated card." The
  // MIN_CARD_TEXT_LENGTH gate skips the Apply button's own thin wrapper,
  // which is nearly always structurally identical across every card.
  function findRepeatedCardAncestor(clickedEl: Element): Element | null {
    let node = composedParent(clickedEl);
    for (
      let depth = 0;
      node && node !== document.body && depth < MAX_REPEAT_WALK_DEPTH;
      depth++, node = composedParent(node)
    ) {
      if ((node.textContent || "").trim().length < MIN_CARD_TEXT_LENGTH) continue;
      const siblings = node.parentElement
        ? Array.from(node.parentElement.children).filter((sib) => sib !== node)
        : [];
      if (siblings.some((sib) => sameStructure(node!, sib))) return node;
    }
    return null;
  }

  // Multi-job (listings) page: find the specific card the click happened
  // inside — repetition detection first, then common listing-item
  // selectors, then the shared fallback tail.
  function resolveMultiJobScope(clickedEl: Element): Element {
    return (
      findRepeatedCardAncestor(clickedEl) ||
      closestComposed(clickedEl, "article") ||
      closestComposed(clickedEl, "li") ||
      closestComposed(clickedEl, '[role="listitem"]') ||
      closestComposed(clickedEl, "[data-job-id]") ||
      resolvePageScope()
    );
  }

  // Page chrome rarely carries job-field info and eats into the text budget
  // — worst case being the document.body fallback, which would otherwise
  // include the whole site's nav/footer.
  const STRIP_SELECTOR =
    'nav, header, footer, script, style, noscript, [role="navigation"], [role="banner"], [role="contentinfo"]';

  // Bounded text from the resolved scope, sent to the extraction backend.
  // `.innerText` (not `.textContent`) excludes hidden descendants. Chrome is
  // stripped by temporarily hiding it and re-reading `.innerText` (needs
  // live layout, so a detached clone would read back empty) — synchronous,
  // before the click's native action runs, so there's no visible flicker.
  function collectPageText(scope: Element): string {
    const toHide = Array.from(scope.querySelectorAll<HTMLElement>(STRIP_SELECTOR));
    const prevDisplay = toHide.map((el) => el.style.display);
    toHide.forEach((el) => {
      el.style.display = "none";
    });
    const text = ((scope as HTMLElement).innerText || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, SCOPE_TEXT_MAX_LENGTH);
    toHide.forEach((el, i) => {
      el.style.display = prevDisplay[i]!;
    });
    return text;
  }

  // --- Page hints ---------------------------------------------------------------
  // Title/og/h1 text: reliable even when the markup is a mess, and the header
  // that usually holds the company is stripped from the captured HTML.

  interface PageHints {
    title: string;
    ogTitle: string;
    ogSiteName: string;
    description: string;
    headings: string[];
  }

  function collectPageHints(): PageHints {
    const meta = (selector: string, max: number): string =>
      (document.querySelector<HTMLMetaElement>(selector)?.content || "").replace(/\s+/g, " ").trim().slice(0, max);
    const headings = Array.from(document.querySelectorAll("h1"))
      .map((h) => (h.textContent || "").replace(/\s+/g, " ").trim().slice(0, 150))
      .filter(Boolean)
      .slice(0, 3);
    return {
      title: (document.title || "").replace(/\s+/g, " ").trim().slice(0, 200),
      ogTitle: meta('meta[property="og:title"]', 200),
      ogSiteName: meta('meta[property="og:site_name"]', 100),
      description: meta('meta[property="og:description"], meta[name="description"]', 300),
      headings,
    };
  }

  // --- Cleaned HTML for Claude / selectors ------------------------------------

  const HTML_MAX_LENGTH = 24000;
  const HTML_DROP_SELECTOR =
    STRIP_SELECTOR +
    ', svg, iframe, img, picture, video, audio, canvas, object, embed, link, meta, template, button, input, select, textarea, [hidden], [aria-hidden="true"]';
  const HTML_KEEP_ATTRS = new Set(["id", "class", "itemprop", "role", "aria-label", "name"]);
  const HTML_MAX_ATTR_LENGTH = 120;

  // The scope's HTML with everything that isn't job content removed: page
  // chrome (header/nav/footer), scripts/styles, media, hidden nodes, empty
  // elements, and every attribute that isn't a plausible selector hook
  // (id/class/data-*/itemprop/role/aria-label). Selectors learned from this
  // are run against this same cleaned shape later, so it must stay stable.
  // The Apply button the user clicked is tagged in the captured HTML, so what
  // reads that HTML later (Claude on the first visit, stored selectors after)
  // can tell which job on a multi-job page the click belonged to.
  const CLICK_MARK = "data-liber-clicked";

  const EXCLUDE_MARK = "data-liber-exclude";

  // A deep copy that also inlines open shadow roots (cloneNode(true) skips
  // them), each wrapped in <div data-liber-shadow> so it reads as one tree.
  function cloneComposed(src: Element): Element {
    const copy = src.cloneNode(false) as Element;
    const shadow = (src as HTMLElement).shadowRoot;
    if (shadow) {
      const wrap = document.createElement("div");
      wrap.setAttribute("data-liber-shadow", "");
      shadow.childNodes.forEach((child) => wrap.appendChild(cloneNodeComposed(child)));
      copy.appendChild(wrap);
    }
    src.childNodes.forEach((child) => copy.appendChild(cloneNodeComposed(child)));
    return copy;
  }

  function cloneNodeComposed(node: Node): Node {
    return node instanceof Element ? cloneComposed(node) : node.cloneNode(false);
  }

  function collectScopeHtml(
    scope: Element,
    clicked: Element | null = null,
    max = HTML_MAX_LENGTH,
    exclude: Element | null = null,
  ): string {
    // Tagged on the live elements just long enough to be copied by the clone.
    clicked?.setAttribute(CLICK_MARK, "1");
    exclude?.setAttribute(EXCLUDE_MARK, "");
    const clone = cloneComposed(scope);
    clicked?.removeAttribute(CLICK_MARK);
    exclude?.removeAttribute(EXCLUDE_MARK);
    clone.querySelectorAll(`[${EXCLUDE_MARK}]`).forEach((el) => el.remove());

    // The clicked element itself survives cleaning even if it is a <button>
    // or has no text, since it is the anchor everything else is measured from.
    clone.querySelectorAll(HTML_DROP_SELECTOR).forEach((el) => {
      if (!el.hasAttribute(CLICK_MARK)) el.remove();
    });

    const comments: Node[] = [];
    const walker = document.createTreeWalker(clone, NodeFilter.SHOW_COMMENT);
    while (walker.nextNode()) comments.push(walker.currentNode);
    comments.forEach((node) => node.parentNode?.removeChild(node));

    // Deepest first, so a wrapper emptied by removing its empty children goes too.
    const all = Array.from(clone.querySelectorAll("*")).reverse();
    for (const el of all) {
      if (!el.hasAttribute(CLICK_MARK) && !(el.textContent || "").trim()) {
        el.remove();
        continue;
      }
      for (const attr of Array.from(el.attributes)) {
        const keep = HTML_KEEP_ATTRS.has(attr.name) || attr.name.startsWith("data-");
        if (!keep || attr.value.length > HTML_MAX_ATTR_LENGTH) el.removeAttribute(attr.name);
      }
    }

    return windowAroundClick(
      clone.outerHTML.replace(/>\s+</g, "><").replace(/\s{2,}/g, " ").trim(),
      max,
    );
  }

  // Over the cap, keep the stretch around the clicked button rather than the
  // top of the scope: on a wide scope (a long listing page) the job that was
  // clicked can be well past the first 24k characters.
  function windowAroundClick(html: string, max: number): string {
    if (html.length <= max) return html;
    const at = html.indexOf(CLICK_MARK);
    if (at < 0) return html.slice(0, max);
    const start = Math.max(0, Math.min(at - Math.floor(max * 0.7), html.length - max));
    return html.slice(start, start + max);
  }

  // Runs selectors against captured HTML (never the live page, which may have
  // moved on since the click). textContent, not innerText: a parsed document
  // has no layout.
  // Steps from `a` up to the nearest shared ancestor and down to `b`.
  function treeDistance(a: Node, b: Node): number {
    const up = new Map<Node, number>();
    let steps = 0;
    for (let n: Node | null = a; n; n = n.parentNode) up.set(n, steps++);
    steps = 0;
    for (let n: Node | null = b; n; n = n.parentNode, steps++) {
      const k = up.get(n);
      if (k !== undefined) return k + steps;
    }
    return Infinity;
  }

  // A stored selector like ".job-title" matches every job on a multi-job page.
  // Deterministically pick the match closest to the Apply button that was
  // clicked (fewest DOM steps apart; on a tie, the one that comes before the
  // button, since a card's title precedes its Apply button) — no Claude call,
  // and the same answer every time. With one match, or no marked click, it is
  // simply the first match.
  function nearestMatch(doc: Document, selector: string): Element | null {
    const matches = Array.from(doc.querySelectorAll(selector));
    const anchor = doc.querySelector(`[${CLICK_MARK}]`);
    if (matches.length <= 1 || !anchor) return matches[0] ?? null;

    let best = matches[0]!;
    let bestScore = Infinity;
    for (const match of matches) {
      const precedes = !!(anchor.compareDocumentPosition(match) & Node.DOCUMENT_POSITION_PRECEDING);
      const score = treeDistance(anchor, match) * 2 + (precedes ? 0 : 1);
      if (score < bestScore) {
        best = match;
        bestScore = score;
      }
    }
    return best;
  }

  function readFieldsFromHtml(html: string, selectors: JobFieldSnapshot): JobFieldSnapshot {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const read = (selector: string): string => {
      if (!selector) return "";
      try {
        const el = nearestMatch(doc, selector);
        return (el?.textContent || "").replace(/\s+/g, " ").trim().slice(0, JOB_TITLE_MAX_LENGTH);
      } catch {
        return ""; // a selector the browser rejects reads as "not found"
      }
    };
    return {
      jobTitle: read(selectors.jobTitle),
      company: read(selectors.company),
      location: read(selectors.location),
    };
  }

  // --- Popups: capture the popup and the page behind it ----------------------
  // An Apply click inside a popup (dialog, modal, overlay) usually happens in
  // the application form, while the job's title and company sit on the page
  // behind it. So both are captured: the popup (with the clicked button) and
  // the main content behind it, each cleaned, under its own budget.

  const POPUP_HTML_MAX = 13500;
  const PAGE_BEHIND_HTML_MAX = 10000;
  const POPUP_TEXT_MAX = 2400;
  const PAGE_BEHIND_TEXT_MAX = 1600;

  // The popup the clicked element sits in, if any: a dialog by its semantics,
  // or a large fixed overlay without them (findOverlayFallback).
  function popupAround(clicked: Element): Element | null {
    const dialog = closestComposed(clicked, DIALOG_SELECTOR);
    if (dialog) return dialog;
    const overlay = findOverlayFallback();
    return overlay && overlay.contains(clicked) ? overlay : null;
  }

  // The page content behind a popup: the first main landmark that isn't the
  // popup or inside it, else the whole body with the popup cut out.
  function pageBehind(popup: Element): Element {
    for (const el of document.querySelectorAll('main, [role="main"], article')) {
      if (!popup.contains(el) && !el.contains(popup)) return el;
    }
    return document.body;
  }

  interface Capture {
    scopeText: string;
    scopeHtml: string;
    popup: boolean;
  }

  function capture(scope: Element, clicked: Element): Capture {
    const popup = popupAround(clicked);
    if (!popup) {
      return { scopeText: collectPageText(scope), scopeHtml: collectScopeHtml(scope, clicked), popup: false };
    }
    const behind = pageBehind(popup);
    const popupScope = popup.contains(scope) ? scope : popup;
    const popupHtml = collectScopeHtml(popupScope, clicked, POPUP_HTML_MAX);
    const behindHtml = collectScopeHtml(behind, null, PAGE_BEHIND_HTML_MAX, popup);
    const popupText = collectPageText(popupScope).slice(0, POPUP_TEXT_MAX);
    const behindText = collectPageText(behind).slice(0, PAGE_BEHIND_TEXT_MAX);
    return {
      scopeHtml:
        `<div data-liber-part="popup">${popupHtml}</div>` +
        `<div data-liber-part="page-behind">${behindHtml}</div>`,
      scopeText: behindText ? `${popupText}\n— Page behind the popup —\n${behindText}` : popupText,
      popup: true,
    };
  }

  // Mirrors src/shared/jobPostingLd.ts — duplicated here since content
  // scripts can't `import` ES modules. Keep both in sync.
  function flattenJobPostingCandidates(root: any): any[] {
    if (Array.isArray(root)) return root;
    if (root && Array.isArray(root["@graph"])) return root["@graph"];
    return root ? [root] : [];
  }

  function extractCompanyName(org: any): string {
    if (typeof org === "string") return org;
    if (org && typeof org.name === "string") return org.name;
    return "";
  }

  function extractLocationFromJd(jobLocation: any): string {
    const locs = Array.isArray(jobLocation) ? jobLocation : jobLocation ? [jobLocation] : [];
    for (const loc of locs) {
      const addr = loc && loc.address;
      if (!addr) continue;
      const parts = [addr.addressLocality, addr.addressRegion].filter(
        (s: unknown) => typeof s === "string" && s.trim(),
      );
      if (parts.length) return parts.join(", ");
    }
    return "";
  }

  function parseJobPostingLd(roots: any[]): JobFieldSnapshot {
    for (const root of roots) {
      for (const item of flattenJobPostingCandidates(root)) {
        if (!item || item["@type"] !== "JobPosting") continue;
        const jobTitle = typeof item.title === "string" ? item.title : "";
        const company = extractCompanyName(item.hiringOrganization);
        const location = extractLocationFromJd(item.jobLocation);
        if (jobTitle || company || location) return { jobTitle, company, location };
      }
    }
    return { jobTitle: "", company: "", location: "" };
  }

  // Deterministic free alternative to the LLM: most ATS detail pages embed
  // JobPosting JSON-LD. A complete read here means background.js skips the
  // LLM entirely.
  function collectJobPostingLd(): JobFieldSnapshot {
    const roots: any[] = [];
    for (const node of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        roots.push(JSON.parse(node.textContent || ""));
      } catch {
        // malformed JSON-LD — skip this tag
      }
    }
    return parseJobPostingLd(roots);
  }

  function hasAnyField(snapshot: JobFieldSnapshot): boolean {
    return !!(snapshot.jobTitle || snapshot.company || snapshot.location);
  }

  // --- Consent / working / result popup -----------------------------------
  // Fixed at the top centre of the page, large, and built inside a shadow
  // root so the page's own CSS can't restyle or hide it. Every Apply click
  // gets a *new* popup: any popup already showing fades out as the new one
  // fades in. No AI/model wording anywhere — matches the product's no-AI-wording
  // principle.

  const POPUP_ID = "liber-extraction-popup";
  const POPUP_FADE_MS = 220;

  let hideTimer: ReturnType<typeof setTimeout> | undefined;

  // Host properties are set `!important` so a page rule can't move or hide it.
  function setHostStyle(host: HTMLElement, props: Record<string, string>): void {
    for (const [name, value] of Object.entries(props)) host.style.setProperty(name, value, "important");
  }

  // The card inside the current popup's shadow root — what the render
  // functions fill in. null when no popup is showing.
  function currentPopupCard(): HTMLElement | null {
    const host = document.getElementById(POPUP_ID);
    return (host?.shadowRoot?.firstElementChild as HTMLElement | null) ?? null;
  }

  function createPopup(): HTMLElement {
    const host = document.createElement("div");
    host.id = POPUP_ID;
    setHostStyle(host, {
      all: "initial",
      display: "block",
      position: "fixed",
      top: "24px",
      left: "50%",
      transform: "translateX(-50%)",
      "z-index": "2147483647",
      width: "440px",
      "max-width": "calc(100vw - 32px)",
      opacity: "0",
      transition: `opacity ${POPUP_FADE_MS}ms ease`,
    });

    const card = document.createElement("div");
    card.style.cssText =
      "box-sizing:border-box; width:100%; background:#fff; color:#1f1f1f; " +
      'font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; ' +
      "padding:22px 26px; border-radius:16px; box-shadow:0 10px 32px rgba(0,0,0,0.28);";
    host.attachShadow({ mode: "open" }).appendChild(card);
    document.body.appendChild(host);

    requestAnimationFrame(() => setHostStyle(host, { opacity: "1" }));
    return card;
  }

  // Fades the current popup out and removes it. Its id is dropped at once so a
  // popup created right after isn't mistaken for it.
  function fadeOutCurrentPopup(): void {
    clearTimeout(hideTimer);
    const host = document.getElementById(POPUP_ID);
    if (!host) return;
    host.removeAttribute("id");
    setHostStyle(host, { opacity: "0", "pointer-events": "none" });
    setTimeout(() => host.remove(), POPUP_FADE_MS + 40);
  }

  // A brand-new popup for a new Apply click: the old one (whatever phase it
  // was in) fades out while this one fades in.
  function freshPopupCard(): HTMLElement {
    fadeOutCurrentPopup();
    return createPopup();
  }

  // The popup already showing, or a new one if there is none — for updates
  // within one flow (consent → working → result).
  function ensurePopupCard(): HTMLElement {
    return currentPopupCard() ?? createPopup();
  }

  function hidePopup(): void {
    fadeOutCurrentPopup();
  }

  interface ActionButton {
    label: string;
    primary: boolean;
    onClick: () => void;
  }

  function buildActionsRow(buttons: ActionButton[]): HTMLElement {
    const actions = document.createElement("div");
    actions.style.cssText = "display:flex; gap:12px; margin-top:16px;";
    buttons.forEach(({ label, primary, onClick }) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = label;
      btn.style.cssText = primary
        ? "flex:1; padding:12px 0; border:none; border-radius:12px; background:#3b82f6; color:#fff; font:inherit; font-weight:600; cursor:pointer;"
        : "flex:1; padding:12px 0; border:1px solid #d9d9d9; border-radius:12px; background:transparent; color:#1f1f1f; font:inherit; cursor:pointer;";
      btn.addEventListener("click", onClick);
      actions.appendChild(btn);
    });
    return actions;
  }

  // Shown immediately on a trigger click — nothing extracted or saved yet.
  function renderConsentPopup({ onYes, onNo }: { onYes: () => void; onNo: () => void }): void {
    const el = freshPopupCard();

    const title = document.createElement("div");
    title.style.cssText = "font-weight:600; font-size:19px;";
    title.textContent = "Save this job to your tracker?";
    el.appendChild(title);

    el.appendChild(
      buildActionsRow([
        { label: "Yes", primary: true, onClick: onYes },
        { label: "No", primary: false, onClick: onNo },
      ]),
    );
  }

  function renderWorkingPopup(progress: number): void {
    const el = ensurePopupCard();
    el.innerHTML = "";

    const label = document.createElement("div");
    label.style.cssText = "font-weight:600; font-size:19px; margin-bottom:14px;";
    label.textContent = "Liber is doing some work…";
    el.appendChild(label);

    const track = document.createElement("div");
    track.style.cssText = "height:6px; background:#e5e5e5; border-radius:3px; overflow:hidden;";
    const fill = document.createElement("div");
    fill.style.cssText = `height:100%; width:${progress || 0}%; background:#3b82f6; transition:width .2s ease;`;
    track.appendChild(fill);
    el.appendChild(track);
  }

  type Outcome = "saved" | "duplicate" | "limit" | "failed" | "nothing-found";

  const OUTCOME_TEXT: Record<Outcome, string> = {
    saved: "Job saved. You can check it in your table.",
    duplicate: "This job's already in your tracker.",
    limit: "You've hit the free limit — unlock Liber to keep saving.",
    failed: "Couldn't save this one — try again shortly.",
    "nothing-found": "Couldn't find a job on this page. Try applying from the job's own page.",
  };

  function renderResultPopup(outcome: Outcome): void {
    const el = ensurePopupCard();
    el.innerHTML = "";

    const label = document.createElement("div");
    label.style.cssText = "font-weight:600; font-size:17px;";
    label.textContent = OUTCOME_TEXT[outcome] || OUTCOME_TEXT.failed;
    el.appendChild(label);

    clearTimeout(hideTimer);
    hideTimer = setTimeout(hidePopup, 4000);
  }

  // Shown instead of the consent prompt when there is clearly no job to read
  // near the click (a newsletter "Submit", an empty modal) — nothing is asked
  // or sent.
  function renderNoJobPopup(): void {
    const el = freshPopupCard();

    const title = document.createElement("div");
    title.style.cssText = "font-weight:600; font-size:19px;";
    title.textContent = "No job found here";
    el.appendChild(title);

    const hint = document.createElement("div");
    hint.style.cssText = "margin-top:6px; font-size:15px; color:#555;";
    hint.textContent = "Try applying from the job's own page.";
    el.appendChild(hint);

    clearTimeout(hideTimer);
    hideTimer = setTimeout(hidePopup, 5000);
  }

  // True while a "Save this job?" prompt is on screen waiting for an answer.
  // A save already in flight can finish while the user is looking at a newer
  // prompt; its working/result popups are skipped then so they don't replace it.
  let promptOpen = false;

  browser.runtime.onMessage.addListener((message: any) => {
    // background.js asking us to run stored/learned selectors against the
    // captured HTML (it has no DOM parser of its own).
    if (message.type === "LIBER_RUN_SELECTORS") {
      return Promise.resolve(readFieldsFromHtml(message.scopeHtml || "", message.selectors));
    }
    if (message.type !== "LIBER_EXTRACTION_STATUS") return;
    if (promptOpen) return; // a newer prompt is showing — don't replace it
    if (message.phase === "working") {
      renderWorkingPopup(message.progress);
    } else if (message.phase === "done") {
      renderResultPopup(message.outcome);
    }
  });

  interface PendingConsent {
    url: string;
    scopeText: string;
    scopeHtml: string;
    pageHints: PageHints;
    structuredSnapshot: JobFieldSnapshot | null;
  }

  // Shows the consent popup — shared by a fresh capture and a prompt resumed
  // from a prior page/tab (see LIBER_CHECK_PENDING_CONSENT below). The
  // {url, scopeText, structuredSnapshot} is already captured by this point.
  function beginConsentFlow({ url, scopeText, scopeHtml, pageHints, structuredSnapshot }: PendingConsent): void {
    promptOpen = true;

    // Tracked by background.js's pendingConsentByTab so an unanswered prompt
    // can follow a redirect/new tab before the user answers.
    browser.runtime
      .sendMessage({ type: "LIBER_CONSENT_PENDING", url, scopeText, scopeHtml, pageHints, structuredSnapshot })
      .catch(() => {});

    renderConsentPopup({
      onYes: () => {
        promptOpen = false;
        logStep("consent accepted");
        renderWorkingPopup(0);
        browser.runtime.sendMessage({ type: "LIBER_CONSENT_RESOLVED", answer: "yes", url }).catch(() => {});
        browser.runtime
          .sendMessage({ type: "LIBER_SAVE_REQUESTED", url, scopeText, scopeHtml, pageHints, structuredSnapshot })
          .catch(() => {});
      },
      onNo: () => {
        promptOpen = false;
        logStep("consent declined");
        browser.runtime.sendMessage({ type: "LIBER_CONSENT_RESOLVED", answer: "no", url }).catch(() => {});
        hidePopup();
      },
    });
  }

  // Picks up an unanswered consent prompt carried over from a prior page/tab
  // (same-tab redirect, or a new tab the trigger click opened). A no-op on
  // an ordinary page load with nothing pending.
  browser.runtime
    .sendMessage({ type: "LIBER_CHECK_PENDING_CONSENT" })
    .then((pending: PendingConsent | null) => {
      if (pending && !promptOpen) {
        logStep("resumed pending consent", { url: pending.url });
        beginConsentFlow(pending);
      }
    })
    .catch(() => {});

  document.addEventListener(
    "click",
    (event) => {
      // The real clicked control, even inside a shadow root (event.target is
      // retargeted to the shadow host at document level).
      const target = clickedControl(event);
      if (!target) return;
      if (!isTrigger(target)) return;

      // No preventDefault — the native action always proceeds normally.

      const text = getClickableText(target);
      const visibleJobTitleCount = countVisibleJobTitles();
      const multipleListingsDetected = visibleJobTitleCount > 1;
      logStep("trigger clicked", { text, visibleJobTitleCount, multipleListingsDetected });

      new Audio(browser.runtime.getURL("src/assets/notif.mp3")).play().catch(() => {});

      // Capture now, synchronously, before the click's native action runs.
      const scope = multipleListingsDetected
        ? resolveMultiJobScope(target)
        : resolveSingleJobScope(target);
      logStep("scope resolved", { multipleListingsDetected, ...describeEl(scope) });

      const rawStructuredSnapshot = collectJobPostingLd();
      const { scopeText, scopeHtml, popup } = capture(scope, target);
      const pageHints = collectPageHints();
      const url = location.href;
      logStep("captured at trigger click", {
        popup,
        scopeTextLength: scopeText.length,
        scopeHtmlLength: scopeHtml.length,
        hasStructuredData: hasAnyField(rawStructuredSnapshot),
        scopeText: scopeText || "no snapshot",
      });

      // Nothing to read: no structured data, and next to no text around the
      // click. Say so instead of asking to save an empty job.
      const MIN_JOB_TEXT = 60;
      const nearbyText = scopeText.replace(/\s+/g, " ").trim().length || (scope.textContent || "").replace(/\s+/g, " ").trim().length;
      if (!hasAnyField(rawStructuredSnapshot) && nearbyText < MIN_JOB_TEXT) {
        logStep("no job content found near the click", { nearbyText });
        renderNoJobPopup();
        return;
      }

      beginConsentFlow({
        url,
        scopeText,
        scopeHtml,
        pageHints,
        structuredSnapshot: hasAnyField(rawStructuredSnapshot) ? rawStructuredSnapshot : null,
      });
    },
    true, // capture phase — catches it even if the site stops propagation
  );
})();
