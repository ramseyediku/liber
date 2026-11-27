// Turning Cloud Sync on, in one place for the dashboard popover and Settings:
// check whether this device and the cloud disagree, ask which version wins if
// they do, then switch sync on and upload what was saved while it was off.
import { askSyncConflict } from "./syncPrompt.ts";
import {
  adoptAccountJobProfile,
  applySyncChoice,
  findSyncConflicts,
  flushPendingUpdates,
} from "./storage.ts";
import { setSyncEnabled } from "./sync.ts";

// Returns false if sync was not turned on (not logged in, or the user cancelled
// the conflict prompt) so the caller can put its switch back.
export async function turnOnSync(): Promise<boolean> {
  const conflicts = await findSyncConflicts().catch(() => []);
  let choice: "device" | "cloud" | null = null;
  if (conflicts.length) {
    choice = await askSyncConflict(conflicts.length);
    if (!choice) return false;
  }

  if (!(await setSyncEnabled(true))) return false;
  if (choice) await applySyncChoice(choice, conflicts);
  await flushPendingUpdates({ force: true }).catch(() => {});
  await adoptAccountJobProfile().catch(() => {});
  return true;
}
