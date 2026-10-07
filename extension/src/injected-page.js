/**
 * Injected page script: run in page context to read window.result and
 * post it to the content script via window.postMessage.
 */
(() => {
  try {
    if (typeof window.result !== "undefined") {
      window.postMessage(
        { type: "SCHEDULE_RESULT", data: JSON.stringify(window.result) },
        "*",
      );
    }
  } catch (e) {
    // ignore
  }
})();
