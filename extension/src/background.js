// Background service worker.
// Loads shared auth/provider scripts and routes messages between popup/content and calendar providers.
importScripts("auth.js", "google.js", "outlook.js");

self.addEventListener("install", (event) => {});
self.addEventListener("activate", (event) => {});

/**
 * In-memory job map (id -> job object). Persisted entries are saved with
 * keys 'job:<id>' in chrome.storage.local for recovery across restarts.
 * @type {Object<string, Object>}
 */
const jobs = {};

/**
 * Persist a job in both the in-memory map and chrome.storage.local.
 * @async
 * @param {Object} job - Job object (must include job.id).
 * @returns {Promise<void>}
 */
async function saveJob(job) {
  jobs[job.id] = job;
  const toStore = {};
  toStore[`job:${job.id}`] = job;
  return new Promise((resolve) => chrome.storage.local.set(toStore, resolve));
}

/**
 * Load a persisted job by id from chrome.storage.local.
 * Returns undefined if the job is not found.
 * @async
 * @param {string} jobId
 * @returns {Promise<Object|undefined>}
 */
async function loadJob(jobId) {
  return new Promise((resolve) =>
    chrome.storage.local.get(`job:${jobId}`, (res) =>
      resolve(res[`job:${jobId}`]),
    ),
  );
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg && msg.action === "startImport") {
        const provider = msg.provider;
        const events = msg.events || null;
        const jobId = Math.random().toString(36).slice(2, 10);
        const job = {
          id: jobId,
          provider,
          status: "running",
          progress: 0,
          createdAt: Date.now(),
          createdCount: 0,
        };
        await saveJob(job);
        // run import asynchronously (don't await) and update job
        (async () => {
          try {
            let res;
            if (provider === "google") {
              console.log("background: running google import for job", jobId);
              if (!events)
                throw new Error(
                  "import via ICS is removed; pass normalized events",
                );
              res = await self.google.importEvents(events, (p, c) =>
                updateProgress(jobId, p, c),
              );
            } else if (provider === "outlook") {
              console.log("background: running outlook import for job", jobId);
              if (!events)
                throw new Error(
                  "import via ICS is removed; pass normalized events",
                );
              res = await self.outlook.importEvents(events, (p, c) =>
                updateProgress(jobId, p, c),
              );
            } else {
              throw new Error("Unsupported provider");
            }
            // Get the latest job state before marking as done
            const currentJob = (await loadJob(jobId)) || job;
            const doneJob = {
              ...currentJob,
              status: "done",
              progress: 100,
              finished: Date.now(),
              result: res,
            };
            await saveJob(doneJob);
            console.log("background: job done", jobId, doneJob.status);
          } catch (err) {
            const currentJob = (await loadJob(jobId)) || job;
            const failed = {
              ...currentJob,
              status: "failed",
              error: err.message || String(err),
            };
            await saveJob(failed);
            console.error("background: job failed", jobId, err);
          }
        })();
        sendResponse({ jobId });
        return;
      }

      if (msg && msg.action === "queryJob") {
        const job = await loadJob(msg.jobId);
        if (job) sendResponse(job);
        else sendResponse({ status: "unknown" });
        return;
      }

      // backward compatible: older direct import actions
      if (msg && msg.action === "importToGoogle") {
        const res = msg.events
          ? await self.google.importEvents(msg.events)
          : await self.google.importIcs(msg.ics);
        sendResponse({ provider: "google", result: res });
        return;
      }
      if (msg && msg.action === "importToOutlook") {
        const res = msg.events
          ? await self.outlook.importEvents(msg.events)
          : await self.outlook.importIcs(msg.ics);
        sendResponse({ provider: "outlook", result: res });
        return;
      }
      sendResponse({ ok: false, error: "Unknown action" });
    } catch (e) {
      sendResponse({ ok: false, error: e.message });
    }
  })();
  return true; // will respond asynchronously
});

/**
 * Update stored progress for a job and persist the change.
 * @async
 * @param {string} jobId
 * @param {number} progress - Progress percentage 0-100.
 * @param {number} [created] - Number of events created so far.
 * @returns {Promise<void>}
 */
async function updateProgress(jobId, progress, created) {
  const job = (await loadJob(jobId)) || jobs[jobId] || { id: jobId };
  job.progress = progress;
  if (typeof created === "number") {
    job.createdCount = created;
  }
  await saveJob(job);
}
