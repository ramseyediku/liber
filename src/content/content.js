// Watches every page for apply-flow clicks and reports them to
// background.js, which runs the actual LLM extraction — never this file,
// see llmEngine.js's header for why.
//
// Single-click, consent-first design: a trigger click (apply/submit/next/
// continue/review) captures exactly one snapshot, scoped tightly to the
// specific job — either the container around the clicked element
// (single-job page) or, on a listings page, the specific repeated card the
// click happened inside (via structural repetition detection, see
// resolveMultiJobScope below). It then asks "Save this job to your
// tracker?" *before* touching the model at all — there's nothing to
// preview yet, just a plain yes/no ask. Only on "yes" does background.js
// run JSON-LD-then-LLM-if-needed and save.
//
// This deliberately does not try to detect "the user has truly finished
// applying" the way earlier designs in this project did (capture-at-submit,
// then multi-step capture-every-step/commit-on-continuation-absence) —
// that required a lot of fragile machinery (grace-period timers, cross-tab
// carryover, reload-vs-dialog heuristics tuned per-ATS) to approximate one
// question the user can just answer directly. See docs/roadmap.md's
// "Capture flow rewrite: single-click, consent-first" for the full history
// and why this replaces both prior designs.
//
// Once the user says yes, background.js pushes LIBER_EXTRACTION_STATUS
// messages here to drive the on-page popup below: a brief "doing some
// work" progress state, then a plain saved/duplicate/failed result.

