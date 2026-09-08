/**
 * storage.js
 * ---------------------------------------------------------------------------
 * Handles persistence, settings storage, export formatting, and WebM
 * duration metadata patching for seekable audio recordings.
 * ---------------------------------------------------------------------------
 */

const STORAGE_KEYS = {
  SETTINGS: "meetmind_settings_v1",
  SESSION: "meetmind_active_session_v1",
};

// ---------------------------------------------------------------------------
// Settings persistence
// ---------------------------------------------------------------------------

export function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.SETTINGS);
    if (!raw) return getDefaultSettings();
    return { ...getDefaultSettings(), ...JSON.parse(raw) };
  } catch (err) {
    console.error("[Storage] Failed to load settings:", err);
    return getDefaultSettings();
  }
}

export function saveSettings(settings) {
  const next = { ...getDefaultSettings(), ...settings };
  localStorage.setItem(STORAGE_KEYS.SETTINGS, JSON.stringify(next));
  return next;
}

export function getDefaultSettings() {
  return {
    geminiKeyPrimary: "",
    selectedGeminiModel: "gemini-1.5-flash",
    micDeviceId: "",
    micLanguage: "en-US",
    enableSystemChannel: true,
    systemLanguage: "en-US",
  };
}

export function hasAnyAiKey(settings) {
  return Boolean(settings?.geminiKeyPrimary?.trim());
}

export function clearApiKeys() {
  const current = loadSettings();
  current.geminiKeyPrimary = "";
  saveSettings(current);
  return current;
}

// ---------------------------------------------------------------------------
// In-memory Session State & Persistence
// ---------------------------------------------------------------------------

let currentSession = {
  meetingStartedAt: null,
  transcriptEntries: [],
  summaryText: "",
  audioBlob: null,
};

export function resetSession() {
  currentSession = {
    meetingStartedAt: null,
    transcriptEntries: [],
    summaryText: "",
    audioBlob: null,
  };
  clearStoredMeetingData();
}

export function startSessionClock(timestamp = Date.now()) {
  currentSession.meetingStartedAt = timestamp;
  persistSession();
}

export function addTranscriptEntry(entry) {
  currentSession.transcriptEntries.push(entry);
  persistSession();
}

export function getTranscriptEntries() {
  return currentSession.transcriptEntries;
}

export function hasTranscriptEntries() {
  return currentSession.transcriptEntries.length > 0;
}

export function setAudioBlob(blob) {
  currentSession.audioBlob = blob;
}

export function hasAudioBlob() {
  return Boolean(currentSession.audioBlob);
}

export function getAudioBlob() {
  return currentSession.audioBlob;
}

export function setSummaryText(text) {
  currentSession.summaryText = text;
  persistSession();
}

export function getSummaryText() {
  return currentSession.summaryText;
}

function persistSession() {
  try {
    const dataToSave = {
      meetingStartedAt: currentSession.meetingStartedAt,
      transcriptEntries: currentSession.transcriptEntries,
      summaryText: currentSession.summaryText,
    };
    localStorage.setItem(STORAGE_KEYS.SESSION, JSON.stringify(dataToSave));
  } catch (err) {
    console.warn("[Storage] Session auto-save quota exceeded:", err);
  }
}

export function loadPersistedSession() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.SESSION);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed.transcriptEntries || parsed.transcriptEntries.length === 0) return null;

    currentSession.meetingStartedAt = parsed.meetingStartedAt || null;
    currentSession.transcriptEntries = parsed.transcriptEntries || [];
    currentSession.summaryText = parsed.summaryText || "";
    return currentSession;
  } catch (err) {
    console.error("[Storage] Failed to restore session:", err);
    return null;
  }
}

export function flushSessionPersistence() {
  persistSession();
}

export function clearStoredMeetingData() {
  try {
    localStorage.removeItem(STORAGE_KEYS.SESSION);
  } catch (_) {
    /* ignore removal errors */
  }
}

// ---------------------------------------------------------------------------
// WebM Duration Repair (Fixes Chrome non-seekable WebM recorder output)
// ---------------------------------------------------------------------------

/**
 * Patches a WebM Blob's EBML header with duration metadata using window.ysFixWebmDuration.
 * Converts callback-style ysFixWebmDuration into a Promise.
 * 
 * @param {Blob} webmBlob - Recorded WebM Blob
 * @param {number} durationMs - Duration of recording in milliseconds
 * @returns {Promise<Blob>} - Fixed seekable WebM Blob
 */
export async function fixWebmDuration(webmBlob, durationMs) {
  if (!webmBlob || !durationMs || durationMs <= 0) return webmBlob;

  try {
    const fixFn = window.ysFixWebmDuration || window.fixWebmDuration;
    if (typeof fixFn === "function") {
      return new Promise((resolve) => {
        fixFn(webmBlob, durationMs, (fixedBlob) => {
          resolve(fixedBlob || webmBlob);
        });
      });
    }
  } catch (err) {
    console.warn("[Storage] Duration header patch failed:", err);
  }

  return webmBlob;
}

// ---------------------------------------------------------------------------
// File Export Helpers
// ---------------------------------------------------------------------------

export function downloadMarkdownExport({ filenameBase }) {
  const entries = getTranscriptEntries();
  const summary = getSummaryText();
  let content = `# MeetMind Session Transcript\n*Exported at: ${new Date().toLocaleString()}*\n\n`;

  if (summary) {
    content += `## Summary\n${summary}\n\n---\n\n`;
  }

  content += `## Transcript\n`;
  entries.forEach((item) => {
    const time = new Date(item.timestamp).toLocaleTimeString();
    const speaker = item.channel === "system" ? "Others" : "Me";
    content += `**[${time}] ${speaker}:** ${item.text}\n\n`;
  });

  triggerBlobDownload(new Blob([content], { type: "text/markdown;charset=utf-8" }), `${filenameBase}.md`);
}

export function downloadPlainTextExport({ filenameBase }) {
  const entries = getTranscriptEntries();
  const summary = getSummaryText();
  let content = `MeetMind Session Transcript\nExported at: ${new Date().toLocaleString()}\n\n`;

  if (summary) {
    content += `--- SUMMARY ---\n${summary}\n\n----------------\n\n`;
  }

  content += `--- TRANSCRIPT ---\n`;
  entries.forEach((item) => {
    const time = new Date(item.timestamp).toLocaleTimeString();
    const speaker = item.channel === "system" ? "Others" : "Me";
    content += `[${time}] ${speaker}: ${item.text}\n`;
  });

  triggerBlobDownload(new Blob([content], { type: "text/plain;charset=utf-8" }), `${filenameBase}.txt`);
}

export function downloadAudioRecording(filenameBase) {
  const blob = getAudioBlob();
  if (!blob) return false;
  const ext = blob.type.includes("mp4") ? "mp4" : "webm";
  triggerBlobDownload(blob, `${filenameBase}.${ext}`);
  return true;
}

function triggerBlobDownload(blob, filename) {
  const url = (window.URL || window.webkitURL).createObjectURL(blob);
  const a = document.createElement("a");
  a.style.display = "none";
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    (window.URL || window.webkitURL).revokeObjectURL(url);
  }, 100);
}
