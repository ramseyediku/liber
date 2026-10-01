// src/content/content.js
// Runs inside every page. Watches for "Apply" / "Submit" clicks on job platforms
// and scrapes best-guess job details from the DOM, then asks the background
// script to prompt the user to save it.
//
// NOTE: This is a v1 heuristic scraper. Platform-specific selectors (LinkedIn,
// Indeed, Greenhouse, Lever, etc.) should be added incrementally — see the
// PLATFORM_SELECTORS map below for where to extend this.

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
    // Add more platforms here as you extend Liber.
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

  function queryFirstText(selectorList) {
    for (const selector of selectorList.split(",")) {
      const el = document.querySelector(selector.trim());
      if (el && el.textContent.trim()) return el.textContent.trim();
    }
    return "";
  }

  function getMetaContent(name) {
    const el = document.querySelector(
      `meta[property="${name}"], meta[name="${name}"]`,
    );
    return el?.content?.trim() || "";
  }

  // Most ATS platforms (Greenhouse, Lever, Workday, company career pages,
  // etc.) embed schema.org JobPosting structured data for SEO. It's far more
  // reliable than guessing at CSS classes, so it's the primary source for any
  // site without hand-tuned PLATFORM_SELECTORS.
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

  // Job board/ATS <title> tags are usually "Job Title - Company" or
  // "Job Title | Site Name"; take the first segment rather than the raw tab
  // title so we don't save the whole "job advert link" text as the title.
  function cleanDocumentTitle() {
    return document.title.split(/\s+[|\-–—]\s+/)[0].trim();
  }

  function scrapeJobDetails() {
    const platformKey = getPlatformKey();
    // Only trust the hand-tuned selectors for platforms we actually have
    // selectors for. For everything else, structured data and meta tags are
    // more reliable than the crude `default` class-name guesses, so those
    // guesses are tried last rather than first.
    const specific = PLATFORM_SELECTORS[platformKey];
    const generic = PLATFORM_SELECTORS.default;
    const jobPosting = getJobPostingLd();

    const jobTitle =
      (specific && queryFirstText(specific.jobTitle)) ||
      jobPosting?.title ||
      getMetaContent("og:title") ||
      queryFirstText(generic.jobTitle) ||
      cleanDocumentTitle();

    const company =
      (specific && queryFirstText(specific.company)) ||
      orgName(jobPosting?.hiringOrganization) ||
      getMetaContent("og:site_name") ||
      queryFirstText(generic.company) ||
      "";

    const location =
      (specific && queryFirstText(specific.location)) ||
      locationFromLd(jobPosting?.jobLocation) ||
      queryFirstText(generic.location) ||
      "";

    return {
      url: window.location.href,
      platform:
        platformKey === "default" ? window.location.hostname : platformKey,
      jobTitle,
      company,
      location,
      jobDescription: (
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

      const details = scrapeJobDetails();
      browser.runtime.sendMessage({
        type: "JOB_APPLY_DETECTED",
        payload: details,
      });
    },
    true, // capture phase, so we catch it even if the site stops propagation later
  );
})();