(function () {
  // Every click that's part of an application, broadly: starting one
  // ("Apply"/"Submit") or continuing one already started ("Next"/
  // "Continue"/"Review"). Word-boundary match on root words rather than a
  // hardcoded phrase list, so new button phrasings ("Submit Your
  // Application", "Quick Apply") work without adding a list entry, and `\b`
  // keeps it from false-matching inside unrelated words like
  // "resubmit"/"submitted". The content script runs on every page via
  // `<all_urls>`, not just job sites, so a plain "Submit"/"Continue" button
  // on an unrelated page (e.g. a checkout form) matches too — harmless,
  // since a capture with nothing extractable near it just shows an
  // empty/best-effort consent prompt the user can decline.
  const TRIGGER_PATTERN = /\b(apply|submit|next|continue|review)\b/i;

  // Used only to detect how many distinct job titles are visible right now
  // (see countVisibleJobTitles below).
  const JOB_TITLE_HINTS = {
    specific: ["job-title", "jobtitle", "job_title"],
    broad: ["position", "role"],
  };

  // Max plausible text length for something to count as a job title —
  // guards against a match landing on a wrapping container that swallows
  // unrelated sibling text.
  const JOB_TITLE_MAX_LENGTH = 120;

  // Upper bound on how much text gets sent to the background LLM per scan.
  // The resolved scope is already bounded to a specific card/container,
  // this just caps worst-case payload/prompt size on a large one.
  const SCOPE_TEXT_MAX_LENGTH = 4000;

  // Repetition-detection tuning for resolveMultiJobScope — all three are
  // reasoned defaults, not measured against a broad site sample yet (same
  // "accepted risk, bounded, not derived from measurement" spirit as this
  // project's other heuristic constants, e.g. JOB_TITLE_MAX_LENGTH above).
  //
  // CLASS_OVERLAP_THRESHOLD: fraction of the union of two elements' class
  // lists that must be shared for them to count as "the same repeated
  // structure" (Jaccard-style overlap, order-independent).
  const CLASS_OVERLAP_THRESHOLD = 0.5;
  // MIN_CARD_TEXT_LENGTH: an ancestor whose own text is shorter than this
  // is skipped when looking for a repeated card — without this, the walk
  // stops at the Apply button's own thin wrapper div almost immediately,
  // since that wrapper is nearly always structurally identical across
  // every card on the page (same tag/classes), long before reaching the
  // actual card boundary.
  const MIN_CARD_TEXT_LENGTH = 40;
  // MAX_REPEAT_WALK_DEPTH: bounds how far up the DOM the repetition search
  // climbs before giving up and falling through to the fixed-selector
  // fallbacks below.
  const MAX_REPEAT_WALK_DEPTH = 8;

  // Every scraping-flow log goes through here: prints to this page's own
  // console (as before) *and* relays to background.js so it lands in
  // logStorage — otherwise these logs would only ever be visible to
  // someone who had this specific page's devtools open at the right
  // moment. Fire-and-forget; a logging call must never block or fail the
  // scrape itself.
  function logStep(step, detail) {
    console.log(`Liber: ${step}`, detail || {});
    browser.runtime
      .sendMessage({ type: "LIBER_LOG", url: location.href, step, detail: detail ?? null })
      .catch(() => {});
  }

  function synonymSelector(tags, attrs, words) {
    return tags
      .flatMap((tag) =>
        attrs.flatMap((attr) => words.map((w) => `${tag}[${attr}*="${w}" i]`)),
      )
      .join(", ");
  }

  function getClickableText(el) {
    return (
      el.innerText ||
      el.value ||
      el.getAttribute("aria-label") ||
      ""
    ).trim();
  }

  function isTrigger(el) {
    if (!el) return false;
    const text = getClickableText(el);
    return !!text && TRIGGER_PATTERN.test(text);
  }

  // Compact, log-safe descriptor for an element — enough to identify it in
  // the console without dumping the whole node (or its subtree).
  function describeEl(el) {
    return { tag: el.tagName, id: el.id || undefined, className: el.className || undefined };
  }

  // "Visible" means actually reachable/on top for the user right now, not
  // just present in the layout — checked via the real stacking order rather
  // than offsetParent/aria-hidden, which are accessibility-tree hints the
  // site has to bother setting. Indeed's Easy Apply modal overlays the
  // background job list without hiding or aria-hiding it, so a layout-only
  // check kept seeing it as "visible" even at the final submit step; a
  // modal's backdrop, on the other hand, sits on top of background content
  // in virtually every real implementation (to block accidental interaction
  // with it) whether or not the site marks that content aria-hidden — see
  // docs/roadmap.md.
  function isVisible(el) {
    if (!el.offsetParent) return false;
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

  // The "broad" hints (position/role) are substring-matched against
  // id/class/data-testid/aria-label, which also matches a real
  // application form's own fields — "Current role", "Desired position",
  // etc. Excluding form-control elements from the match avoids counting
  // those as a second "job title": a genuine job-title display element is
  // never an input/select/textarea/label/button, only those form fields
  // are. Checked separately in the loop below rather than baked into the
  // querySelectorAll string, since appending a `:not(...)` suffix to a
  // string that's already a comma-separated selector list (which
  // synonymSelector's output always is) would only apply it to the last
  // part of that list, not all of them.
  const JOB_TITLE_EXCLUDE_SELECTOR = "input, select, textarea, label, button";

  // Counts distinct visible job titles on the page right now. A listing/
  // search page shows several; a true single-job page shows at most one.
  // Dedupes by text so the same title appearing in two matching elements
  // (e.g. an h1 AND a data-testid element) isn't counted twice. Gates
  // which scope-resolution path the click handler uses below — re-checked
  // on every trigger click, not just the first.
  function countVisibleJobTitles() {
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

    const titles = new Set();
    for (const el of document.querySelectorAll(selector)) {
      // Early exit — the only thing any caller checks is "more than one?",
      // so there's no reason to keep scanning (and running isVisible()'s
      // elementFromPoint check on) the rest of a long listing page once a
      // second distinct title is confirmed. Caps the return value at 2,
      // not an exact count past that point.
      if (titles.size >= 2) break;
      if (el.matches(JOB_TITLE_EXCLUDE_SELECTOR)) continue;
      if (!isVisible(el)) continue;
      const text = el.textContent.trim();
      if (text && text.length <= JOB_TITLE_MAX_LENGTH) titles.add(text);
    }
    return titles.size;
  }

  const DIALOG_SELECTOR = '[role="dialog"], [aria-modal="true"], dialog';

  // A generic fallback for modals built without ARIA semantics: a
  // fixed/absolute-positioned, high-stacking element covering a large chunk
  // of the viewport. Heuristic, with the same accepted false-positive/
  // negative risk as isVisible() above (a large promo banner could
  // theoretically qualify; a small corner toast won't) — see docs/roadmap.md.
  function findOverlayFallback() {
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

  function findVisibleDialog() {
    const el = Array.from(document.querySelectorAll(DIALOG_SELECTOR)).find(isVisible);
    return el || findOverlayFallback();
  }

  // Shared fallback tail for both scope-resolution paths below: whatever
  // dialog is currently open, else a bounded local landmark (this also
  // covers a split-view list+detail layout, where the landmark is
  // typically the detail pane itself), else the whole body as a last
  // resort.
  function resolvePageScope() {
    return (
      findVisibleDialog() ||
      document.querySelector('form, main, [role="main"], article') ||
      document.body
    );
  }

  // Single-job page: scope to the container *around the clicked element*
  // (proximity to the click, not just "the nearest landmark/dialog/body"
  // anywhere in the document) — a dialog containing the click if there is
  // one, else the nearest form/main/article ancestor, else the shared
  // fallback tail.
  function resolveSingleJobScope(clickedEl) {
    return (
      clickedEl.closest(DIALOG_SELECTOR) ||
      clickedEl.closest('form, main, [role="main"], article') ||
      resolvePageScope()
    );
  }

  // Two elements count as "the same repeated structure" if they share a
  // tag name and a majority of their class list (order-independent,
  // Jaccard-style overlap) — ignores text content, ids, and data-*
  // attribute values entirely, since those are exactly what differs
  // between two otherwise-identical repeated cards.
  function sameStructure(a, b) {
    if (a.tagName !== b.tagName) return false;
    const aClasses = new Set(a.classList);
    const bClasses = new Set(b.classList);
    if (aClasses.size === 0 && bClasses.size === 0) return true; // bare tags, no classes at all
    const union = new Set([...aClasses, ...bClasses]);
    const shared = [...aClasses].filter((c) => bClasses.has(c)).length;
    return union.size > 0 && shared / union.size >= CLASS_OVERLAP_THRESHOLD;
  }

  // Walks up from the clicked element looking for the ancestor that
  // represents "the repeated card" — the first one (closest to the click)
  // that has at least one sibling matching sameStructure. The
  // MIN_CARD_TEXT_LENGTH gate is what keeps this from stopping at the
  // Apply button's own thin, structurally-identical-everywhere wrapper
  // instead of the actual card.
  function findRepeatedCardAncestor(clickedEl) {
    let node = clickedEl.parentElement;
    for (
      let depth = 0;
      node && node !== document.body && depth < MAX_REPEAT_WALK_DEPTH;
      depth++, node = node.parentElement
    ) {
      if (node.textContent.trim().length < MIN_CARD_TEXT_LENGTH) continue;
      const siblings = node.parentElement
        ? Array.from(node.parentElement.children).filter((sib) => sib !== node)
        : [];
      if (siblings.some((sib) => sameStructure(node, sib))) return node;
    }
    return null;
  }

  // Multi-job (listings) page: find the specific card the click happened
  // inside, via repetition detection first, then a fixed chain of common
  // listing-item selectors, then the shared fallback tail (which covers
  // both a split-view detail pane and the final whole-page capture).
  function resolveMultiJobScope(clickedEl) {
    return (
      findRepeatedCardAncestor(clickedEl) ||
      clickedEl.closest("article") ||
      clickedEl.closest("li") ||
      clickedEl.closest('[role="listitem"]') ||
      clickedEl.closest("[data-job-id]") ||
      resolvePageScope()
    );
  }

  // Page chrome (nav/header/footer, plus their ARIA-landmark equivalents)
  // almost never carries job-field information and just eats into the
  // SCOPE_TEXT_MAX_LENGTH budget — worst when the resolved scope is the
  // document.body fallback, which otherwise includes the whole site's nav
  // and footer verbatim. script/style/noscript aren't rendered anyway
  // (innerText already excludes them), listed here mainly for clarity.
  const STRIP_SELECTOR =
    'nav, header, footer, script, style, noscript, [role="navigation"], [role="banner"], [role="contentinfo"]';

  // Plain, bounded text from the resolved scope — this is what background.js
  // hands to the on-device LLM to turn into {jobTitle, company, location}.
  // `.innerText` (not `.textContent`) so hidden descendants (display:none,
  // visibility:hidden) don't contribute text the user can't actually see
  // either — which is also why chrome is stripped by temporarily hiding it
  // and re-reading `.innerText`, rather than operating on a detached clone:
  // `.innerText` requires live layout, so a cloneNode(true) detached from
  // the document would just read back empty. The hide/read/restore happens
  // synchronously within one tick, so there's no visible flicker, and
  // critically happens *before* the click's native action can run (see the
  // click handler below) — nothing here waits on anything.
  function collectPageText(scope) {
    const toHide = Array.from(scope.querySelectorAll(STRIP_SELECTOR));
    const prevDisplay = toHide.map((el) => el.style.display);
    toHide.forEach((el) => {
      el.style.display = "none";
    });
    const text = (scope.innerText || "").replace(/\s+/g, " ").trim().slice(0, SCOPE_TEXT_MAX_LENGTH);
    toHide.forEach((el, i) => {
      el.style.display = prevDisplay[i];
    });
    return text;
  }

  // Mirrors src/shared/jobPostingLd.js's parseJobPostingLd — duplicated
  // here since content.js can't `import` ES modules. Keep both in sync.
  function flattenJobPostingCandidates(root) {
    if (Array.isArray(root)) return root;
    if (root && Array.isArray(root["@graph"])) return root["@graph"];
    return root ? [root] : [];
  }

  function extractCompanyName(org) {
    if (typeof org === "string") return org;
    if (org && typeof org.name === "string") return org.name;
    return "";
  }

  function extractLocationFromJd(jobLocation) {
    const locs = Array.isArray(jobLocation) ? jobLocation : jobLocation ? [jobLocation] : [];
    for (const loc of locs) {
      const addr = loc && loc.address;
      if (!addr) continue;
      const parts = [addr.addressLocality, addr.addressRegion].filter(
        (s) => typeof s === "string" && s.trim(),
      );
      if (parts.length) return parts.join(", ");
    }
    return "";
  }

  function parseJobPostingLd(roots) {
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

  // Deterministic, free alternative to the LLM: most ATS-hosted job detail
  // pages (Greenhouse, Lever, Workday, and others) embed a JobPosting
  // JSON-LD block. When it's complete, background.js skips the LLM
  // entirely.
  function collectJobPostingLd() {
    const roots = [];
    for (const node of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        roots.push(JSON.parse(node.textContent));
      } catch {
        // malformed JSON-LD — skip this tag
      }
    }
    return parseJobPostingLd(roots);
  }

  function hasAnyField(snapshot) {
    return !!(snapshot.jobTitle || snapshot.company || snapshot.location);
  }

  // --- Consent / working / result popup ----------------------------------
  // Unobtrusive, fixed-position, built fresh per phase.

  const POPUP_ID = "liber-extraction-popup";

  function ensurePopupEl() {
    let el = document.getElementById(POPUP_ID);
    if (!el) {
      el = document.createElement("div");
      el.id = POPUP_ID;
      el.style.cssText =
        "position:fixed; bottom:16px; right:16px; z-index:2147483647; " +
        'background:#fff; color:#1f1f1f; font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; ' +
        "padding:14px 16px; border-radius:10px; box-shadow:0 4px 20px rgba(0,0,0,0.22); " +
        "width:260px;";
      document.body.appendChild(el);
    }
    return el;
  }

  function hidePopup() {
    const el = document.getElementById(POPUP_ID);
    if (el) el.remove();
  }

  function buildActionsRow(buttons) {
    const actions = document.createElement("div");
    actions.style.cssText = "display:flex; gap:8px; margin-top:10px;";
    buttons.forEach(({ label, primary, onClick }) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = label;
      btn.style.cssText = primary
        ? "flex:1; padding:7px 0; border:none; border-radius:6px; background:#3b82f6; color:#fff; font:inherit; font-weight:600; cursor:pointer;"
        : "flex:1; padding:7px 0; border:1px solid #d9d9d9; border-radius:6px; background:transparent; color:#1f1f1f; font:inherit; cursor:pointer;";
      btn.addEventListener("click", onClick);
      actions.appendChild(btn);
    });
    return actions;
  }

  // Deliberately no mention of AI/models anywhere below — framed only as
  // "the extension"/"your tracker" doing something, matching this
  // project's standing no-AI-wording principle (see docs/product-spec.md).

  // Shown immediately on a trigger click, before anything is extracted or
  // saved — nothing has touched the model yet at this point.
  function renderConsentPopup({ onYes, onNo }) {
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

  function renderWorkingPopup(progress) {
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

  const OUTCOME_TEXT = {
    saved: "Job saved. You can check it in your table.",
    duplicate: "This job's already in your tracker.",
    failed: "Couldn't save this one — try again shortly.",
  };

  function renderResultPopup(outcome) {
    const el = ensurePopupEl();
    el.innerHTML = "";

    const label = document.createElement("div");
    label.textContent = OUTCOME_TEXT[outcome] || OUTCOME_TEXT.failed;
    el.appendChild(label);

    setTimeout(hidePopup, 4000);
  }

  browser.runtime.onMessage.addListener((message) => {
    if (message.type !== "LIBER_EXTRACTION_STATUS") return;
    if (message.phase === "working") {
      renderWorkingPopup(message.progress);
    } else if (message.phase === "done") {
      renderResultPopup(message.outcome);
      // The one place "yes" ever gets un-blocked — see
      // awaitingConsentResponse below. Only reached once the save this
      // click triggered has actually finished, so a trigger click that
      // lands mid-save (while the "working" popup is showing) still has
      // nothing to do but return early.
      awaitingConsentResponse = false;
    }
  });

  // Blocks further trigger clicks in this tab from doing anything while a
  // consent prompt is awaiting a response, OR while an accepted one is
  // still being extracted/saved — without this, a multi-step wizard's
  // later Next/Continue/Submit clicks (or just an impatient second click
  // on the same Apply button) would either re-prompt "Save this job to
  // your tracker?" before the user ever answered the first one, or
  // re-prompt *again* while the first "yes" is still mid-save. "No" resets
  // it instantly (nothing pending, free to prompt again right away); "yes"
  // deliberately does NOT reset it here — it only clears once
  // LIBER_EXTRACTION_STATUS's "done" phase actually arrives above, so the
  // whole save window is covered, not just the moment the popup was on
  // screen. Also naturally resets on any real page navigation, since
  // that's a fresh content-script instance — a same-tab SPA route change
  // to a genuinely different job is still free to prompt again once
  // whatever's currently pending resolves.
  let awaitingConsentResponse = false;

  // Shows the consent popup and wires up its answer handling — shared by a
  // fresh trigger-click capture (below) and by a prompt resumed from a prior
  // page/tab in this same flow (see the LIBER_CHECK_PENDING_CONSENT call
  // further down). Either way, {url, scopeText, structuredSnapshot} is
  // already captured by this point; this function only ever shows/answers
  // the prompt, never captures anything itself.
  function beginConsentFlow({ url, scopeText, structuredSnapshot }) {
    awaitingConsentResponse = true;

    // Tracked by background.js so this unanswered prompt can follow the
    // user if this tab redirects, or the click opened a new tab, before
    // they answer — see background.js's pendingConsentByTab. Resolved
    // (cleared) the instant they actually do, in onYes/onNo below.
    browser.runtime
      .sendMessage({ type: "LIBER_CONSENT_PENDING", url, scopeText, structuredSnapshot })
      .catch(() => {});

    renderConsentPopup({
      onYes: () => {
        // Deliberately NOT reset here — stays blocked through the whole
        // save; see awaitingConsentResponse's comment above.
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

  // Picks up an unanswered consent prompt carried over from a prior
  // page/tab in this same flow — a same-tab redirect (this is a fresh
  // content-script instance; the old one that showed the prompt is already
  // gone) or a new tab the trigger click opened (e.g. an ATS that routes
  // the real application through an intermediate domain). A no-op (resolves
  // to null) on a completely ordinary page load with nothing pending, so
  // this costs one cheap round-trip on every page, not just application
  // pages. Only ever resumes the exact prompt already shown elsewhere —
  // nothing is re-captured here.
  browser.runtime
    .sendMessage({ type: "LIBER_CHECK_PENDING_CONSENT" })
    .then((pending) => {
      if (pending && !awaitingConsentResponse) {
        logStep("resumed pending consent", { url: pending.url });
        beginConsentFlow(pending);
      }
    })
    .catch(() => {});

  document.addEventListener(
    "click",
    (event) => {
      const target = event.target.closest("button, a, input[type='submit']");
      if (!target) return;
      if (!isTrigger(target)) return;
      if (awaitingConsentResponse) return;

      // No preventDefault — the native action (navigation/form submission)
      // always proceeds immediately and normally, whatever happens below.

      const text = getClickableText(target);
      const visibleJobTitleCount = countVisibleJobTitles();
      const multipleListingsDetected = visibleJobTitleCount > 1;
      logStep("trigger clicked", { text, visibleJobTitleCount, multipleListingsDetected });

      new Audio(browser.runtime.getURL("src/assets/notif.mp3"))
        .play()
        .catch(() => {});

      // Capture now, synchronously, before the click's own native action
      // can change anything.
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
        // The actual text handed to the LLM (extractJobFields), not HTML —
        // collectPageText already reads .innerText, not markup. Included in
        // full so the activity log can show exactly what the model saw,
        // for debugging extraction misses. Logged as a clear placeholder
        // rather than an empty string when there's nothing there (e.g. the
        // resolved scope had no visible text) — note this is only for the
        // log's own display; the real (possibly empty) scopeText below is
        // still what actually gets sent in beginConsentFlow.
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
