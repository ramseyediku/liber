// Watches every page for apply/flow-step clicks and reports them to
// background.js, which tracks a per-tab capture flow (pending, captured,
// saved) in browser.storage.session. The click itself is never blocked —
// there's nothing deterministic left to do synchronously, now that field
// extraction is an on-device LLM (src/shared/llmEngine.js) that can read
// arbitrary page text instead of needing a precisely-scoped DOM region.
//
// Instead, every trigger click does two things:
// 1. Fires an immediate, empty-scopeText LIBER_FLOW_STEP message — a no-op
//    extraction (same as "nothing found nearby" always was), whose only real
//    effect is to create/touch this tab's flow in background.js *before*
//    anything navigates away. That's what lets background.js's
//    tabs.onUpdated listener recognize "this tab is mid-flow" even after a
//    real page navigation destroys this content script entirely, or a click
//    opens a brand-new tab whose own content script has no idea a click
//    happened. See background.js's header for the other half of this.
// 2. Watches for the real single-job surface to actually appear — a modal
//    popping up, or (if neither a modal nor a navigation happens) the page
//    just settling after an in-place SPA step change — and *then* collects
//    and sends its text. See watchForStepChange() below.
//
// Trigger detection (click-keyword matching) and the multi-listing count
// stay deterministic and page-local; only "which DOM region is worth
// reading" changed from click-time card-scoping to wait-and-see.

