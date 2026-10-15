// Watches every page for apply/flow-step clicks and reports what's nearby
// to the background script, which tracks a per-tab capture flow (start,
// refine, prompt, save) in browser.storage.session. Scraping is
// site-agnostic: fields are found by matching common synonyms against
// stable attributes (data-testid, aria-label, itemprop, etc.) instead of
// hardcoded per-site CSS selectors, so new ATS platforms work without
// adding a selector table entry. Deterministic throughout — DOM scraping
// and simple heuristics only, no AI/probabilistic methods.

(function () {
  // One pattern for every click that's part of an application: starting
  // one ("Apply"/"Submit") or continuing one already started
  // ("Next"/"Continue"/"Review" — later steps use these, not "Apply").
  // Content.js no longer decides start-vs-continue from which word
  // matched — it just reports every matching click, and background.js
  // decides based on whether a flow already exists for this tab (see
  // LIBER_FLOW_STEP below). That split used to live here as two patterns;
  // keeping it here instead meant a step-two "Next" click on a real,
  // already-started application would've looked identical to a
  // completely new one typed from a different pattern match, with no way
  // to tell them apart — background's actual per-tab state is the only
  // reliable signal for that, so the decision moved there.
  const TRIGGER_PATTERN = /\b(apply|submit|next|continue|review)\b/i;

  // Synonym words matched as literal attribute-value substrings (CSS
  // attribute selectors can't strip separators), so compound forms of
  // "job title" are spelled out explicitly. Kept short and high-signal
  // rather than catch-everything, to avoid the old default selectors'
  // "matches unrelated elements" failure mode.
  //
  // Split into `specific` (compound, field-unambiguous) and `broad` (bare
  // root word, tried only if nothing specific matched) — a bare word like
  // "company" also shows up on unrelated same-page UI that has nothing to
  // do with the field itself (e.g. LinkedIn's "Company reviews" link,
  // which has nothing to do with the posting's actual company name but
  // still carries the word "company" in its own label). The compound form
  // ("company-name") doesn't collide with that, so it's tried first.
  const FIELD_SYNONYMS = {
    jobTitle: {
      specific: ["job-title", "jobtitle", "job_title"],
      broad: ["position", "role"],
    },
    company: {
      specific: ["company-name", "companyname", "employer-name"],
      broad: ["company", "employer", "organization"],
    },
    location: {
      specific: ["job-location", "joblocation", "work-location"],
      broad: ["location", "workplace", "address"],
    },
  };

  // Max plausible text length per field — guards against a synonym match
  // landing on a wrapping container that swallows unrelated sibling text.
  const FIELD_MAX_LENGTH = { jobTitle: 120, company: 80, location: 80 };

  // schema.org microdata uses these exact itemprop tokens regardless of
  // site — standards-based, so it's tried before any synonym-guessing.
  const MICRODATA_ITEMPROP = {
    jobTitle: "title",
    company: "hiringOrganization",
    location: "jobLocation",
  };

  // Per-click context, reset at the top of the click handler below and
  // updated as extraction progresses. Read directly by logStep (every log
  // line reports "what do we know about this job so far, and is this a
  // multi-listing page") and by findLocalScope (to decide whether
  // findCardScope/findActiveCardScope are even worth trying — see there).
  // Closure state rather than extra parameters threaded through every
  // function in between (findLocalScope, findBySynonyms, firstMatchText).
  let jobInfoSoFar = { jobTitle: "", company: "", location: "" };
  let multipleListingsDetected = false;

  // Every scraping-flow log goes through here: prints to this page's own
  // console (as before) *and* relays to background.js so it lands in
  // logStorage — otherwise these logs would only ever be visible to
  // someone who had this specific page's devtools open at the right
  // moment. Fire-and-forget, same as the LIBER_FLOW_* sends below; a
  // logging call must never block or fail the scrape itself. Every call
  // gets the same jobInfoSoFar/multipleListingsDetected merged in, so each
  // log line is self-contained instead of only the steps that happen to
  // compute those directly.
  function logStep(step, detail) {
    const payload = {
      ...(detail || {}),
      jobInfoSoFar: { ...jobInfoSoFar },
      multipleListingsDetected,
    };
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

  // Excludes apply/flow-step controls from candidates — the scope passed
  // in is at or near the clicked element itself, so without this a
  // button's own accessible label (e.g. aria-label="Apply for this
  // position", or "Continue to next step") would satisfy a synonym match
  // on itself, returning its own label as the scraped value.
  function firstMatchText(selector, root, maxLen) {
    if (!selector) return "";
    for (const el of root.querySelectorAll(selector)) {
      if (isTrigger(el)) continue;
      const text = el.textContent.trim();
      if (text && text.length <= maxLen) return text;
    }
    return "";
  }

  // Generic, cross-site field finder. Bands are ordered most- to
  // least-specific: exact schema.org microdata beats synonym guessing;
  // within synonym guessing, the compound `specific` words beat the bare
  // `broad` ones (see FIELD_SYNONYMS), and data-testid/data-test/aria-label
  // (deliberately chosen by the site to be a stable hook) beat bare
  // id/class (easily unrelated, or renamed by a routine CSS refactor).
  function findBySynonyms(field, root) {
    const maxLen = FIELD_MAX_LENGTH[field];
    const { specific, broad } = FIELD_SYNONYMS[field];
    const stableAttrs = ["data-testid", "data-test", "aria-label"];

    // Logs which band actually produced the match (or "none"), so a
    // misbehaving extraction on some new site can be diagnosed from the
    // console (or the dashboard's activity log) instead of a debugger.
    // Updates jobInfoSoFar with the raw match immediately — extractNearAnchor
    // overwrites it with the final normalized snapshot once all three
    // fields are in, but this way progress is visible field-by-field too.
    const logMatch = (method, value) => {
      jobInfoSoFar = { ...jobInfoSoFar, [field]: value };
      logStep("field match", { field, method, value });
      return value;
    };

    const micro = firstMatchText(
      `[itemprop="${MICRODATA_ITEMPROP[field]}"]`,
      root,
      maxLen,
    );
    if (micro) return logMatch("microdata", micro);

    // Same bands, same order as before — now as labeled attempts instead
    // of an unbroken `||` chain, purely so the winning (or losing) band can
    // be logged. Short-circuit priority is unchanged.
    const attempts =
      field === "jobTitle"
        ? [
            [
              "heading+stableAttrs|id|class+specific",
              () =>
                firstMatchText(
                  synonymSelector(["h1", "h2"], [...stableAttrs, "id", "class"], specific),
                  root,
                  maxLen,
                ),
            ],
            [
              "stableAttrs+specific",
              () => firstMatchText(synonymSelector([""], stableAttrs, specific), root, maxLen),
            ],
            ["bare heading", () => firstMatchText("h1, h2", root, maxLen)],
            [
              "id|class+specific",
              () => firstMatchText(synonymSelector([""], ["id", "class"], specific), root, maxLen),
            ],
            [
              "stableAttrs+broad",
              () => firstMatchText(synonymSelector([""], stableAttrs, broad), root, maxLen),
            ],
            [
              "id|class+broad",
              () => firstMatchText(synonymSelector([""], ["id", "class"], broad), root, maxLen),
            ],
          ]
        : [
            [
              "stableAttrs+specific",
              () => firstMatchText(synonymSelector([""], stableAttrs, specific), root, maxLen),
            ],
            [
              "id|class+specific",
              () => firstMatchText(synonymSelector([""], ["id", "class"], specific), root, maxLen),
            ],
            [
              "stableAttrs+broad",
              () => firstMatchText(synonymSelector([""], stableAttrs, broad), root, maxLen),
            ],
            [
              "id|class+broad",
              () => firstMatchText(synonymSelector([""], ["id", "class"], broad), root, maxLen),
            ],
          ];

    for (const [method, attempt] of attempts) {
      const value = attempt();
      if (value) return logMatch(method, value);
    }
    return logMatch("none", "");
  }

  // Same tag and at least one shared class, rather than requiring the full
  // className string to match exactly — frameworks routinely vary a
  // per-item modifier class (zebra striping, a "--last" item, a "saved"
  // badge), which would make two genuinely repeated cards fail an exact
  // string comparison.
  function sameCardShape(a, b) {
    if (a.tagName !== b.tagName || !a.className) return false;
    return Array.from(b.classList).some((cls) => a.classList.contains(cls));
  }

  // On a search-results page, "Apply" sits inside one of many repeated job
  // cards — walking up to the nearest ancestor that has siblings sharing its
  // tag and class scopes every lookup below to *that* job, instead of
  // whichever one the page's single-detail-view selectors happen to match
  // (typically just the first one in the DOM). Returns null on an actual
  // single-job detail page, where there's no repeated sibling to find.
  function findCardScope(el) {
    let node = el;
    while (node && node.parentElement && node !== document.body) {
      const parent = node.parentElement;
      const hasSibling = Array.from(parent.children).some(
        (sib) => sib !== node && sameCardShape(node, sib),
      );
      if (hasSibling) return node;
      node = parent;
    }
    return null;
  }

  const ACTIVE_INDICATOR_SELECTOR =
    '[aria-selected="true"], [aria-current]:not([aria-current="false"]), ' +
    '[class*="active" i], [class*="selected" i], [class*="current" i], [class*="highlight" i]';

  // Excludes site chrome that legitimately uses the same "active/current"
  // markers for something that isn't a job card — a nav bar's active tab,
  // or pagination's aria-current="page" on the current page number (which
  // often has >=3 sibling page links too, passing the list-shape guard
  // below just as easily as a real job card would).
  function isNavigationChrome(el) {
    return !!el.closest(
      'nav, header, footer, [role="navigation"], [class*="pagination" i], [class*="pager" i], [class*="breadcrumb" i]',
    );
  }

  // Master-detail UIs (list pane + detail pane — common on LinkedIn/Indeed
  // search results) put the Apply button in the detail pane, which has no
  // repeated siblings, so findCardScope() returns null. Fall back to
  // finding whichever repeated list item is marked active/selected. Takes
  // the first non-chrome DOM match rather than ranking every candidate — a
  // narrow heuristic for this one layout pattern, not a general solution.
  function findActiveCardScope() {
    const activeEl = Array.from(
      document.querySelectorAll(ACTIVE_INDICATOR_SELECTOR),
    ).find((el) => !isNavigationChrome(el));
    if (!activeEl) return null;

    // The active marker may sit on the card itself or a child inside it,
    // and its class differs from its siblings *by design* (that's what
    // "active" means) — so match on tag alone, not tag+class like
    // findCardScope(), with a same-tag-sibling-count guard so a two-column
    // layout isn't mistaken for a list.
    let node = activeEl;
    while (node && node.parentElement && node !== document.body) {
      const sameTagSiblingCount = Array.from(
        node.parentElement.children,
      ).filter((sib) => sib.tagName === node.tagName).length;
      if (sameTagSiblingCount >= 3) return node;
      node = node.parentElement;
    }
    return null;
  }

  // Compact, log-safe descriptor for an element — enough to identify it in
  // the console without dumping the whole node (or its subtree).
  function describeEl(el) {
    return { tag: el.tagName, id: el.id || undefined, className: el.className || undefined };
  }

  // findCardScope/findActiveCardScope only make sense when the page
  // actually has multiple job listings to disambiguate between — on a
  // genuine single-job page they're not just unnecessary, they're a false-
  // positive risk: either one can walk up into some *unrelated* repeated
  // structure near the clicked anchor (repeated skill-tag badges, share
  // buttons, breadcrumb items...) and scope to that instead of the real
  // job content. Gated on multipleListingsDetected (set once per click,
  // see the click handler) rather than attempted unconditionally.
  //
  // When skipped, or when both return null anyway (a form on a later
  // application step has no repeated-card structure either) — proximity
  // extraction still needs somewhere bounded to look. Falls back to the
  // nearest landmark ancestor, never the whole document, so later
  // multi-step pages never get a full-page scan.
  function findLocalScope(anchorEl) {
    if (multipleListingsDetected) {
      const cardScope = findCardScope(anchorEl);
      if (cardScope) {
        logStep("scope resolved via findCardScope", describeEl(cardScope));
        return cardScope;
      }

      const activeCardScope = findActiveCardScope();
      if (activeCardScope) {
        logStep("scope resolved via findActiveCardScope", describeEl(activeCardScope));
        return activeCardScope;
      }
    }

    const landmark = anchorEl.closest('form, main, [role="main"], article');
    if (landmark) {
      logStep("scope resolved via landmark ancestor", describeEl(landmark));
      return landmark;
    }

    // No landmark either — walk up a fixed, small number of levels rather
    // than defaulting to the whole page.
    let node = anchorEl;
    for (let i = 0; i < 4 && node.parentElement; i++) node = node.parentElement;
    logStep("scope resolved via fixed walk-up fallback", describeEl(node));
    return node;
  }

  // Scraped fields come straight from arbitrary page markup, so they can
  // carry tabs/newlines, doubled-up spaces, or stray leading/trailing
  // whitespace picked up from the DOM. Collapses all of that down to single
  // spaces, trims the ends, and capitalizes each word's first letter for a
  // consistent display.
  function normalizeScrapedText(value) {
    return (value || "")
      .replace(/\s+/g, " ")
      .trim()
      .split(" ")
      .filter(Boolean)
      .map((word) => word[0].toUpperCase() + word.slice(1))
      .join(" ");
  }

  // The closest-proximity extraction: finds company/title/location from
  // whatever's nearest the clicked anchor (card scope, active list item, or
  // a bounded local landmark), via selector/synonym matching only — no
  // page-wide fallbacks (JSON-LD, meta tags, document.title parsing), so
  // it behaves identically whether this is the very first capture or a
  // later-step refinement.
  function extractNearAnchor(anchorEl) {
    if (!anchorEl) return { jobTitle: "", company: "", location: "" };
    const scope = findLocalScope(anchorEl);
    const snapshot = {
      jobTitle: normalizeScrapedText(findBySynonyms("jobTitle", scope)),
      company: normalizeScrapedText(findBySynonyms("company", scope)),
      location: normalizeScrapedText(findBySynonyms("location", scope)),
    };
    jobInfoSoFar = snapshot; // final normalized values replace the raw per-field progress
    logStep("extraction complete", snapshot);
    return snapshot;
  }

  // "Visible" means actually reachable/on top for the user right now, not
  // just present in the layout — checked via the real stacking order
  // rather than offsetParent/aria-hidden, which are accessibility-tree
  // hints the site has to bother setting. Indeed's Easy Apply modal
  // overlays the background job list without hiding or aria-hiding it, so
  // a layout-only check kept seeing it as "visible" even at the final
  // submit step; a modal's backdrop, on the other hand, sits on top of
  // background content in virtually every real implementation (to block
  // accidental interaction with it) whether or not the site marks that
  // content aria-hidden — see docs/roadmap.md.
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
  // AND a data-testid element) isn't counted twice.
  function countVisibleJobTitles() {
    const { specific, broad } = FIELD_SYNONYMS.jobTitle;
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
      if (text && text.length <= FIELD_MAX_LENGTH.jobTitle) titles.add(text);
    }
    return titles.size;
  }

  // Manually performs whatever native default action event.preventDefault()
  // blocked below, once the capture message is confirmed sent — bypassing
  // the event system entirely (not a re-dispatched click), so nothing the
  // site's own JS click handler already did during this same click (e.g.
  // opening a modal) fires a second time. A plain JS-handled <button>
  // (type="button", no href) has no native default action to resume in
  // the first place, so this is a no-op for the common SPA case.
  function resumeDefaultAction(target, event) {
    if (target.tagName === "A") {
      // Excludes "#"/javascript: hrefs — an extremely common pattern for
      // an anchor styled as a button where a JS click handler (which
      // already ran normally above, since only the default action was
      // blocked) does the real work and the href is just a placeholder.
      // Resuming navigation for those would cause an unwanted scroll-to-
      // top/hash-change the site never intended to actually happen.
      const rawHref = target.getAttribute("href") || "";
      if (!rawHref || rawHref === "#" || rawHref.startsWith("javascript:")) return;

      if (event.ctrlKey || event.metaKey || event.shiftKey || target.target === "_blank") {
        window.open(target.href, "_blank");
      } else {
        window.location.href = target.href;
      }
      return;
    }

    const form = target.form;
    if (form && target.type === "submit") {
      if (form.requestSubmit) form.requestSubmit(target);
      else form.submit();
    }
  }

  document.addEventListener(
    "click",
    (event) => {
      const target = event.target.closest("button, a, input[type='submit']");
      if (!target) return;
      if (!isTrigger(target)) return;

      // Blocks this click's native default action (link navigation / form
      // submission) just long enough to guarantee the LIBER_FLOW_STEP
      // message below actually reaches background.js before anything
      // navigates away and tears down this content script's execution
      // context mid-send — then resumeDefaultAction() manually resumes
      // whatever was blocked once that's confirmed, so the real apply
      // flow still proceeds normally afterward.
      event.preventDefault();

      // Reset per-click context before anything else logs or extracts —
      // see the declarations above for why these are closure state rather
      // than threaded parameters.
      jobInfoSoFar = { jobTitle: "", company: "", location: "" };
      const visibleJobTitleCount = countVisibleJobTitles();
      multipleListingsDetected = visibleJobTitleCount > 1;

      // Might be starting a brand-new application, continuing one already
      // started (Next/Continue/Review), or completely unrelated to any job
      // flow (e.g. a checkout form's "Continue") — always reports what's
      // nearby; background.js is the one that knows which case this is
      // (via this tab's actual flow state) and decides what to do with it.
      logStep("trigger clicked", { text: getClickableText(target) });

      new Audio(browser.runtime.getURL("src/assets/notif.mp3"))
        .play()
        .catch(() => {});

      logStep("listing check", { visibleJobTitleCount, multipleListingsDetected });

      // Multiple listings no longer defers capture — findLocalScope uses
      // multipleListingsDetected itself to scope to the specific card
      // clicked (findCardScope/findActiveCardScope), so extracting now
      // from that card is more reliable than waiting on a maybe-still-
      // rendering modal.
      logStep(
        multipleListingsDetected
          ? "multiple listings detected, extracting via card scope"
          : "single listing detected, extracting job snapshot",
      );
      const snapshot = extractNearAnchor(target);
      logStep("sending LIBER_FLOW_STEP", snapshot);

      browser.runtime
        .sendMessage({ type: "LIBER_FLOW_STEP", url: location.href, snapshot })
        .catch(() => {})
        .finally(() => resumeDefaultAction(target, event));
    },
    true, // capture phase — catches it even if the site stops propagation
  );
})();
