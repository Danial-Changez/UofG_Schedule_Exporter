// Options page script: saves/loads OAuth client IDs via chrome.storage.

const ui = {
  saveBtn: document.getElementById("save"),
  loadBtn: document.getElementById("load"),
  helpBtn: document.getElementById("help"),
  backBtn: document.getElementById("backFromHelp"),
  settingsView: document.querySelector(".settings-view"),
  helpView: document.getElementById("helpView"),
  status: document.getElementById("status"),
  googleInput: document.getElementById("google_client_id"),
  outlookInput: document.getElementById("outlook_client_id"),
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
  ui.status.innerText = msg;
}

async function loadClientIds() {
  try {
    const { google_client_id, outlook_client_id } = await storage.get([
      "google_client_id",
      "outlook_client_id",
    ]);
    ui.googleInput.value = google_client_id || "";
    ui.outlookInput.value = outlook_client_id || "";
    setStatus("Loaded.");
  } catch (e) {
    setStatus(e.message || "Failed to load settings.");
  }
}

async function saveClientIds() {
  try {
    await storage.set({
      google_client_id: ui.googleInput.value.trim(),
      outlook_client_id: ui.outlookInput.value.trim(),
    });
    setStatus("Saved.");
  } catch (e) {
    setStatus(e.message || "Failed to save.");
  }
}

function toggleHelp(show) {
  const visible = show === true;
  ui.settingsView.style.display = visible ? "none" : "block";
  ui.helpView.style.display = visible ? "block" : "none";
  ui.helpView.setAttribute("aria-hidden", visible ? "false" : "true");
}

function wireEvents() {
  ui.saveBtn.addEventListener("click", saveClientIds);
  ui.loadBtn.addEventListener("click", loadClientIds);
  ui.helpBtn.addEventListener("click", () => toggleHelp(true));
  ui.backBtn.addEventListener("click", () => toggleHelp(false));
}

async function init() {
  wireEvents();
  await loadClientIds();
}

init();
