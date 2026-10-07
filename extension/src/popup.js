// Popup UI script: pulls schedule data from the active tab, then downloads ICS or forwards events to providers.
import {
  generateICSFromRawData,
  generateEventsFromRawData,
} from "./ics-generator.js";

const dom = {
  helpLink: document.getElementById("help-link"),
  helpView: document.getElementById("helpView"),
  closeHelp: document.getElementById("closeHelp"),
  controls: document.querySelector(".controls"),
  runBtn: document.getElementById("run-button"),
  runSpinner: document.getElementById("run-spinner"),
  runText: document.getElementById("run-text"),
  termsList: document.getElementById("terms-list"),
  status: document.getElementById("status"),
  progressContainer: document.getElementById("progress-container"),
  progressBar: document.getElementById("progress-bar"),
  progressLabel: document.getElementById("progress-label"),
  progressPercent: document.getElementById("progress-percent"),
  progressDetail: document.getElementById("progress-detail"),
};

const storage = {
  async get(keys) {
    return new Promise((resolve, reject) =>
      chrome.storage.local.get(keys, (items) => {
        if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
        resolve(items);
      }),
    );
  },
  async set(payload) {
    return new Promise((resolve, reject) =>
      chrome.storage.local.set(payload, () => {
        if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
        resolve();
      }),
    );
  },
};

function setStatus(msg) {
  dom.status.innerText = msg;
}

function setRunState(running) {
  dom.runBtn.disabled = running;
  dom.runSpinner.style.display = running ? "inline-block" : "none";
  dom.runText.innerText = running ? "Running..." : "Run Selected";
}

function showProgress(show, provider = "") {
  if (!dom.progressContainer) {
    console.error("Progress container not found");
    return;
  }
  console.log("showProgress called:", show, provider);
  dom.progressContainer.style.display = show ? "flex" : "none";
  dom.progressContainer.className = "progress-container";

  // The progress view replaces the controls so a second import cannot be
  // started while one is running.
  if (dom.controls) {
    dom.controls.style.display = show ? "none" : "flex";
  }
  if (dom.status) {
    dom.status.style.display = show ? "none" : "block";
  }
  const resultsRoot = document.getElementById("results-root");
  if (resultsRoot) {
    resultsRoot.style.display = show ? "none" : "block";
  }
  const footer = document.querySelector(".footer");
  if (footer) {
    footer.style.display = show ? "none" : "flex";
  }

  if (show) {
    const providerName =
      provider === "google"
        ? "Google Calendar"
        : provider === "outlook"
          ? "Outlook Calendar"
          : "calendar";
    dom.progressLabel.innerText = `Importing to ${providerName}...`;
    dom.progressPercent.innerText = "0%";
    dom.progressBar.style.width = "0%";
    dom.progressDetail.innerText = "Preparing...";
  }
}

function updateProgress(percent, created, total) {
  if (!dom.progressBar) return;
  const pct = Math.min(100, Math.max(0, percent));
  dom.progressBar.style.width = `${pct}%`;
  dom.progressPercent.innerText = `${Math.round(pct)}%`;

  if (total > 0) {
    dom.progressDetail.innerText = `Created ${created} of ${total} events`;
  }
}

function setProgressComplete(success, message) {
  if (!dom.progressContainer) return;
  dom.progressContainer.classList.add(success ? "complete" : "error");
  dom.progressBar.style.width = "100%";
  dom.progressPercent.innerText = success ? "Done!" : "Error";
  dom.progressDetail.innerText = message;

  setTimeout(
    () => {
      dom.progressContainer.style.display = "none";
      dom.progressContainer.className = "progress-container";
      if (dom.controls) dom.controls.style.display = "flex";
      if (dom.status) dom.status.style.display = "block";
      const resultsRoot = document.getElementById("results-root");
      if (resultsRoot) resultsRoot.style.display = "block";
      const footer = document.querySelector(".footer");
      if (footer) footer.style.display = "flex";
    },
    success ? 2000 : 4000,
  ); // Show longer on error
}

function toggleHelp(show) {
  const visible = show === true;
  dom.helpView.setAttribute("aria-hidden", visible ? "false" : "true");
  dom.helpView.style.display = visible ? "block" : "none";
  dom.controls.style.display = visible ? "none" : "";
  storage.set({ popupLastView: visible ? "help" : "settings" });
  if (visible) dom.helpView.style.animation = "help-open 180ms ease forwards";
}

async function restoreLastView() {
  try {
    const { popupLastView } = await storage.get(["popupLastView"]);
    if (popupLastView === "help") toggleHelp(true);
  } catch {
    // ignore storage failures
  }
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function requestScheduleFromPage() {
  const tab = await getActiveTab();
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tab.id, { action: "extractSchedule" }, (res) => {
      if (chrome.runtime.lastError) {
        reject(
          new Error(
            "No content script detected. Open the PrintSchedule page first.",
          ),
        );
        return;
      }
      if (!res || !res.success || !res.data) {
        reject(
          new Error(
            res ? res.error || "Failed to extract schedule." : "No data",
          ),
        );
        return;
      }
      resolve(res.data);
    });
  });
}

