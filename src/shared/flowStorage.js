// Ephemeral per-tab apply-flow state — parallels storage.js's wrapping of
// storage.local, but backed by storage.session since a flow (unlike a
// saved job) shouldn't survive the browser restarting. One storage key per
// tabId (not one shared object) so two tabs' flows can never race on the
// same read-modify-write.

const FLOW_TTL_MS = 30 * 60 * 1000; // abandon a flow nobody touched in 30 min

function flowKey(tabId) {
  return `liber_flow_${tabId}`;
}

export async function getFlow(tabId) {
  const key = flowKey(tabId);
  const flow = (await browser.storage.session.get(key))[key];
  if (!flow) return null;

  if (Date.now() - flow.lastUpdatedAt > FLOW_TTL_MS) {
    await clearFlow(tabId);
    return null;
  }

  return flow;
}

export async function setFlow(tabId, flow) {
  await browser.storage.session.set({
    [flowKey(tabId)]: { ...flow, lastUpdatedAt: Date.now() },
  });
}

export async function clearFlow(tabId) {
  await browser.storage.session.remove(flowKey(tabId));
}

// A literal snapshot copy under a new tabId's key, not a live shared
// reference — consistent with the one-key-per-tabId design, so two tabs'
// flows still can't race on the same storage key after this. Used by
// background.js's tabs.onUpdated listener to carry a flow into a brand-new
// tab opened mid-application (e.g. an ATS redirect to a separate domain).
export async function copyFlow(fromTabId, toTabId) {
  const flow = await getFlow(fromTabId);
  if (!flow) return null;
  await setFlow(toTabId, { ...flow });
  return getFlow(toTabId);
}
