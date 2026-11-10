// Plain script (not a module) — seeds --theme-icon before first paint.
// Color/icon switch is pure CSS, driven by --theme-icon (see _base.css).
(function () {
  const STORAGE_KEY = "liber_theme";
  const ICON = { light: '"☀️"', dark: '"🌙"' };

  type Theme = "light" | "dark";

  function currentTheme(): Theme {
    const icon = getComputedStyle(document.documentElement)
      .getPropertyValue("--theme-icon")
      .trim();
    return icon === ICON.dark ? "dark" : "light";
  }

  function applyTheme(theme: Theme): void {
    document.documentElement.style.setProperty("--theme-icon", ICON[theme]);
    localStorage.setItem(STORAGE_KEY, theme);
  }

  const stored = localStorage.getItem(STORAGE_KEY);
  const initial: Theme =
    stored === "dark" || stored === "light"
      ? stored
      : matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";
  document.documentElement.style.setProperty("--theme-icon", ICON[initial]);

  window.LiberTheme = {
    // Icon swap handled by _base.css's style query; this syncs the a11y label.
    initToggle(button: HTMLElement | null) {
      if (!button) return;
      const sync = () => {
        button.setAttribute(
          "aria-label",
          currentTheme() === "dark" ? "Switch to light mode" : "Switch to dark mode",
        );
      };

      button.addEventListener("click", () => {
        applyTheme(currentTheme() === "dark" ? "light" : "dark");
        sync();
      });

      sync();
    },
  };
})();
