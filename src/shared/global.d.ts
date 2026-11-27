// Ambient globals — not an ES module, picked up automatically by tsconfig's
// `include`. `browser` is the WebExtension-polyfill global (vendor/browser-polyfill.js),
// Promise-based like modern chrome.* overloads, so aliasing chrome's own types is close enough.
declare const browser: typeof chrome;

// window.LiberTheme — set by src/shared/theme.ts, a plain (non-module) script
// loaded via <script src> before any module script runs. Declared as both a
// Window property and a bare global so either `window.LiberTheme` or plain
// `LiberTheme` resolves.
interface LiberThemeApi {
  initToggle(button: HTMLElement | null): void;
}
interface Window {
  LiberTheme: LiberThemeApi;
}
declare const LiberTheme: LiberThemeApi;
