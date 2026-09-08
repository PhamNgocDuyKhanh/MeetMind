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
    geminiKeySecondary: "",
    selectedGeminiModel: "gemini-1.5-flash",
    groqKey: "",
    groqModel: "",
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
  current.geminiKeySecondary = "";
  current.groqKey = "";
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
// WebM duration fix (in-house — no external library)
//
// Chrome's MediaRecorder streams WebM output incrementally, so it has no way
// to know the final recording length while writing the file's header — the
// resulting Blob's Duration metadata ends up missing or reported as Infinity
// by players/editors, breaking seeking and playback-speed changes.
//
// This patches the EBML/Matroska structure in place — no re-encoding, no
// external library — by locating the Segment → Info → Duration element and
// overwriting its 8-byte float64 payload directly, once the real duration is
// known. Chrome always pre-allocates that 8-byte slot even while streaming,
// specifically so it CAN be patched like this afterward.
//
// Scope note: if that slot isn't found, the original Blob is returned
// unmodified rather than attempting to INSERT a new Duration element and
// resize the surrounding structure — that's a substantially riskier
// operation (it requires shifting every subsequent byte offset in the file
// to stay consistent), and is the kind of transformation most likely to
// produce a file whose duration metadata looks right but whose actual
// playable media data is corrupted or truncated.
// ---------------------------------------------------------------------------

const EBML_ID = {
  EBML_HEADER: 0x1a45dfa3,
  SEGMENT: 0x18538067,
  INFO: 0x1549a966,
  TIMECODE_SCALE: 0x2ad7b1,
  DURATION: 0x4489,
  CLUSTER: 0x1f43b675,
};

/**
 * Reads one EBML variable-length integer ("vint") at `offset`.
 * `stripMarker` controls whether the leading length-marker bit is masked out
 * of the value: false for element *IDs* (the marker bits are part of what
 * makes an ID like 0x1A45DFA3 unique), true for element *sizes* (where the
 * marker bit isn't part of the numeric value, and an all-1s data pattern
 * means "unknown size" — common for a live-streamed Segment).
 */
function readVint(view, offset, stripMarker) {
  if (offset >= view.byteLength) return null;
  const firstByte = view.getUint8(offset);
  if (firstByte === 0) return null; // malformed / ran off the end of a sane vint

  let length = 1;
  let mask = 0x80;
  while (length <= 8 && !(firstByte & mask)) {
    mask >>= 1;
    length++;
  }
  if (length > 8 || offset + length > view.byteLength) return null;

  let value = stripMarker ? firstByte & (mask - 1) : firstByte;
  let isUnknown = stripMarker ? (firstByte & (mask - 1)) === mask - 1 : false;

  for (let i = 1; i < length; i++) {
    const byte = view.getUint8(offset + i);
    value = value * 256 + byte;
    if (stripMarker && byte !== 0xff) isUnknown = false;
  }

  return { value, length, isUnknown };
}

/** Reads an unsigned integer element's raw big-endian bytes as a plain number. */
function readUint(view, offset, length) {
  let value = 0;
  for (let i = 0; i < length; i++) value = value * 256 + view.getUint8(offset + i);
  return value;
}

/**
 * Walks the EBML structure of a WebM ArrayBuffer to find Segment → Info →
 * Duration, returning its byte offset/length and the Info section's
 * TimecodeScale (needed to convert a millisecond duration into the units
 * the Duration field is actually stored in). Returns null if any part of
 * that path isn't found.
 */
function locateDurationField(buffer) {
  const view = new DataView(buffer);
  const len = buffer.byteLength;

  // Skip straight over the EBML header block at the top of the file.
  const headerId = readVint(view, 0, false);
  if (!headerId || headerId.value !== EBML_ID.EBML_HEADER) return null;
  const headerSize = readVint(view, headerId.length, true);
  if (!headerSize) return null;
  let offset = headerId.length + headerSize.length + headerSize.value;

  // Enter the Segment element (MediaRecorder almost always writes this with
  // an "unknown size" marker, since it's streaming Clusters as they happen).
  const segmentId = readVint(view, offset, false);
  if (!segmentId || segmentId.value !== EBML_ID.SEGMENT) return null;
  const segmentSize = readVint(view, offset + segmentId.length, true);
  if (!segmentSize) return null;
  let segOffset = offset + segmentId.length + segmentSize.length;
  const segEnd = segmentSize.isUnknown ? len : segOffset + segmentSize.value;

  // Walk Segment's direct children looking for Info. Bail out the moment we
  // reach a Cluster (actual media data) — Duration always precedes it.
  while (segOffset < segEnd - 1) {
    const childId = readVint(view, segOffset, false);
    if (!childId) break;
    const childSize = readVint(view, segOffset + childId.length, true);
    if (!childSize) break;
    const childDataOffset = segOffset + childId.length + childSize.length;

    if (childId.value === EBML_ID.CLUSTER) break;

    if (childId.value === EBML_ID.INFO) {
      const infoEnd = childDataOffset + childSize.value;
      let infoOffset = childDataOffset;
      let timecodeScale = 1000000; // Matroska/WebM default: 1 tick = 1,000,000ns = 1ms
      let durationField = null;

      while (infoOffset < infoEnd - 1) {
        const fieldId = readVint(view, infoOffset, false);
        if (!fieldId) break;
        const fieldSize = readVint(view, infoOffset + fieldId.length, true);
        if (!fieldSize) break;
        const fieldDataOffset = infoOffset + fieldId.length + fieldSize.length;

        if (fieldId.value === EBML_ID.TIMECODE_SCALE) {
          timecodeScale = readUint(view, fieldDataOffset, fieldSize.value);
        } else if (fieldId.value === EBML_ID.DURATION) {
          durationField = { offset: fieldDataOffset, length: fieldSize.value };
        }

        infoOffset = fieldDataOffset + fieldSize.value;
      }

      return durationField ? { ...durationField, timecodeScale } : null;
    }

    if (childSize.isUnknown) break; // can't know where this element ends — stop rather than guess
    segOffset = childDataOffset + childSize.value;
  }

  return null;
}

/**
 * Returns a new Blob with the real recording duration patched into its WebM
 * metadata, so players can seek and change playback speed correctly. Falls
 * back to returning the original Blob unmodified if a patchable Duration
 * field can't be found — this never throws and never corrupts the recording.
 */
export async function fixWebmDuration(blob, durationMs) {
  if (!blob || !durationMs || durationMs <= 0) return blob;

  try {
    const buffer = await blob.arrayBuffer();
    const durationField = locateDurationField(buffer);

    if (!durationField || durationField.length !== 8) {
      console.warn(
        "fixWebmDuration: no patchable 8-byte Duration field found — leaving the recording's metadata as-is."
      );
      return blob;
    }

    const scaledDuration = (durationMs * 1e6) / durationField.timecodeScale;
    const patch = new ArrayBuffer(8);
    new DataView(patch).setFloat64(0, scaledDuration, false); // EBML floats are big-endian

    return new Blob([blob.slice(0, durationField.offset), patch, blob.slice(durationField.offset + 8)], {
      type: blob.type,
    });
  } catch (err) {
    console.error("fixWebmDuration failed — using the original recording unmodified.", err);
    return blob;
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
