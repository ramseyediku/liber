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
// the captured HTML. A floating log button (dev installs, or when switched on
// in Settings) shows what each capture did.

interface JobFieldSnapshot {
  jobTitle: string;
  company: string;
  location: string;
}

(function () {
  // Trigger words: starting an application ("Apply"/"Submit") or continuing
  // one ("Next"/"Continue"/"Review"). Word-boundary match on root words (not
  // a phrase list) so new phrasings work without a list edit; `\b` avoids
  // false hits inside "resubmit"/"submitted". Runs on every page
  // (`<all_urls>`), so a "Submit"/"Continue" button on an unrelated page
  // matches too — harmless, since nothing extractable near it just produces
  // an empty consent prompt the user declines.
  const TRIGGER_PATTERN = /\b(apply|submit|next|continue|review)\b/i;

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
    markLogActivity();
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

  function isTrigger(el: Element | null): boolean {
    if (!el) return false;
    const text = getClickableText(el);
    return !!text && TRIGGER_PATTERN.test(text);
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
      clickedEl.closest(DIALOG_SELECTOR) ||
      clickedEl.closest('form, main, [role="main"], article') ||
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
    let node = clickedEl.parentElement;
    for (
      let depth = 0;
      node && node !== document.body && depth < MAX_REPEAT_WALK_DEPTH;
      depth++, node = node.parentElement
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
      clickedEl.closest("article") ||
      clickedEl.closest("li") ||
      clickedEl.closest('[role="listitem"]') ||
      clickedEl.closest("[data-job-id]") ||
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
  function collectScopeHtml(scope: Element): string {
    const clone = scope.cloneNode(true) as Element;
    clone.querySelectorAll(HTML_DROP_SELECTOR).forEach((el) => el.remove());

    const comments: Node[] = [];
    const walker = document.createTreeWalker(clone, NodeFilter.SHOW_COMMENT);
    while (walker.nextNode()) comments.push(walker.currentNode);
    comments.forEach((node) => node.parentNode?.removeChild(node));

    // Deepest first, so a wrapper emptied by removing its empty children goes too.
    const all = Array.from(clone.querySelectorAll("*")).reverse();
    for (const el of all) {
      if (!(el.textContent || "").trim()) {
        el.remove();
        continue;
      }
      for (const attr of Array.from(el.attributes)) {
        const keep = HTML_KEEP_ATTRS.has(attr.name) || attr.name.startsWith("data-");
        if (!keep || attr.value.length > HTML_MAX_ATTR_LENGTH) el.removeAttribute(attr.name);
      }
    }

    return clone.outerHTML.replace(/>\s+</g, "><").replace(/\s{2,}/g, " ").trim().slice(0, HTML_MAX_LENGTH);
  }

  // Runs selectors against captured HTML (never the live page, which may have
  // moved on since the click). textContent, not innerText: a parsed document
  // has no layout.
  function readFieldsFromHtml(html: string, selectors: JobFieldSnapshot): JobFieldSnapshot {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const read = (selector: string): string => {
      if (!selector) return "";
      try {
        const el = doc.querySelector(selector);
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
  // Unobtrusive, fixed-position, built fresh per phase. No AI/model wording
  // anywhere — matches the product's no-AI-wording principle.

  const POPUP_ID = "liber-extraction-popup";

  function ensurePopupEl(): HTMLElement {
    let el = document.getElementById(POPUP_ID);
    if (!el) {
      el = document.createElement("div");
      el.id = POPUP_ID;
      el.style.cssText =
        "position:fixed; bottom:16px; right:16px; z-index:2147483647; " +
        'background:#fff; color:#1f1f1f; font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; ' +
        "padding:14px 16px; border-radius:12px; box-shadow:0 4px 20px rgba(0,0,0,0.22); " +
        "width:260px;";
      document.body.appendChild(el);
    }
    return el;
  }

  function hidePopup(): void {
    document.getElementById(POPUP_ID)?.remove();
  }

  interface ActionButton {
    label: string;
    primary: boolean;
    onClick: () => void;
  }

  function buildActionsRow(buttons: ActionButton[]): HTMLElement {
    const actions = document.createElement("div");
    actions.style.cssText = "display:flex; gap:8px; margin-top:10px;";
    buttons.forEach(({ label, primary, onClick }) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = label;
      btn.style.cssText = primary
        ? "flex:1; padding:7px 0; border:none; border-radius:12px; background:#3b82f6; color:#fff; font:inherit; font-weight:600; cursor:pointer;"
        : "flex:1; padding:7px 0; border:1px solid #d9d9d9; border-radius:12px; background:transparent; color:#1f1f1f; font:inherit; cursor:pointer;";
      btn.addEventListener("click", onClick);
      actions.appendChild(btn);
    });
    return actions;
  }

  // Shown immediately on a trigger click — nothing extracted or saved yet.
  function renderConsentPopup({ onYes, onNo }: { onYes: () => void; onNo: () => void }): void {
    const el = ensurePopupEl();
    el.innerHTML = "";

    const title = document.createElement("div");
    title.style.cssText = "font-weight:600; margin-bottom:10px;";
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
    const el = ensurePopupEl();
    el.innerHTML = "";

    const label = document.createElement("div");
    label.style.cssText = "font-weight:600; margin-bottom:8px;";
    label.textContent = "Liber is doing some work…";
    el.appendChild(label);

    const track = document.createElement("div");
    track.style.cssText = "height:4px; background:#e5e5e5; border-radius:2px; overflow:hidden;";
    const fill = document.createElement("div");
    fill.style.cssText = `height:100%; width:${progress || 0}%; background:#3b82f6; transition:width .2s ease;`;
    track.appendChild(fill);
    el.appendChild(track);
  }

  type Outcome = "saved" | "duplicate" | "limit" | "failed";

  const OUTCOME_TEXT: Record<Outcome, string> = {
    saved: "Job saved. You can check it in your table.",
    duplicate: "This job's already in your tracker.",
    limit: "You've hit the free limit — unlock Liber to keep saving.",
    failed: "Couldn't save this one — try again shortly.",
  };

  function renderResultPopup(outcome: Outcome): void {
    const el = ensurePopupEl();
    el.innerHTML = "";

    const label = document.createElement("div");
    label.textContent = OUTCOME_TEXT[outcome] || OUTCOME_TEXT.failed;
    el.appendChild(label);

    setTimeout(hidePopup, 4000);
  }

  browser.runtime.onMessage.addListener((message: any) => {
    // background.js asking us to run stored/learned selectors against the
    // captured HTML (it has no DOM parser of its own).
    if (message.type === "LIBER_RUN_SELECTORS") {
      return Promise.resolve(readFieldsFromHtml(message.scopeHtml || "", message.selectors));
    }
    if (message.type !== "LIBER_EXTRACTION_STATUS") return;
    markLogActivity();
    if (message.phase === "working") {
      renderWorkingPopup(message.progress);
    } else if (message.phase === "done") {
      renderResultPopup(message.outcome);
      // The one place "yes" unblocks — see awaitingConsentResponse below.
      awaitingConsentResponse = false;
    }
  });

  // Blocks further trigger clicks while a prompt awaits a response, or an
  // accepted one is still saving — otherwise a multi-step wizard's later
  // clicks would re-prompt mid-save. "No" resets instantly; "yes"
  // deliberately doesn't (only the "done" phase above does), so the whole
  // save window is covered. Resets on navigation (fresh content-script
  // instance) — a same-tab SPA route change to a different job can prompt
  // again once whatever's pending resolves.
  let awaitingConsentResponse = false;

  interface PendingConsent {
    url: string;
    scopeText: string;
    scopeHtml: string;
    structuredSnapshot: JobFieldSnapshot | null;
  }

  // Shows the consent popup — shared by a fresh capture and a prompt resumed
  // from a prior page/tab (see LIBER_CHECK_PENDING_CONSENT below). The
  // {url, scopeText, structuredSnapshot} is already captured by this point.
  function beginConsentFlow({ url, scopeText, scopeHtml, structuredSnapshot }: PendingConsent): void {
    awaitingConsentResponse = true;

    // Tracked by background.js's pendingConsentByTab so an unanswered prompt
    // can follow a redirect/new tab before the user answers.
    browser.runtime
      .sendMessage({ type: "LIBER_CONSENT_PENDING", url, scopeText, scopeHtml, structuredSnapshot })
      .catch(() => {});

    renderConsentPopup({
      onYes: () => {
        logStep("consent accepted");
        renderWorkingPopup(0);
        browser.runtime.sendMessage({ type: "LIBER_CONSENT_RESOLVED" }).catch(() => {});
        browser.runtime
          .sendMessage({ type: "LIBER_SAVE_REQUESTED", url, scopeText, scopeHtml, structuredSnapshot })
          .catch(() => {});
      },
      onNo: () => {
        awaitingConsentResponse = false;
        logStep("consent declined");
        browser.runtime.sendMessage({ type: "LIBER_CONSENT_RESOLVED" }).catch(() => {});
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
      if (pending && !awaitingConsentResponse) {
        logStep("resumed pending consent", { url: pending.url });
        beginConsentFlow(pending);
      }
    })
    .catch(() => {});

  document.addEventListener(
    "click",
    (event) => {
      const target = (event.target as Element)?.closest("button, a, input[type='submit']");
      if (!target) return;
      if (!isTrigger(target)) return;
      if (awaitingConsentResponse) return;

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
      const scopeText = collectPageText(scope);
      const scopeHtml = collectScopeHtml(scope);
      const url = location.href;
      logStep("captured at trigger click", {
        scopeTextLength: scopeText.length,
        scopeHtmlLength: scopeHtml.length,
        hasStructuredData: hasAnyField(rawStructuredSnapshot),
        scopeText: scopeText || "no snapshot",
      });

      beginConsentFlow({
        url,
        scopeText,
        scopeHtml,
        structuredSnapshot: hasAnyField(rawStructuredSnapshot) ? rawStructuredSnapshot : null,
      });
    },
    true, // capture phase — catches it even if the site stops propagation
  );

  // --- Floating capture log --------------------------------------------------
  // A small button, bottom-left of every page, that opens this tab's capture
  // log: what was captured, whether Claude was called or a stored site
  // structure answered instead, and how the save ended. Shown on unpacked
  // (dev) installs by default, or wherever Settings → Developer turns it on.
  // Lives in a shadow root so page CSS can't touch it (nor it the page).

  const LOG_BUTTON_FLAG = "liber_show_log_button";
  const LOG_HOST_ID = "liber-log-host";
  const LOG_POLL_MS = 1000;

  interface CaptureLogEntry {
    step: string;
    detail: unknown;
    timestamp: number;
  }

  let logDot: HTMLElement | null = null;
  let logPanelOpen = false;
  let logHasNew = false;

  function markLogActivity(): void {
    if (logPanelOpen) return;
    logHasNew = true;
    if (logDot) logDot.hidden = false;
  }

  async function shouldShowLogButton(): Promise<boolean> {
    const stored = ((await browser.storage.local.get(LOG_BUTTON_FLAG)) as Record<string, unknown>)[
      LOG_BUTTON_FLAG
    ];
    if (typeof stored === "boolean") return stored;
    return !("update_url" in browser.runtime.getManifest()); // unpacked = dev install
  }

  function el(tag: string, css: string, text?: string): HTMLElement {
    const node = document.createElement(tag);
    node.style.cssText = css;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function summarizeCaptures(entries: CaptureLogEntry[]): Record<string, string> | null {
    const latest = [...entries].reverse().find((e) => e.step === "capture summary");
    if (!latest || typeof latest.detail !== "object" || !latest.detail) return null;
    const d = latest.detail as Record<string, unknown>;
    const text = (v: unknown, fallback = "—") => (v === undefined || v === null || v === "" ? fallback : String(v));
    return {
      Site: text(d.hostname),
      "Read from": text(d.source),
      "Claude": text(d.claude),
      "Site structure": text(d.structure),
      Result: text(d.outcome),
    };
  }

  function mountLogButton(): void {
    if (document.getElementById(LOG_HOST_ID) || !document.body) return;

    const host = document.createElement("div");
    host.id = LOG_HOST_ID;
    host.style.cssText = "all:initial; position:fixed; bottom:16px; left:16px; z-index:2147483647;";
    const root = host.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = `
      * { box-sizing: border-box; font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; }
      .fab { position: relative; width: 42px; height: 42px; border-radius: 50%; border: none; cursor: pointer;
        background: #1f1f1f; color: #fff; box-shadow: 0 4px 16px rgba(0,0,0,.35); display: grid; place-items: center; }
      .fab svg { width: 20px; height: 20px; }
      .dot { position: absolute; top: 2px; right: 2px; width: 10px; height: 10px; border-radius: 50%; background: #3b82f6; border: 2px solid #1f1f1f; }
      .panel { position: absolute; bottom: 52px; left: 0; width: 380px; max-width: calc(100vw - 32px); max-height: 60vh;
        display: flex; flex-direction: column; background: #161616; color: #eaeaea; border-radius: 12px;
        box-shadow: 0 8px 32px rgba(0,0,0,.45); overflow: hidden; }
      .head { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid #2c2c2c; }
      .head strong { flex: 1; font-size: 13px; }
      .head button { background: #2a2a2a; color: #eaeaea; border: none; border-radius: 6px; padding: 4px 8px; cursor: pointer; }
      .summary { padding: 10px 12px; border-bottom: 1px solid #2c2c2c; display: grid; grid-template-columns: auto 1fr; gap: 2px 12px; }
      .summary dt { color: #8a8a8a; } .summary dd { margin: 0; word-break: break-all; }
      .empty { padding: 14px 12px; color: #8a8a8a; }
      .list { overflow: auto; padding: 4px 0; }
      details { padding: 4px 12px; border-bottom: 1px solid #222; }
      summary { cursor: pointer; list-style: none; display: flex; gap: 8px; }
      summary .t { color: #8a8a8a; flex: none; }
      pre { margin: 6px 0 2px; white-space: pre-wrap; word-break: break-word; color: #b9c4d6; max-height: 160px; overflow: auto; }
    `;
    root.appendChild(style);

    const fab = document.createElement("button");
    fab.className = "fab";
    fab.type = "button";
    fab.setAttribute("aria-label", "Liber capture log");
    fab.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>';
    logDot = document.createElement("span");
    logDot.className = "dot";
    logDot.hidden = !logHasNew;
    fab.appendChild(logDot);
    root.appendChild(fab);

    let panel: HTMLElement | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;

    async function refresh(): Promise<void> {
      if (!panel) return;
      const entries: CaptureLogEntry[] =
        (await browser.runtime.sendMessage({ type: "LIBER_GET_LOGS" }).catch(() => [])) || [];
      const body = panel.querySelector(".body") as HTMLElement;
      body.replaceChildren();

      const summary = summarizeCaptures(entries);
      if (summary) {
        const dl = document.createElement("dl");
        dl.className = "summary";
        for (const [key, value] of Object.entries(summary)) {
          const dt = document.createElement("dt");
          dt.textContent = key;
          const dd = document.createElement("dd");
          dd.textContent = value;
          dl.append(dt, dd);
        }
        body.appendChild(dl);
      }

      if (!entries.length) {
        const empty = document.createElement("div");
        empty.className = "empty";
        empty.textContent = "Nothing captured on this tab yet. Click an Apply button to try.";
        body.appendChild(empty);
        return;
      }

      const list = document.createElement("div");
      list.className = "list";
      for (const entry of [...entries].reverse()) {
        const details = document.createElement("details");
        const sum = document.createElement("summary");
        const t = document.createElement("span");
        t.className = "t";
        t.textContent = new Date(entry.timestamp).toLocaleTimeString();
        const label = document.createElement("span");
        label.textContent = entry.step;
        sum.append(t, label);
        details.appendChild(sum);
        if (entry.detail !== null && entry.detail !== undefined) {
          const pre = document.createElement("pre");
          pre.textContent = JSON.stringify(entry.detail, null, 2).slice(0, 4000);
          details.appendChild(pre);
        }
        list.appendChild(details);
      }
      body.appendChild(list);
    }

    function closePanel(): void {
      logPanelOpen = false;
      if (timer) clearInterval(timer);
      timer = null;
      panel?.remove();
      panel = null;
    }

    function openPanel(): void {
      logPanelOpen = true;
      logHasNew = false;
      if (logDot) logDot.hidden = true;

      panel = document.createElement("div");
      panel.className = "panel";
      const head = document.createElement("div");
      head.className = "head";
      const title = document.createElement("strong");
      title.textContent = "Liber capture log";
      const clear = document.createElement("button");
      clear.type = "button";
      clear.textContent = "Clear";
      clear.addEventListener("click", async () => {
        await browser.runtime.sendMessage({ type: "LIBER_CLEAR_LOGS" }).catch(() => {});
        refresh();
      });
      const close = document.createElement("button");
      close.type = "button";
      close.textContent = "Close";
      close.addEventListener("click", closePanel);
      head.append(title, clear, close);
      const body = document.createElement("div");
      body.className = "body";
      body.style.cssText = "display:flex; flex-direction:column; min-height:0; overflow:auto;";
      panel.append(head, body);
      root.appendChild(panel);

      refresh();
      timer = setInterval(refresh, LOG_POLL_MS);
    }

    fab.addEventListener("click", () => (panel ? closePanel() : openPanel()));
    document.body.appendChild(host);
  }

  function unmountLogButton(): void {
    document.getElementById(LOG_HOST_ID)?.remove();
    logDot = null;
    logPanelOpen = false;
  }

  async function syncLogButton(): Promise<void> {
    if (await shouldShowLogButton()) mountLogButton();
    else unmountLogButton();
  }

  if (window === window.top) {
    syncLogButton().catch(() => {});
    browser.storage.onChanged.addListener(
      (changes: { [key: string]: chrome.storage.StorageChange }, area: string) => {
        if (area === "local" && changes[LOG_BUTTON_FLAG]) syncLogButton().catch(() => {});
      },
    );
  }
})();
