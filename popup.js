// Cross-browser namespace (Firefox = browser, Chromium = chrome)
const api = typeof browser !== "undefined" ? browser : chrome;

const PAUSE_LABELS = ["Off", "Light", "Medium", "Heavy"];

const els = {
  text: document.getElementById("text"),
  wpm: document.getElementById("wpm"),
  wpmVal: document.getElementById("wpmVal"),
  dev: document.getElementById("dev"),
  devVal: document.getElementById("devVal"),
  pause: document.getElementById("pause"),
  pauseVal: document.getElementById("pauseVal"),
  typos: document.getElementById("typos"),
  sound: document.getElementById("sound"),
  start: document.getElementById("start"),
  status: document.getElementById("status"),
};

const SETTINGS_KEYS = ["wpm", "dev", "pause", "typos", "sound"];

// --- Load saved settings -----------------------------------------------------
async function loadSettings() {
  try {
    const saved = await api.storage.local.get("settings");
    const s = saved.settings || {};
    if (s.wpm != null) els.wpm.value = s.wpm;
    if (s.dev != null) els.dev.value = s.dev;
    if (s.pause != null) els.pause.value = s.pause;
    if (s.typos != null) els.typos.checked = s.typos;
    if (s.sound != null) els.sound.checked = s.sound;
  } catch (_) {}
  syncLabels();
}

function saveSettings() {
  const settings = {
    wpm: +els.wpm.value,
    dev: +els.dev.value,
    pause: +els.pause.value,
    typos: els.typos.checked,
    sound: els.sound.checked,
  };
  try {
    api.storage.local.set({ settings });
  } catch (_) {}
}

// --- UI sync -----------------------------------------------------------------
function syncLabels() {
  els.wpmVal.textContent = els.wpm.value;
  els.devVal.textContent = els.dev.value;
  els.pauseVal.textContent = PAUSE_LABELS[+els.pause.value];
}

SETTINGS_KEYS.forEach((k) => {
  els[k].addEventListener("input", () => {
    syncLabels();
    saveSettings();
  });
});

function setStatus(msg, kind = "") {
  els.status.textContent = msg;
  els.status.className = "status" + (kind ? " " + kind : "");
}

// --- Messaging ---------------------------------------------------------------
async function getActiveTab() {
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// Make sure the content script is present, injecting it if the page was loaded
// before the extension (or was reloaded without it).
async function ensureContentScript(tabId) {
  try {
    // Talk to the top frame only; it coordinates the child frames itself.
    await api.tabs.sendMessage(tabId, { type: "ping" }, { frameId: 0 });
    return true;
  } catch (_) {
    try {
      await api.scripting.executeScript({
        target: { tabId, allFrames: true },
        files: ["content.js"],
      });
      return true;
    } catch (e) {
      return false;
    }
  }
}

els.start.addEventListener("click", async () => {
  const text = els.text.value;
  if (!text.trim()) {
    setStatus("Nothing to type. Paste some text first.", "error");
    return;
  }

  const tab = await getActiveTab();
  if (!tab || !tab.id) {
    setStatus("No active tab found.", "error");
    return;
  }

  const ok = await ensureContentScript(tab.id);
  if (!ok) {
    setStatus("Can't run on this page (browser-internal pages are blocked).", "error");
    return;
  }

  const config = {
    type: "start",
    text,
    wpm: +els.wpm.value,
    deviation: +els.dev.value,
    pauseLevel: +els.pause.value,
    typos: els.typos.checked,
    sound: els.sound.checked,
  };

  try {
    const res = await api.tabs.sendMessage(tab.id, config, { frameId: 0 });
    if (res && res.ok) {
      setStatus("Now click the text field on the page.", "ok");
      // Close the popup so the user can click the target field.
      window.close();
    } else {
      setStatus((res && res.error) || "Could not start.", "error");
    }
  } catch (e) {
    setStatus("Could not reach the page. Try reloading the tab.", "error");
  }
});

loadSettings();
