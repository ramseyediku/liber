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
    if (message.type !== "LIBER_EXTRACTION_STATUS") return;
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
    structuredSnapshot: JobFieldSnapshot | null;
  }

  // Shows the consent popup — shared by a fresh capture and a prompt resumed
  // from a prior page/tab (see LIBER_CHECK_PENDING_CONSENT below). The
  // {url, scopeText, structuredSnapshot} is already captured by this point.
  function beginConsentFlow({ url, scopeText, structuredSnapshot }: PendingConsent): void {
    awaitingConsentResponse = true;

    // Tracked by background.js's pendingConsentByTab so an unanswered prompt
    // can follow a redirect/new tab before the user answers.
    browser.runtime
      .sendMessage({ type: "LIBER_CONSENT_PENDING", url, scopeText, structuredSnapshot })
      .catch(() => {});

    renderConsentPopup({
      onYes: () => {
        logStep("consent accepted");
        renderWorkingPopup(0);
        browser.runtime.sendMessage({ type: "LIBER_CONSENT_RESOLVED" }).catch(() => {});
        browser.runtime
          .sendMessage({ type: "LIBER_SAVE_REQUESTED", url, scopeText, structuredSnapshot })
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
      const url = location.href;
      logStep("captured at trigger click", {
        scopeTextLength: scopeText.length,
        hasStructuredData: hasAnyField(rawStructuredSnapshot),
        scopeText: scopeText || "no snapshot",
      });

      beginConsentFlow({
        url,
        scopeText,
        structuredSnapshot: hasAnyField(rawStructuredSnapshot) ? rawStructuredSnapshot : null,
      });
    },
    true, // capture phase — catches it even if the site stops propagation
  );
})();
