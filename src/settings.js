"use strict";

// ---------------------------------------------------------------------------
// settings — read/save the extension's persistent settings.json, with
// normalisation and clamping. Depends on paths (ensureRuntime), fs-utils
// (atomic IO), and shared (DEFAULT_SETTINGS + webhookEventsList).
//
// saveSettings uses a lazy require for image-utils.js to avoid a circular
// dependency at module-load time.
// ---------------------------------------------------------------------------

const shared = require("../runtime/shared.js");
const { DEFAULT_SETTINGS } = shared;
const { readJsonCached, writeJsonAtomic, trimJsonl } = require("./fs-utils.js");
const { ensureRuntime } = require("./paths.js");

// Version marker persisted inside settings.json. Files written before the
// queue-limit defaults changed (perSessionQueueLimit 3 -> 20, globalQueueLimit
// 20 -> 100) carry no marker, so those legacy defaults are indistinguishable
// from deliberate user choices by value alone. We migrate such a file exactly
// once (bumping the marker), after which a user CAN set 3/20 on purpose and it
// sticks. Persisting the migration also keeps the runtime -- whose settings()
// reads the raw file with no migration logic -- in agreement with the
// extension about the effective limits.
const SETTINGS_VERSION = 2;

// Clamp and normalise a settings object in place. Shared by readSettings and
// saveSettings so the two code paths can never drift apart.
function normalizeSettings(settings) {
  settings.waitTimeoutSeconds = Math.max(0, Number(settings.waitTimeoutSeconds || 0));
  settings.keepaliveSeconds = Math.max(10, Number(settings.keepaliveSeconds || 300));
  settings.offlineAfterSeconds = Math.max(5, Number(settings.offlineAfterSeconds || 15));
  settings.workingTimeoutSeconds = Math.max(30, Number(settings.workingTimeoutSeconds || 300) || 300);
  settings.maxConcurrentSessions = Math.max(1, Number(settings.maxConcurrentSessions || 4));
  settings.perSessionQueueLimit = Math.max(1, Number(settings.perSessionQueueLimit || DEFAULT_SETTINGS.perSessionQueueLimit));
  settings.globalQueueLimit = Math.max(1, Number(settings.globalQueueLimit || DEFAULT_SETTINGS.globalQueueLimit));
  settings.pollSeconds = Math.max(0.1, Number(settings.pollSeconds || 0.2));
  settings.historyLimit = Math.max(20, Number(settings.historyLimit || 200));
  settings.imageLimit = Math.max(5, Number(settings.imageLimit || 50));
  settings.notifyOnAttention = settings.notifyOnAttention !== false;
  settings.retryMaxRetries = Math.min(1000, Math.max(1, Math.round(Number(settings.retryMaxRetries || 200) || 200)));
  settings.mcpSoftTimeoutSeconds = Math.max(60, Number(settings.mcpSoftTimeoutSeconds || DEFAULT_SETTINGS.mcpSoftTimeoutSeconds) || DEFAULT_SETTINGS.mcpSoftTimeoutSeconds);
  settings.webhookUrl = typeof settings.webhookUrl === "string" ? settings.webhookUrl.trim() : "";
  settings.webhookEvents = shared.webhookEventsList(settings);
  if (!["direct", "broadcast", "idle-first", "round-robin"].includes(settings.schedulingMode)) {
    settings.schedulingMode = "direct";
  }
  return settings;
}

function readSettings(paths) {
  const raw = readJsonCached(paths.settings, null);
  const hasFile = Boolean(raw && typeof raw === "object");
  const settings = { ...DEFAULT_SETTINGS, ...(hasFile ? raw : {}) };
  if (hasFile && Number(raw.settingsVersion || 0) < SETTINGS_VERSION) {
    // One-time migration of a pre-versioned file: values equal to the old
    // defaults (3 / 20) are assumed to be those defaults, not user choices.
    if (raw.perSessionQueueLimit == null || Number(raw.perSessionQueueLimit) === 3) {
      settings.perSessionQueueLimit = DEFAULT_SETTINGS.perSessionQueueLimit;
    }
    if (raw.globalQueueLimit == null || Number(raw.globalQueueLimit) === 20) {
      settings.globalQueueLimit = DEFAULT_SETTINGS.globalQueueLimit;
    }
    settings.settingsVersion = SETTINGS_VERSION;
    // Persist immediately so the migration happens exactly once, and so the
    // runtime (which reads this file verbatim, no migration logic) sees the
    // same effective limits as the extension.
    try { writeJsonAtomic(paths.settings, normalizeSettings({ ...settings })); } catch { /* next save persists it */ }
  }
  settings.settingsVersion = SETTINGS_VERSION;
  return normalizeSettings(settings);
}

function saveSettings(context, settingsPatch) {
  const paths = ensureRuntime(context);
  const next = { ...readSettings(paths), ...(settingsPatch || {}) };
  const cleaned = normalizeSettings({ ...DEFAULT_SETTINGS, ...next });
  cleaned.settingsVersion = SETTINGS_VERSION;
  writeJsonAtomic(paths.settings, cleaned);
  trimJsonl(paths.history, cleaned.historyLimit);
  // Lazy require to avoid circular dependency.
  const { cleanupImages } = require("./image-utils.js");
  cleanupImages(paths.images, cleaned.imageLimit);
  return cleaned;
}

module.exports = {
  readSettings,
  saveSettings,
};
