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

  function scrapeJobDetails() {
    const platformKey = getPlatformKey();
    const selectors =
      PLATFORM_SELECTORS[platformKey] || PLATFORM_SELECTORS.default;

    return {
      url: window.location.href,
      platform:
        platformKey === "default" ? window.location.hostname : platformKey,
      jobTitle: queryFirstText(selectors.jobTitle) || document.title,
      company: queryFirstText(selectors.company) || "",
      location: queryFirstText(selectors.location) || "",
      jobDescription: (
        document.querySelector('[class*="description"]')?.textContent || ""
      )
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