function getSelectedTermCodes() {
  return Array.from(
    dom.termsList.querySelectorAll('input[type="checkbox"]:checked'),
  ).map((c) => c.value);
}

function syncOptionCards() {
  ["chk-ics", "chk-google", "chk-outlook"].forEach((id) => {
    const input = document.getElementById(id);
    if (!input) return;
    const card = input.closest(".option-card");
    const update = () => {
      card?.classList.toggle("checked", input.checked);
      saveExportOptions();
    };
    input.addEventListener("change", update);
    update();
  });
}

/**
 * Save the current export options to storage.
 */
function saveExportOptions() {
  const options = {
    ics: document.getElementById("chk-ics")?.checked ?? false,
    google: document.getElementById("chk-google")?.checked ?? false,
    outlook: document.getElementById("chk-outlook")?.checked ?? false,
  };
  storage.set({ exportOptions: options });
}

/**
 * Restore export options from storage.
 * On first run (no saved options), defaults to ICS checked.
 */
async function restoreExportOptions() {
  try {
    const { exportOptions } = await storage.get(["exportOptions"]);
    const icsChk = document.getElementById("chk-ics");
    const googleChk = document.getElementById("chk-google");
    const outlookChk = document.getElementById("chk-outlook");

    if (exportOptions) {
      if (icsChk) {
        icsChk.checked = exportOptions.ics ?? false;
        icsChk
          .closest(".option-card")
          ?.classList.toggle("checked", icsChk.checked);
      }
      if (googleChk) {
        googleChk.checked = exportOptions.google ?? false;
        googleChk
          .closest(".option-card")
          ?.classList.toggle("checked", googleChk.checked);
      }
      if (outlookChk) {
        outlookChk.checked = exportOptions.outlook ?? false;
        outlookChk
          .closest(".option-card")
          ?.classList.toggle("checked", outlookChk.checked);
      }
    } else {
      // First run - default to ICS checked
      if (icsChk) {
        icsChk.checked = true;
        icsChk.closest(".option-card")?.classList.add("checked");
      }
    }
  } catch {
    // On error, default to ICS checked
    const icsChk = document.getElementById("chk-ics");
    if (icsChk) {
      icsChk.checked = true;
      icsChk.closest(".option-card")?.classList.add("checked");
    }
  }
}

/**
 * Save selected term codes to storage.
 */
function saveSelectedTerms() {
  const selectedTerms = getSelectedTermCodes();
  storage.set({ selectedTerms });
}

/**
 * Restore selected terms from storage after terms are loaded.
 */
async function restoreSelectedTerms() {
  try {
    const { selectedTerms } = await storage.get(["selectedTerms"]);
    if (selectedTerms && Array.isArray(selectedTerms)) {
      selectedTerms.forEach((code) => {
        const input = document.getElementById(`term-${code}`);
        if (input) {
          input.checked = true;
          input.closest(".option-card")?.classList.add("checked");
        }
      });
    }
  } catch {
    // Ignore storage failures
  }
}

