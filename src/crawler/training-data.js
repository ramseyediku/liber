// Read-only viewer for the `trainingSet` collected by jobCrawler
// (job-crawler-background.js). Opened via jobCrawler.openViewer() or by
// navigating here directly; reads storage itself, no messaging needed.

const PAGE_SIZE = 25;

let allSamples = [];
let filtered = [];
let currentPage = 1;
let expandedKey = null;

const statSamples = document.getElementById("stat-samples");
const statNodes = document.getElementById("stat-nodes");
const statSites = document.getElementById("stat-sites");
const searchInput = document.getElementById("search");
const tbody = document.getElementById("tbody");
const pagination = document.getElementById("pagination");
const pagePrev = document.getElementById("page-prev");
const pageNext = document.getElementById("page-next");
const pageLabel = document.getElementById("page-label");

function hostOf(sample) {
  if (sample.host) return sample.host;
  try {
    return new URL(sample.url).hostname;
  } catch {
    return "";
  }
}

function safeHref(url) {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : "#";
  } catch {
    return "#";
  }
}

function truncate(str, len) {
  if (!str) return "";
  return str.length > len ? str.slice(0, len - 1) + "…" : str;
}

async function loadSamples() {
  const { trainingSet } = await browser.storage.local.get("trainingSet");
  allSamples = trainingSet || [];
  applyFilter();
}

function applyFilter() {
  const q = searchInput.value.trim().toLowerCase();
  filtered = !q
    ? allSamples
    : allSamples.filter((s) => {
        const host = hostOf(s).toLowerCase();
        const url = (s.url || "").toLowerCase();
        const text = (s.candidates || [])
          .map((c) => c.text || "")
          .join(" ")
          .toLowerCase();
        return host.includes(q) || url.includes(q) || text.includes(q);
      });
  currentPage = 1;
  render();
}

function renderStats() {
  const nodes = allSamples.reduce(
    (n, s) => n + (s.candidates ? s.candidates.length : 0),
    0,
  );
  const sites = new Set(allSamples.map(hostOf).filter(Boolean)).size;
  statSamples.textContent = allSamples.length;
  statNodes.textContent = nodes;
  statSites.textContent = sites;
}

function cell(text, { className = "dashboard__cell-content" } = {}) {
  const td = document.createElement("td");
  const span = document.createElement("span");
  span.className = className;
  span.textContent = text;
  if (text) span.title = text;
  td.appendChild(span);
  return td;
}

function buildEmptyRow(message) {
  const tr = document.createElement("tr");
  const td = document.createElement("td");
  td.className = "dashboard__empty";
  td.colSpan = 5;
  td.textContent = message;
  tr.appendChild(td);
  return tr;
}

function buildDetailRow(sample, colSpan) {
  const tr = document.createElement("tr");
  tr.className = "crawler__detail-row";
  const td = document.createElement("td");
  td.colSpan = colSpan;

  const candidates = sample.candidates || [];
  if (!candidates.length) {
    const p = document.createElement("p");
    p.className = "crawler__detail-empty";
    p.textContent = "No candidate nodes recorded for this sample.";
    td.appendChild(p);
  } else {
    const ol = document.createElement("ol");
    ol.className = "crawler__detail-list";
    for (const c of candidates) {
      const li = document.createElement("li");
      li.textContent = c.text || "(empty)";
      ol.appendChild(li);
    }
    td.appendChild(ol);
  }

  tr.appendChild(td);
  return tr;
}

function sampleKey(sample, index) {
  return `${sample.url || ""}|${index}`;
}

function render() {
  renderStats();
  tbody.innerHTML = "";

  if (!filtered.length) {
    tbody.appendChild(
      buildEmptyRow(
        allSamples.length
          ? "No samples match your search."
          : "No training data yet — run jobCrawler.start() from the background service worker console.",
      ),
    );
    renderPagination(0);
    return;
  }

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  currentPage = Math.min(currentPage, totalPages);
  const start = (currentPage - 1) * PAGE_SIZE;
  const pageItems = filtered.slice(start, start + PAGE_SIZE);

  pageItems.forEach((sample, i) => {
    const globalIndex = start + i;
    const key = sampleKey(sample, globalIndex);
    const candidates = sample.candidates || [];

    const row = document.createElement("tr");
    const indexTd = document.createElement("td");
    indexTd.textContent = globalIndex + 1;
    row.appendChild(indexTd);
    row.appendChild(cell(hostOf(sample)));

    const urlTd = document.createElement("td");
    const link = document.createElement("a");
    link.className = "crawler__url";
    link.href = safeHref(sample.url);
    link.target = "_blank";
    link.rel = "noopener";
    link.title = sample.url || "";
    link.textContent = truncate(sample.url || "", 60);
    urlTd.appendChild(link);
    row.appendChild(urlTd);

    const countTd = document.createElement("td");
    countTd.textContent = candidates.length;
    row.appendChild(countTd);

    row.appendChild(cell(truncate(candidates[0]?.text || "", 70)));

    row.addEventListener("click", (e) => {
      if (e.target.closest("a")) return;
      expandedKey = expandedKey === key ? null : key;
      render();
    });
    tbody.appendChild(row);

    if (expandedKey === key) {
      tbody.appendChild(buildDetailRow(sample, row.children.length));
    }
  });

  renderPagination(totalPages);
}

function renderPagination(totalPages) {
  if (totalPages <= 1) {
    pagination.style.display = "none";
    return;
  }
  pagination.style.display = "";
  pagePrev.disabled = currentPage === 1;
  pageNext.disabled = currentPage === totalPages;
  pageLabel.textContent = `Page ${currentPage} of ${totalPages}`;
}

searchInput.addEventListener("input", applyFilter);

pagePrev.addEventListener("click", () => {
  if (currentPage > 1) {
    currentPage--;
    render();
  }
});

pageNext.addEventListener("click", () => {
  currentPage++;
  render();
});

document.getElementById("refresh").addEventListener("click", loadSamples);

document.getElementById("export").addEventListener("click", () => {
  const json = JSON.stringify(allSamples, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `job-training-set-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

document.getElementById("clear").addEventListener("click", async () => {
  if (
    !confirm(`Delete all ${allSamples.length} training samples? This can't be undone.`)
  ) {
    return;
  }
  await browser.storage.local.set({ trainingSet: [] });
  await loadSamples();
});

browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.trainingSet) loadSamples();
});

window.LiberTheme?.initToggle(document.getElementById("theme-toggle"));

loadSamples();
