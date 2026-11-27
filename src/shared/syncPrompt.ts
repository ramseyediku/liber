// The "which version should win?" dialog shown when Cloud Sync is turned on and
// this device and the cloud hold different versions of the same applications.
// Built with the DOM so the dashboard popover and the Settings page can both
// use it (styles: .sync-dialog in dashboard-shared.css).
export type SyncChoice = "device" | "cloud";

export function askSyncConflict(count: number): Promise<SyncChoice | null> {
  return new Promise((resolve) => {
    const dialog = document.createElement("dialog");
    dialog.className = "sync-dialog";
    dialog.setAttribute("aria-labelledby", "sync-dialog-title");

    const title = document.createElement("h2");
    title.id = "sync-dialog-title";
    title.textContent = "Which version should win?";

    const text = document.createElement("p");
    text.textContent =
      count === 1
        ? "1 application is different on this device and in the cloud. Applications that exist in only one place are always kept."
        : `${count} applications are different on this device and in the cloud. Applications that exist in only one place are always kept.`;

    const actions = document.createElement("div");
    actions.className = "sync-dialog__actions";

    const finish = (choice: SyncChoice | null) => {
      dialog.close();
      dialog.remove();
      resolve(choice);
    };
    const button = (label: string, className: string, choice: SyncChoice | null) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = className;
      b.textContent = label;
      b.addEventListener("click", () => finish(choice));
      return b;
    };

    actions.append(
      button("Keep this device's version", "sync-dialog__primary", "device"),
      button("Keep the cloud version", "sync-dialog__secondary", "cloud"),
      button("Cancel", "sync-dialog__cancel", null),
    );
    dialog.append(title, text, actions);
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      finish(null);
    });

    document.body.appendChild(dialog);
    dialog.showModal();
  });
}
