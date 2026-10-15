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
