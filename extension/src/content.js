// Content script: extracts the page's embedded schedule object.
// Detects schedule pages, then pulls the `result` object via injected script or fallback parsing.
/**
 * Heuristic: determine whether the current page looks like a schedule page.
 * Checks the document title and URL for schedule-related markers.
 * @returns {boolean}
 */
function isSchedulePage() {
  return (
    (document.title && document.title.toLowerCase().includes("schedule")) ||
    location.href.includes("PrintSchedule")
  );
}

/**
 * Extract the embedded `result` object from the page. Attempts an
 * injected-script postMessage approach first, then falls back to scanning
 * inline scripts for `var result = {...}`.
 * @returns {Promise<{success:boolean,data?:Object,error?:string}>}
 */
function extractScheduleData() {
  return new Promise((resolve) => {
    function onMessage(e) {
      if (!e.data || e.data.type !== "SCHEDULE_RESULT") return;
      window.removeEventListener("message", onMessage);
      try {
        const obj =
          typeof e.data.data === "string"
            ? JSON.parse(e.data.data)
            : e.data.data;
        resolve({ success: true, data: obj });
      } catch (err) {
        resolve({
          success: false,
          error: "Failed to parse posted result: " + err.message,
        });
      }
    }

    window.addEventListener("message", onMessage);

    // Content scripts cannot read page variables, so a script injected into
    // the page posts window.result back.
    try {
      const script = document.createElement("script");
      script.src = chrome.runtime.getURL("src/injected-page.js");
      script.onload = () =>
        script.parentNode && script.parentNode.removeChild(script);
      (document.head || document.documentElement).appendChild(script);
    } catch {
      console.log("Failed to run internal script, falling back to regex");
    }

    // Fallback: find inline script text containing var result and parse
    setTimeout(() => {
      const scripts = Array.from(document.scripts)
        .map((s) => s.textContent)
        .filter(Boolean);
      const target = scripts.find((t) => t.includes("var result"));
      if (!target) {
        resolve({ success: false, error: "No result script found" });
        return;
      }
      try {
        const m = target.match(/var\s+result\s*=\s*(\{[\s\S]*?\})\s*;/);
        if (!m) {
          resolve({ success: false, error: "Could not extract JS object" });
          return;
        }
        const obj = JSON.parse(m[1]);
        resolve({ success: true, data: obj });
      } catch (e) {
        resolve({ success: false, error: e.message });
      }
    }, 50); // small delay to allow injected script to post
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.action === "extractSchedule") {
    if (!isSchedulePage()) {
      sendResponse({ success: false, error: "Not on schedule page." });
      return;
    }
    extractScheduleData().then((result) => sendResponse(result));
  }
  return true;
});
