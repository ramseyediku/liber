// Watches every page for "Apply"/"Submit" clicks, scrapes job details from
// the DOM, and asks the background script to prompt the user to save it.
// v1 heuristic scraper — extend PLATFORM_SELECTORS for more sites.

(function () {
  const APPLY_KEYWORDS = [
    "apply",
    "submit application",
    "submit",
    "easy apply",
    "send application",
  ];

  const PLATFORM_SELECTORS = {
    "linkedin.com": {
      jobTitle:
        "h1.top-card-layout__title, h1.job-details-jobs-unified-top-card__job-title",
      company:
        ".top-card-layout__second-subtitle, .job-details-jobs-unified-top-card__company-name",
      location:
        ".top-card-layout__second-subtitle .job-search-card__location, .job-details-jobs-unified-top-card__bullet",
    },
    "indeed.com": {
      jobTitle: "h1.jobsearch-JobInfoHeader-title",
      company: '[data-testid="inlineHeader-companyName"]',
      location: '[data-testid="inlineHeader-companyLocation"]',
    },
    default: {
      jobTitle: "h1",
      company: '[class*="company"], [class*="employer"]',
      location: '[class*="location"]',
    },
  };

  function getPlatformKey() {
    const host = window.location.hostname.replace("www.", "");
    const match = Object.keys(PLATFORM_SELECTORS).find((key) =>
      host.includes(key),
    );
    return match || "default";
  }

  function queryFirstText(selectorList, root = document) {
    for (const selector of selectorList.split(",")) {
      const el = root.querySelector(selector.trim());
      if (el && el.textContent.trim()) return el.textContent.trim();
    }
    return "";
  }

  // On a search-results page, "Apply" sits inside one of many repeated job
  // cards — walking up to the nearest ancestor that has siblings sharing its
  // tag and class scopes every lookup below to *that* job, instead of
  // whichever one the page's single-detail-view selectors happen to match
  // (typically just the first one in the DOM). Returns null on an actual
  // single-job detail page, where there's no repeated sibling to find and
  // the existing document-wide lookups already work.
  function findCardScope(el) {
    let node = el;
    while (node && node.parentElement && node !== document.body) {
      const parent = node.parentElement;
      const hasSibling =
        node.className &&
        Array.from(parent.children).some(
          (sib) =>
            sib !== node &&
            sib.tagName === node.tagName &&
            sib.className === node.className,
        );
      if (hasSibling) return node;
      node = parent;
    }
    return null;
  }

  function getMetaContent(name) {
    const el = document.querySelector(
      `meta[property="${name}"], meta[name="${name}"]`,
    );
    return el?.content?.trim() || "";
  }

  // Most ATS platforms embed schema.org JobPosting data for SEO — more
  // reliable than guessing CSS classes, so it's tried before the generic fallback.
  function getJobPostingLd() {
    const scripts = document.querySelectorAll(
      'script[type="application/ld+json"]',
    );

    const postings = [];
    for (const script of scripts) {
      let parsed;
      try {
        parsed = JSON.parse(script.textContent);
      } catch {
        continue;
      }

      const candidates = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed?.["@graph"])
          ? parsed["@graph"]
          : [parsed];

      for (const candidate of candidates) {
        const type = candidate?.["@type"];
        const isJobPosting = Array.isArray(type)
          ? type.includes("JobPosting")
          : type === "JobPosting";
        if (isJobPosting) postings.push(candidate);
      }
    }

    return postings[0] || null;
  }

  function orgName(hiringOrganization) {
    if (!hiringOrganization) return "";
    if (typeof hiringOrganization === "string") return hiringOrganization;
    return hiringOrganization.name || "";
  }

  function locationFromLd(jobLocation) {
    const place = Array.isArray(jobLocation) ? jobLocation[0] : jobLocation;
    const address = place?.address;
    if (!address) return "";
    if (typeof address === "string") return address;
    return [address.addressLocality, address.addressRegion, address.addressCountry]
      .filter(Boolean)
      .join(", ");
  }

  // <title> is usually "Job Title - Company" or "Job Title | Site" — take
  // just the first segment.
  function cleanDocumentTitle() {
    return document.title.split(/\s+[|\-–—]\s+/)[0].trim();
  }

  // Last-resort company guess: the non-title segment of <title>, e.g.
  // "Job Title - Company" or "Company hiring Job Title".
  function companyFromDocumentTitle() {
    const segments = document.title
      .split(/\s+[|\-–—]\s+/)
      .map((s) => s.trim())
      .filter(Boolean);
    return segments.length > 1 ? segments[1] : "";
  }

  function titleCaseSlug(slug) {
    return slug
      .replace(/[-_]+/g, " ")
      .split(" ")
      .filter(Boolean)
      .map((word) => word[0].toUpperCase() + word.slice(1))
      .join(" ");
  }

  // Many ATS platforms embed the company as a URL path segment or
  // subdomain — a strong signal when nothing else on the page names it.
  function companyFromUrl() {
    const host = window.location.hostname.replace("www.", "");
    const path = window.location.pathname;

    const subdomainHosts = ["myworkdayjobs.com", "bamboohr.com"];
    for (const suffix of subdomainHosts) {
      if (host.endsWith(suffix)) {
        const slug = host.slice(0, host.length - suffix.length - 1).split(".")[0];
        if (slug && slug !== "www") return titleCaseSlug(slug);
      }
    }

    const pathHosts = [
      "jobs.lever.co",
      "boards.greenhouse.io",
      "job-boards.greenhouse.io",
      "jobs.smartrecruiters.com",
      "jobs.ashbyhq.com",
    ];
    if (pathHosts.includes(host)) {
      const slug = path.split("/").filter(Boolean)[0];
      if (slug) return titleCaseSlug(slug);
    }

    return "";
  }

  // Broader than getJobPostingLd(): looks for a standalone Organization
  // block anywhere in the page's structured data, not just a JobPosting's
  // hiringOrganization.
  function getOrganizationLd() {
    const scripts = document.querySelectorAll(
      'script[type="application/ld+json"]',
    );

    for (const script of scripts) {
      let parsed;
      try {
        parsed = JSON.parse(script.textContent);
      } catch {
        continue;
      }

      const candidates = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed?.["@graph"])
          ? parsed["@graph"]
          : [parsed];

      for (const candidate of candidates) {
        const type = candidate?.["@type"];
        const isOrganization = Array.isArray(type)
          ? type.includes("Organization")
          : type === "Organization";
        if (isOrganization && candidate.name) return candidate.name;
      }
    }

    return "";
  }

  function scrapeJobDetails(clickedEl) {
    const platformKey = getPlatformKey();
    // Structured data and meta tags beat the crude `default` guesses, so
    // those are tried last.
    const specific = PLATFORM_SELECTORS[platformKey];
    const generic = PLATFORM_SELECTORS.default;
    const jobPosting = getJobPostingLd();
    const cardScope = clickedEl && findCardScope(clickedEl);

    // Card-scoped lookups (the job the user actually clicked) always win
    // over page-wide signals, which on a listing page describe whichever
    // job the page considers "current" — not necessarily the clicked one.
    const jobTitle =
      (cardScope && specific && queryFirstText(specific.jobTitle, cardScope)) ||
      (cardScope && queryFirstText(generic.jobTitle, cardScope)) ||
      (specific && queryFirstText(specific.jobTitle)) ||
      jobPosting?.title ||
      getMetaContent("og:title") ||
      queryFirstText(generic.jobTitle) ||
      cleanDocumentTitle();

    const company =
      (cardScope && specific && queryFirstText(specific.company, cardScope)) ||
      (cardScope && queryFirstText(generic.company, cardScope)) ||
      (specific && queryFirstText(specific.company)) ||
      orgName(jobPosting?.hiringOrganization) ||
      getMetaContent("og:site_name") ||
      queryFirstText(generic.company) ||
      companyFromUrl() ||
      getOrganizationLd() ||
      companyFromDocumentTitle() ||
      "";

    const location =
      (cardScope && specific && queryFirstText(specific.location, cardScope)) ||
      (cardScope && queryFirstText(generic.location, cardScope)) ||
      (specific && queryFirstText(specific.location)) ||
      locationFromLd(jobPosting?.jobLocation) ||
      queryFirstText(generic.location) ||
      "";

    return {
      url: window.location.href,
      jobTitle,
      company,
      location,
      jobDescription: (
        cardScope?.querySelector('[class*="description"]')?.textContent ||
        jobPosting?.description ||
        document.querySelector('[class*="description"]')?.textContent ||
        ""
      )
        .replace(/<[^>]+>/g, " ")
        .trim()
        .slice(0, 2000),
    };
  }

  function isApplyTrigger(el) {
    if (!el) return false;
    const text = (
      el.innerText ||
      el.value ||
      el.getAttribute("aria-label") ||
      ""
    )
      .toLowerCase()
      .trim();
    if (!text) return false;
    return APPLY_KEYWORDS.some((kw) => text.includes(kw));
  }

  document.addEventListener(
    "click",
    (event) => {
      const target = event.target.closest("button, a, input[type='submit']");
      if (!target || !isApplyTrigger(target)) return;

      // Plays on the click itself rather than the notification — see
      // roadmap.md for why.
      new Audio(browser.runtime.getURL("src/assets/notif.mp3"))
        .play()
        .catch(() => {});

      const details = scrapeJobDetails(target);
      browser.runtime.sendMessage({
        type: "JOB_APPLY_DETECTED",
        payload: details,
      });
    },
    true, // capture phase — catches it even if the site stops propagation
  );
})();
