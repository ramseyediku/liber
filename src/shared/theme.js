// src/shared/theme.js
// Dark/light mode, in one file. This is deliberately a plain script, not an
// ES module: loaded as a blocking <script src> in each page's <head>, it
// runs immediately — before the stylesheet paints anything — which is what
// seeds --theme-icon early enough to avoid a flash of the wrong theme. (An
// inline <script> would run just as early, but Manifest V3's default CSP
// for extension pages blocks inline script execution; an external module
// script is deferred until after parsing, which is too late.) The actual
// color and sun/moon icon switch is pure CSS, driven by --theme-icon via a
// container style query — see src/styles/_base.css.
//
// Module entry points (dashboard.js, dashboard-full.js, onboarding.js) grab
// the toggle wiring off `window.LiberTheme` rather than importing it, since
// this script has already run by the time they do.
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

  // Seed immediately from the saved preference, falling back to the OS
  // setting — this is the line that has to run before first paint.
  const stored = localStorage.getItem(STORAGE_KEY);
  const initial =
    stored === "dark" || stored === "light"
      ? stored
      : matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";
  document.documentElement.style.setProperty("--theme-icon", ICON[initial]);

  window.LiberTheme = {
    // Wires a button to toggle the theme. Its sun/moon icon swap is handled
    // entirely by the style query in _base.css, so this only needs to keep
    // the accessible label in sync.
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
