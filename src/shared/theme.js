// Plain script (not a module) loaded blocking in <head>, so it seeds
// --theme-icon before first paint — a module script would run too late,
// and an inline one is blocked by the extension pages' CSP. The actual
// color/icon switch is pure CSS, driven by --theme-icon (see _base.css).
// Entry points grab the toggle wiring off window.LiberTheme instead of
// importing it, since this script has already run by the time they do.
(function () {
  const STORAGE_KEY = "liber_theme";
  const ICON = { light: '"☀️"', dark: '"🌙"' };

  function currentTheme() {
    const icon = getComputedStyle(document.documentElement)
      .getPropertyValue("--theme-icon")
      .trim();
    return icon === ICON.dark ? "dark" : "light";
  }

  function applyTheme(theme) {
    document.documentElement.style.setProperty("--theme-icon", ICON[theme]);
    localStorage.setItem(STORAGE_KEY, theme);
  }

  const stored = localStorage.getItem(STORAGE_KEY);
  const initial =
    stored === "dark" || stored === "light"
      ? stored
      : matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";
  document.documentElement.style.setProperty("--theme-icon", ICON[initial]);

  window.LiberTheme = {
    // Icon swap is handled by the style query in _base.css; this just
    // keeps the accessible label in sync.
    initToggle(button) {
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
