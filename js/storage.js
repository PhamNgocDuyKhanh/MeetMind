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
 * Patches a WebM Blob's EBML header with duration metadata.
 * Injects TimecodeScale and Duration tags into the Segment Info element.
 * 
 * @param {Blob} webmBlob - Recorded WebM Blob
 * @param {number} durationMs - Duration of recording in milliseconds
 * @returns {Promise<Blob>} - Fixed seekable WebM Blob
 */
export async function fixWebmDuration(webmBlob, durationMs) {
  if (!webmBlob || !durationMs || durationMs <= 0) return webmBlob;

  try {
    const buf = await webmBlob.arrayBuffer();
    const bytes = new Uint8Array(buf);

    const findPattern = (pattern) => {
      for (let i = 0; i <= bytes.length - pattern.length; i++) {
        let match = true;
        for (let j = 0; j < pattern.length; j++) {
          if (bytes[i + j] !== pattern[j]) {
            match = false;
            break;
          }
        }
        if (match) return i;
      }
      return -1;
    };

    // Locate Segment Info Element (ID: 0x15 0x49 0xA9 0x66)
    const infoPos = findPattern([0x15, 0x49, 0xa9, 0x66]);
    if (infoPos === -1) return webmBlob;

    // Check if Duration Tag (0x44 0x89) already exists inside header
    const existingDurationPos = findPattern([0x44, 0x89]);
    if (existingDurationPos !== -1 && existingDurationPos < infoPos + 300) {
      const updatedBytes = new Uint8Array(bytes);
      const view = new DataView(updatedBytes.buffer);
      view.setFloat64(existingDurationPos + 3, durationMs, false);
      return new Blob([updatedBytes], { type: webmBlob.type || "audio/webm" });
    }

    // Construct standard EBML Metadata Payload (TimecodeScale + Duration)
    // TimecodeScale: 0x2A 0xD7 0xB1 + length 3 + value 1,000,000 (1ms per tick)
    // Duration: 0x44 0x89 + length 8 + float64 value
    const metadataBuffer = new ArrayBuffer(20);
    const view = new DataView(metadataBuffer);

    // TimecodeScale Tag
    view.setUint8(0, 0x2a);
    view.setUint8(1, 0xd7);
    view.setUint8(2, 0xb1);
    view.setUint8(3, 0x03);
    view.setUint32(4, 1000000, false); // 1,000,000 ns = 1ms

    // Duration Tag
    view.setUint8(8, 0x44);
    view.setUint8(9, 0x89);
    view.setUint8(10, 0x08);
    view.setFloat64(11, durationMs, false);

    const metadataBytes = new Uint8Array(metadataBuffer);

    // Inject metadata immediately following Segment Info Header ID (offset + 5 bytes)
    const injectPos = infoPos + 5;
    const finalBuffer = new Uint8Array(bytes.length + metadataBytes.length);
    finalBuffer.set(bytes.subarray(0, injectPos), 0);
    finalBuffer.set(metadataBytes, injectPos);
    finalBuffer.set(bytes.subarray(injectPos), injectPos + metadataBytes.length);

    return new Blob([finalBuffer], { type: webmBlob.type || "audio/webm" });
  } catch (err) {
    console.warn("[Storage] Duration header patch failed:", err);
    return webmBlob;
  }
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
