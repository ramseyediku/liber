/**
 * job-crawler-background.js  -  STEP 1b: automated collection
 *
 * Background service worker. Opens job board pages in a hidden tab, asks the
 * content script to harvest every job card it can find, saves the samples,
 * then moves on. No manual clicking.
 *
 * IMPORTANT: this file is TRAINING-TIME ONLY. It contains site-specific URLs,
 * which is exactly the per-site knowledge we refuse to put in the shipped
 * extractor. That is fine here because this code never ships to users and is
 * throwaway - if a board changes its URL format, you fix one line. Keep the
 * line clean: site knowledge lives here, never in the feature extractor.
 *
 * Usage from the service worker console:
 *   jobCrawler.dryRun()        see what it would visit, harvest nothing
 *   jobCrawler.start()         run with defaults
 *   jobCrawler.start({ sites: ['lever', 'greenhouse'], pagesPerSite: 3 })
 *   jobCrawler.stop()          kill switch
 *   jobCrawler.status()        progress of the current run
 *   jobCrawler.openViewer()    open the training-data table in a new tab
 */

// ---------------------------------------------------------------------------
// Site list
// ---------------------------------------------------------------------------
//
// Chosen for DIVERSITY, not volume. Five sites x 100 samples generalizes far
// better than one site x 500, because the model must learn job-page
// conventions rather than one board's house style.
//
// The ATS platforms (Greenhouse, Lever, Workable, Ashby) matter most: when
// someone applies "on the company's own website" they are usually on one of
// these with the company's CSS layered on top. Training on them is what makes
// bespoke company pages work.
//
// LinkedIn is deliberately absent. They are aggressive about automated access
// and it is your real job-hunting account at risk. Collect those by hand.

const SITES = {
  reed: {
    name: 'Reed',
    pages: (q) => [
      `https://www.reed.co.uk/jobs/${q}-jobs`,
      `https://www.reed.co.uk/jobs/${q}-jobs?pageno=2`,
      `https://www.reed.co.uk/jobs/${q}-jobs?pageno=3`,
    ],
    queries: ['software-developer', 'data-analyst', 'project-manager'],
  },

  greenhouse: {
    name: 'Greenhouse',
    // Public boards. Add or swap companies freely.
    pages: () => [
      'https://boards.greenhouse.io/figma',
      'https://boards.greenhouse.io/duolingo',
      'https://boards.greenhouse.io/discord',
      'https://boards.greenhouse.io/airtable',
    ],
    queries: [null],
  },

  lever: {
    name: 'Lever',
    pages: () => [
      'https://jobs.lever.co/voiceflow',
      'https://jobs.lever.co/attentive',
      'https://jobs.lever.co/matchgroup',
    ],
    queries: [null],
  },

  workable: {
    name: 'Workable',
    pages: () => [
      'https://apply.workable.com/sandbox-vr/',
      'https://apply.workable.com/omio/',
    ],
    queries: [null],
  },

  ashby: {
    name: 'Ashby',
    pages: () => [
      'https://jobs.ashbyhq.com/openai',
      'https://jobs.ashbyhq.com/ramp',
    ],
    queries: [null],
  },

  weworkremotely: {
    name: 'WeWorkRemotely',
    pages: () => [
      'https://weworkremotely.com/categories/remote-programming-jobs',
      'https://weworkremotely.com/categories/remote-design-jobs',
    ],
    queries: [null],
  },

  // Hostile to scraping. Low volume only, and expect the occasional block.
  indeed: {
    name: 'Indeed',
    pages: (q) => [`https://uk.indeed.com/jobs?q=${q}`],
    queries: ['software+developer', 'data+analyst'],
    lowVolume: true,
  },
};

const DEFAULTS = {
  sites: ['reed', 'greenhouse', 'lever', 'workable', 'ashby', 'weworkremotely'],
  pagesPerSite: 5,
  minDelayMs: 3000,
  maxDelayMs: 8000,
  loadSettleMs: 2500,   // let client-rendered boards finish painting
  maxTotalPages: 40,    // hard stop, whatever the config says
};

// ---------------------------------------------------------------------------
// Run state
// ---------------------------------------------------------------------------

let run = null;

function freshRun(opts) {
  return {
    opts: opts,
    queue: [],
    visited: new Set(),
    done: 0,
    samples: 0,
    nodes: 0,
    perSite: {},
    errors: [],
    stopped: false,
    startedAt: Date.now(),
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function jitter(min, max) {
  return min + Math.random() * (max - min);
}

/** Build the visit queue from the site config. */
function buildQueue(opts) {
  const queue = [];
  for (const key of opts.sites) {
    const site = SITES[key];
    if (!site) {
      console.warn(`[jobCrawler] unknown site "${key}"`);
      continue;
    }
    const cap = site.lowVolume
      ? Math.min(2, opts.pagesPerSite)
      : opts.pagesPerSite;

    const urls = [];
    for (const q of site.queries) {
      for (const url of site.pages(q)) {
        if (urls.length >= cap) break;
        urls.push(url);
      }
      if (urls.length >= cap) break;
    }
    for (const url of urls) queue.push({ site: key, name: site.name, url });
  }
  return queue.slice(0, opts.maxTotalPages);
}

// ---------------------------------------------------------------------------
// Tab handling
// ---------------------------------------------------------------------------

function waitForLoad(tabId, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('load timeout'));
    }, timeoutMs);

    function listener(id, info) {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

function askContentScript(tabId, message, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('harvest timeout')), timeoutMs);
    chrome.tabs.sendMessage(tabId, message, (reply) => {
      clearTimeout(timer);
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(reply);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

function getSet() {
  return new Promise((resolve) => {
    chrome.storage.local.get('trainingSet', (r) => resolve(r.trainingSet || []));
  });
}

function putSet(set) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ trainingSet: set }, resolve);
  });
}

