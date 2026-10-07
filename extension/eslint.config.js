import js from "@eslint/js";
import globals from "globals";

const extensionPage = { ...globals.browser, ...globals.webextensions };

export default [
  js.configs.recommended,
  {
    // ES modules loaded by popup.html.
    files: ["src/popup.js", "src/ics-generator.js"],
    languageOptions: { sourceType: "module", globals: extensionPage },
  },
  {
    // Classic scripts: content script, page-context script, options page.
    files: ["src/content.js", "src/injected-page.js", "src/options.js"],
    languageOptions: { sourceType: "script", globals: extensionPage },
  },
  {
    // The service worker and the classic scripts it loads with importScripts().
    files: [
      "src/background.js",
      "src/auth.js",
      "src/google.js",
      "src/outlook.js",
    ],
    languageOptions: {
      sourceType: "script",
      globals: { ...globals.serviceworker, ...globals.webextensions },
    },
  },
  {
    // Specs run in Node and stub the `chrome` and `self` globals themselves.
    files: ["tests/**/*.js"],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.mocha,
        chrome: "readonly",
        self: "readonly",
      },
    },
  },
];