function downloadICS(icsContent) {
  const blob = new Blob([icsContent], { type: "text/calendar" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "schedule.ics";
  a.click();
  URL.revokeObjectURL(url);
}

function renderProviderResult(provider, result) {
  const root = document.getElementById("results-root");
  const id = `result-card-${provider}`;
  let card = document.getElementById(id);
  if (!card) {
    card = document.createElement("div");
    card.className = "results-card";
    card.id = id;
    root.appendChild(card);
  }
  const title = provider === "google" ? "Google Calendar" : "Outlook Calendar";
  const errors = result.errors || [];
  card.innerHTML = `
    <div class="results-header">
      <div>
        <div class="results-title">${title}</div>
        <div class="results-meta">Created: ${result.created || 0} • Errors: ${errors.length}</div>
      </div>
      <div class="result-actions">
        <button class="ghost" data-action="toggle" data-for="${id}">Details</button>
        <button class="ghost" data-action="copy" data-json='${JSON.stringify(
          result,
        ).replace(/'/g, "\\'")}'>Copy</button>
      </div>
    </div>
    <div class="result-errors" style="display:none"></div>
  `;

  const errContainer = card.querySelector(".result-errors");
  errContainer.innerHTML = errors
    .map(
      (e) => `<div class="result-error">${e.error || JSON.stringify(e)}</div>`,
    )
    .join("");

  card.querySelectorAll("[data-action]").forEach((btn) => {
    btn.onclick = () => {
      const action = btn.getAttribute("data-action");
      if (action === "toggle") {
        const ec = card.querySelector(".result-errors");
        ec.style.display = ec.style.display === "none" ? "block" : "none";
      }
      if (action === "copy") {
        const j = btn.getAttribute("data-json");
        navigator.clipboard
          .writeText(j)
          .then(() => setStatus("Result copied to clipboard"));
      }
    };
  });
}

function pollImportJob(jobId, provider, totalEvents) {
  showProgress(true, provider);
  setStatus("");

  const check = async () => {
    const resp = await new Promise((resolve) =>
      chrome.runtime.sendMessage({ action: "queryJob", jobId }, resolve),
    );
    console.log("pollImportJob response:", resp);
    if (!resp) {
      setProgressComplete(false, "No response from background");
      setStatus("No response from background when polling job");
      return;
    }
    if (resp.status === "done") {
      // Check for done status first (before running) to avoid race condition
      console.log("Job done, calling setProgressComplete");
      const result = resp.result || { created: 0, errors: [] };
      const errCount = (result.errors || []).length;
      setProgressComplete(
        true,
        `Successfully created ${result.created} events${errCount > 0 ? ` (${errCount} errors)` : ""}`,
      );
      setStatus("");
      renderProviderResult(provider, result);
      return;
    }
    if (resp.status === "running") {
      const progress = resp.progress || 0;
      const created = resp.createdCount || 0;
      updateProgress(progress, created, totalEvents);
      setTimeout(check, 500);
      return;
    }
    if (resp.status === "failed") {
      setProgressComplete(false, resp.error || "Import failed");
      setStatus(`Import failed: ${resp.error || "unknown"}`);
      return;
    }
    // Unknown status - keep polling in case it's transitioning
    console.log("Unknown status, continuing to poll:", resp.status);
    setTimeout(check, 500);
  };
  check();
}

async function startProviderImport(provider, events) {
  setStatus(`Starting ${provider} import...`);
  const startResp = await new Promise((resolve, reject) =>
    chrome.runtime.sendMessage(
      { action: "startImport", provider, events },
      (res) => {
        if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
        resolve(res);
      },
    ),
  );
  if (startResp && startResp.jobId) {
    pollImportJob(startResp.jobId, provider, events.length);
  } else {
    setStatus(`Failed to start ${provider} import`);
    showProgress(false);
  }
}

async function loadTerms() {
  setStatus("Detecting terms on page...");
  try {
    const data = await requestScheduleFromPage();
    const terms = (data.Terms || []).slice().reverse();
    dom.termsList.innerHTML = "";
    terms.forEach((t) => {
      const code = t.Code || t.TermCode || "";
      const title = t.Name || t.Description || t.Title || code;
      const id = `term-${code}`;
      const wrapper = document.createElement("label");
      wrapper.className = "option-card";
      wrapper.style.padding = "8px";
      wrapper.htmlFor = id;
      wrapper.innerHTML = `
        <input type="checkbox" id="${id}" value="${code}" />
        <div>
          <div class="label-title">${code}</div>
          <div class="label-sub muted-note">${title}</div>
        </div>`;
      dom.termsList.appendChild(wrapper);
      const inp = wrapper.querySelector("input");
      inp.addEventListener("change", () => {
        wrapper.classList.toggle("checked", inp.checked);
        saveSelectedTerms();
      });
    });

    await restoreSelectedTerms();

    if (terms.length === 0) {
      setStatus("No terms found on this page.");
    } else {
      setStatus(
        "Terms loaded. Select desired terms or leave none to include all.",
      );
    }
  } catch (e) {
    setStatus(e.message || "Unable to load terms.");
  }
}

async function handleRunClick() {
  const doICS = document.getElementById("chk-ics").checked;
  const doGCal = document.getElementById("chk-google").checked;
  const doOCal = document.getElementById("chk-outlook").checked;

  if (!doICS && !doGCal && !doOCal) {
    setStatus("Select at least one action.");
    return;
  }

  setRunState(true);
  try {
    setStatus("Requesting schedule data from page...");
    const data = await requestScheduleFromPage();
    const selectedTermCodes = getSelectedTermCodes();

    if (doICS) {
      const ics = generateICSFromRawData(data, selectedTermCodes);
      downloadICS(ics);
      setStatus("ICS file downloaded!");
    }

    if (doGCal || doOCal) {
      const events = generateEventsFromRawData(data, selectedTermCodes);
      if (doGCal) await startProviderImport("google", events);
      if (doOCal) await startProviderImport("outlook", events);
    }
  } catch (e) {
    setStatus(e.message || "Error running export.");
  } finally {
    setRunState(false);
  }
}

function wireHelpLinks() {
  dom.helpLink.addEventListener("click", (e) => {
    e.preventDefault();
    toggleHelp(true);
  });
  dom.closeHelp.addEventListener("click", () => toggleHelp(false));
}

async function init() {
  // Must run before syncOptionCards(), which saves the current checkbox state.
  await restoreExportOptions();
  syncOptionCards();
  wireHelpLinks();
  dom.runBtn.addEventListener("click", handleRunClick);
  await restoreLastView();
  await loadTerms();
}

init();