(function () {
  // One pattern for every click that's part of an application: starting one
  // ("Apply"/"Submit") or continuing one already started ("Next"/"Continue"/
  // "Review"). background.js's own per-tab flow state is what actually
  // decides "starting" vs. "continuing" — this just reports every matching
  // click.
  const TRIGGER_PATTERN = /\b(apply|submit|next|continue|review)\b/i;

  // Used only to detect how many distinct job titles are visible right now
  // (see countVisibleJobTitles below) — informational/logged only. It no
  // longer gates which scope-resolution strategy runs, since there's only
  // one now (wait for the real single-job surface, then read it).
  const JOB_TITLE_HINTS = {
    specific: ["job-title", "jobtitle", "job_title"],
    broad: ["position", "role"],
  };

  // Max plausible text length for something to count as a job title —
  // guards against a match landing on a wrapping container that swallows
  // unrelated sibling text.
  const JOB_TITLE_MAX_LENGTH = 120;

  // Upper bound on how much text gets sent to the background LLM per scan.
  // resolvePageScope() already bounds *where* we look (a dialog or a single
  // landmark, never arbitrary stray text), this just caps worst-case
  // payload/prompt size on a large landmark (e.g. an entire `<main>`).
  const SCOPE_TEXT_MAX_LENGTH = 4000;

  // How long watchForStepChange() waits for a dialog-like element to appear
  // before giving up and falling back to a plain landmark scan. Long enough
  // to cover a typical modal open/animation, short enough to still feel
  // immediate relative to how long the user then spends filling the form in.
  const SETTLE_WINDOW_MS = 2500;

  // Per-click context, reset at the top of the click handler below and read
  // directly by logStep (every log line reports whether this is a
  // multi-listing page). Closure state rather than a parameter threaded
  // through every function below.
  let multipleListingsDetected = false;

  // Every scraping-flow log goes through here: prints to this page's own
  // console (as before) *and* relays to background.js so it lands in
  // logStorage — otherwise these logs would only ever be visible to
  // someone who had this specific page's devtools open at the right
  // moment. Fire-and-forget; a logging call must never block or fail the
  // scrape itself.
  function logStep(step, detail) {
    const payload = { ...(detail || {}), multipleListingsDetected };
    console.log(`Liber: ${step}`, payload);
    browser.runtime
      .sendMessage({ type: "LIBER_LOG", url: location.href, step, detail: payload })
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

  // Counts distinct visible job titles on the page right now. A listing/
  // search page shows several; a true single-job page — or an apply modal
  // that's covering the list behind it — shows at most one. Dedupes by
  // text so the same title appearing in two matching elements (e.g. an h1
  // AND a data-testid element) isn't counted twice. Informational only —
  // logged on every click, doesn't change how scanning happens.
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

  // Page-wide, anchor-less replacement for the old click-anchored landmark
  // walk — there's no "clicked element" to walk up from anymore by the time
  // this runs, just whatever's now on screen.
  function resolvePageScope() {
    return (
      findVisibleDialog() ||
      document.querySelector('form, main, [role="main"], article') ||
      document.body
    );
  }

  // Plain, bounded text from the resolved scope — this is what background.js
  // hands to the on-device LLM (src/shared/llmEngine.js) to turn into
  // {jobTitle, company, location}. `.innerText` (not `.textContent`) so
  // hidden descendants (display:none, visibility:hidden) don't contribute
  // text the user can't actually see either.
  function collectPageText(scope) {
    return (scope.innerText || "").replace(/\s+/g, " ").trim().slice(0, SCOPE_TEXT_MAX_LENGTH);
  }

  // Waits for the real single-job surface to appear after a trigger click:
  // a dialog/modal popping up, or — if neither a modal nor a page navigation
  // happens within SETTLE_WINDOW_MS (e.g. a "step 2 of 4" wizard that swaps
  // its form content in place with no dialog at all) — just the page as it
  // stands once the window elapses. Resolves with null if the page
  // navigates away before either happens; the destination page is covered
  // by background.js's tabs.onUpdated listener instead, not by this one.
  function watchForStepChange() {
    return new Promise((resolve) => {
      let settled = false;
      let throttled = false;

      function finish(scope) {
        if (settled) return;
        settled = true;
        observer.disconnect();
        clearTimeout(timer);
        window.removeEventListener("pagehide", onPageHide);
        resolve(scope);
      }

      function onPageHide() {
        finish(null);
      }

      const observer = new MutationObserver(() => {
        if (throttled) return;
        throttled = true;
        setTimeout(() => {
          throttled = false;
          const dialog = findVisibleDialog();
          if (dialog) finish(dialog);
        }, 150);
      });
      observer.observe(document.body, { childList: true, subtree: true });

      window.addEventListener("pagehide", onPageHide);
      const timer = setTimeout(() => finish(resolvePageScope()), SETTLE_WINDOW_MS);
    });
  }

  document.addEventListener(
    "click",
    (event) => {
      const target = event.target.closest("button, a, input[type='submit']");
      if (!target) return;
      if (!isTrigger(target)) return;

      // No preventDefault — the native action (navigation/form submission)
      // always proceeds immediately and normally now.

      // Fires first, synchronously, before anything else: this is the
      // "arming" message described in the file header — it creates/touches
      // this tab's flow in background.js even if this content script's own
      // context gets torn down by navigation before watchForStepChange()
      // below ever resolves.
      browser.runtime
        .sendMessage({ type: "LIBER_FLOW_STEP", url: location.href, scopeText: "" })
        .catch(() => {});

      const visibleJobTitleCount = countVisibleJobTitles();
      multipleListingsDetected = visibleJobTitleCount > 1;
      logStep("trigger clicked", { text: getClickableText(target) });

      new Audio(browser.runtime.getURL("src/assets/notif.mp3"))
        .play()
        .catch(() => {});

      logStep("listing check", { visibleJobTitleCount, multipleListingsDetected });

      watchForStepChange().then((scope) => {
        if (!scope) {
          logStep("page navigated away before a step surface appeared");
          return;
        }
        logStep("scope resolved", describeEl(scope));
        const scopeText = collectPageText(scope);
        logStep("sending LIBER_FLOW_STEP", { scopeTextLength: scopeText.length });
        browser.runtime
          .sendMessage({ type: "LIBER_FLOW_STEP", url: location.href, scopeText })
          .catch(() => {});
      });
    },
    true, // capture phase — catches it even if the site stops propagation
  );
})();