/** Append samples, skipping any whose URL+text signature we already hold. */
async function saveSamples(samples) {
  const set = await getSet();
  const seen = new Set(
    set.map((s) => s.url + '|' + (s.candidates[0] && s.candidates[0].text))
  );

  let added = 0;
  for (const s of samples) {
    const sig = s.url + '|' + (s.candidates[0] && s.candidates[0].text);
    if (seen.has(sig)) continue;
    seen.add(sig);
    set.push(s);
    added++;
  }
  await putSet(set);
  return added;
}

// ---------------------------------------------------------------------------
// The crawl
// ---------------------------------------------------------------------------

async function visit(item, tabId) {
  await chrome.tabs.update(tabId, { url: item.url });
  await waitForLoad(tabId);
  await sleep(run.opts.loadSettleMs);

  const reply = await askContentScript(tabId, { type: 'HARVEST_CARDS' });

  if (!reply || !reply.ok) {
    throw new Error((reply && reply.error) || 'no reply from content script');
  }
  return reply.samples || [];
}

async function crawl(opts) {
  run = freshRun(opts);
  run.queue = buildQueue(opts);

  console.log(`[jobCrawler] ${run.queue.length} pages queued`);

  // One reusable tab, opened inactive so it never steals focus.
  const tab = await chrome.tabs.create({ url: 'about:blank', active: false });

  try {
    for (const item of run.queue) {
      if (run.stopped) {
        console.log('[jobCrawler] stopped');
        break;
      }
      if (run.visited.has(item.url)) continue;
      run.visited.add(item.url);

      try {
        const samples = await visit(item, tab.id);
        const added = await saveSamples(samples);
        const nodes = samples.reduce((n, s) => n + s.candidates.length, 0);

        run.samples += added;
        run.nodes += nodes;
        run.perSite[item.site] = (run.perSite[item.site] || 0) + added;

        console.log(
          `[jobCrawler] ${item.name}: +${added} samples (${nodes} nodes) - ${item.url}`
        );
      } catch (err) {
        run.errors.push({ url: item.url, error: String(err.message || err) });
        console.warn(`[jobCrawler] ${item.name} failed: ${err.message}`);
      }

      run.done++;
      await sleep(jitter(opts.minDelayMs, opts.maxDelayMs));
    }
  } finally {
    chrome.tabs.remove(tab.id).catch(() => {});
  }

  const secs = Math.round((Date.now() - run.startedAt) / 1000);
  console.log(
    `[jobCrawler] finished: ${run.samples} samples, ${run.nodes} nodes, ${run.errors.length} errors, ${secs}s`
  );
  console.table(run.perSite);
  if (run.errors.length) console.table(run.errors);

  return {
    samples: run.samples,
    nodes: run.nodes,
    perSite: run.perSite,
    errors: run.errors,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const jobCrawler = {
  SITES: SITES,

  /** List what a run would visit, without opening anything. */
  dryRun(opts) {
    const merged = Object.assign({}, DEFAULTS, opts);
    const queue = buildQueue(merged);
    console.log(`[jobCrawler] dry run - ${queue.length} pages`);
    console.table(queue);
    return queue;
  },

  /** Start a crawl. Returns a summary when finished. */
  async start(opts) {
    if (run && !run.stopped && run.done < run.queue.length) {
      console.warn('[jobCrawler] already running - stop() first');
      return;
    }
    const merged = Object.assign({}, DEFAULTS, opts);
    return crawl(merged);
  },

  /** Kill switch. Finishes the current page, then stops. */
  stop() {
    if (run) run.stopped = true;
    console.log('[jobCrawler] stopping after current page');
  },

  /** Progress of the current or last run. */
  status() {
    if (!run) return console.log('[jobCrawler] no run yet');
    console.log(
      `${run.done}/${run.queue.length} pages, ${run.samples} samples, ${run.nodes} nodes`
    );
    console.table(run.perSite);
    return run;
  },

  /** Totals in storage, across every run and manual collection. */
  async count() {
    const set = await getSet();
    const byHost = {};
    let nodes = 0;
    for (const s of set) {
      byHost[s.host] = (byHost[s.host] || 0) + 1;
      nodes += s.candidates.length;
    }
    console.log(`${set.length} samples, ${nodes} candidate nodes`);
    console.table(byHost);
    return { samples: set.length, nodes: nodes, byHost: byHost };
  },

  /** Download everything as JSON, ready for step 2. */
  async export() {
    const set = await getSet();
    const json = JSON.stringify(set, null, 2);
    const url = 'data:application/json;base64,' + btoa(unescape(encodeURIComponent(json)));
    await chrome.downloads.download({
      url: url,
      filename: `job-training-set-${Date.now()}.json`,
      saveAs: true,
    });
    console.log(`[jobCrawler] exported ${set.length} samples`);
    return set.length;
  },

  async clear() {
    await putSet([]);
    console.log('[jobCrawler] cleared');
  },

  /** Open the training-data table in a new tab. */
  openViewer() {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/crawler/training-data.html') });
  },
};

// Expose for the service worker console.
self.jobCrawler = jobCrawler;

console.log('[jobCrawler] ready - try jobCrawler.dryRun()');
