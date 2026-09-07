// js/storage.js
// ---------------------------------------------------------------------------
// STRICT BOUNDARY: this module owns data — settings persistence, the current
// meeting's session data (transcript entries + recorded audio), and export
// file formatting/generation. It never touches the DOM, never renders
// anything, and never shows a toast or dialog. ui.js owns rendering; main.js
// wires the two together. The one browser API this module does use —
// creating a transient <a> element to trigger a file download — is a data-
// export mechanism, not app UI, so it stays here rather than in ui.js.
//
// Security note: API keys are stored in plaintext in localStorage because
// this app has no backend to hold them instead. That's an inherent trade-off
// of a 100%-client-side design, not an oversight — see the in-app Settings
// modal copy for the user-facing disclosure. Never log key values to the
// console anywhere in this module or elsewhere in the app.
// ---------------------------------------------------------------------------

const STORAGE_KEY = "meetingai:settings:v1";

const DEFAULT_SETTINGS = {
  version: 1,
  geminiKeyPrimary: "",
  geminiKeySecondary: "",
  groqKey: "",
  selectedGeminiModel: "",
  groqModel: "",
  micDeviceId: "",
  micLanguage: "en-US",
  systemLanguage: "en-US",
  enableSystemChannel: false,
};

/** Loads persisted settings, merged over defaults so new fields never come back `undefined`. */
export function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_SETTINGS, ...parsed, version: DEFAULT_SETTINGS.version };
  } catch (err) {
    console.error("Failed to parse saved settings — resetting to defaults.", err);
    return { ...DEFAULT_SETTINGS };
  }
}

/** Merges `partial` onto the currently saved settings and persists the result. */
export function saveSettings(partial) {
  const next = { ...loadSettings(), ...partial, version: DEFAULT_SETTINGS.version };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch (err) {
    throw new Error("Could not save settings to localStorage: " + err.message);
  }
  return next;
}

export function clearSettings() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch (_) {
    /* ignore */
  }
}

export function hasAnyAiKey(settings) {
  return Boolean(settings.geminiKeyPrimary || settings.geminiKeySecondary || settings.groqKey);
}

/** Clears only the saved API keys, leaving every other setting (language, mic device, etc.) untouched. */
export function clearApiKeys() {
  return saveSettings({ geminiKeyPrimary: "", geminiKeySecondary: "", groqKey: "" });
}

// ---------------------------------------------------------------------------
// Meeting session store
//
// The current meeting's transcript entries and recorded audio live here —
// not in main.js — so that "what gets exported" has a single owner. main.js
// still drives *when* things happen (start/stop), but the data itself is
// storage.js's responsibility.
// ---------------------------------------------------------------------------

let session = {
  meetingStartedAt: null,
  transcriptEntries: [],
  audioBlob: null,
  summaryText: "",
};

const SESSION_STORAGE_KEY = "meetingai:session:v1";

let persistTimer = null;

/**
 * Persists the recoverable parts of the session (NOT the audio blob — Blobs
 * can't be JSON-serialized, and storing audio as base64 in localStorage would
 * blow its size limits fast) so a reload doesn't silently lose a transcript.
 * Debounced to at most once every few seconds — re-serializing and writing
 * the whole transcript on every single utterance would be O(n²) work over a
 * long meeting and block the main thread for no real benefit.
 */
function persistSession() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      localStorage.setItem(
        SESSION_STORAGE_KEY,
        JSON.stringify({
          meetingStartedAt: session.meetingStartedAt,
          transcriptEntries: session.transcriptEntries,
          summaryText: session.summaryText,
        })
      );
    } catch (_) {
      /* storage full/unavailable — recovery just won't work this time, not fatal */
    }
  }, 3000);
}

/** Forces an immediate write, bypassing the debounce — call this when the meeting ends. */
function flushPersistSession() {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  try {
    localStorage.setItem(
      SESSION_STORAGE_KEY,
      JSON.stringify({
        meetingStartedAt: session.meetingStartedAt,
        transcriptEntries: session.transcriptEntries,
        summaryText: session.summaryText,
      })
    );
  } catch (_) {
    /* ignore */
  }
}

/**
 * Restores a previously-persisted session (if any) into the in-memory store
 * and returns it, so main.js can re-render it at startup. Returns null when
 * there's nothing worth recovering (no transcript entries).
 */
export function loadPersistedSession() {
  try {
    const raw = localStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.transcriptEntries) || parsed.transcriptEntries.length === 0) return null;

    session.meetingStartedAt = parsed.meetingStartedAt ?? null;
    session.transcriptEntries = parsed.transcriptEntries;
    session.summaryText = parsed.summaryText || "";
    return {
      meetingStartedAt: session.meetingStartedAt,
      transcriptEntries: session.transcriptEntries,
      summaryText: session.summaryText,
    };
  } catch (err) {
    console.error("Failed to restore persisted session.", err);
    return null;
  }
}

function clearPersistedSession() {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  try {
    localStorage.removeItem(SESSION_STORAGE_KEY);
  } catch (_) {
    /* ignore */
  }
}

/** Clears the persisted transcript/summary recovery data without touching settings/keys. */
export function clearStoredMeetingData() {
  clearPersistedSession();
}

/** Forces any pending debounced write to happen now — call this when a meeting ends. */
export function flushSessionPersistence() {
  flushPersistSession();
}

/** Clears all session data — call this at the start of a new meeting. */
export function resetSession() {
  session = { meetingStartedAt: null, transcriptEntries: [], audioBlob: null, summaryText: "" };
  clearPersistedSession();
}

/** Marks "elapsed time zero" for the current meeting, used to compute per-utterance timestamps. */
export function startSessionClock(startedAt = Date.now()) {
  session.meetingStartedAt = startedAt;
}

/** @param {{channel: 'mic'|'system', text: string, timestamp: number}} entry */
export function addTranscriptEntry(entry) {
  session.transcriptEntries.push(entry);
  persistSession();
}

export function getTranscriptEntries() {
  return session.transcriptEntries;
}

export function hasTranscriptEntries() {
  return session.transcriptEntries.length > 0;
}

export function setSummaryText(text) {
  session.summaryText = text;
  persistSession();
}

export function getSummaryText() {
  return session.summaryText;
}

export function setAudioBlob(blob) {
  session.audioBlob = blob;
}

export function hasAudioBlob() {
  return Boolean(session.audioBlob);
}

// ---------------------------------------------------------------------------
// WebM duration fix
//
// Chrome's MediaRecorder streams WebM output incrementally (via periodic
// `ondataavailable` chunks), so it has no way to know the final recording
// length while writing the file's header — the resulting Blob's Duration
// metadata ends up missing or reported as Infinity by players/editors, which
// breaks seeking and playback-speed changes. This patches the EBML/Matroska
// structure in place — no re-encoding, no external library — by locating the
// Segment → Info → Duration element and overwriting its 8-byte float64
// payload directly, once the real duration is known.
//
// Scope note: this handles the case that actually occurs in practice —
// Chrome always pre-allocates an 8-byte float64 slot for Duration even while
// streaming, specifically so it CAN be patched like this afterward. If that
// slot isn't found (unexpected encoder output), the original Blob is
// returned unmodified rather than attempting to insert a new element and
// resize the surrounding structure, which would be substantially more
// complex for a case that shouldn't come up with browser-recorded WebM.
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
// File export — professional transcription formatting:
//   - metadata header (date/time)
//   - [HH:MM:SS] elapsed-time stamps per utterance, relative to meeting start
//   - clear speaker labels (Me: / Others:)
// ---------------------------------------------------------------------------

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Give the browser a moment to pick up the click-triggered download before
  // the object URL is revoked.
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function speakerLabel(channel) {
  return channel === "system" ? "Others" : "Me";
}

/** Formats milliseconds elapsed since meeting start as a zero-padded HH:MM:SS stamp. */
function formatElapsed(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

export function buildMarkdownExport({ title = "Meeting Transcript", summaryText = session.summaryText } = {}) {
  const startedAt = session.meetingStartedAt ?? Date.now();
  const lines = [`# ${title}`, "", `**Date:** ${new Date(startedAt).toLocaleString()}`, "", "---", ""];

  session.transcriptEntries.forEach((entry) => {
    const elapsed = formatElapsed(entry.timestamp - startedAt);
    lines.push(`**[${elapsed}] ${speakerLabel(entry.channel)}:** ${entry.text}`, "");
  });

  if (summaryText) {
    lines.push("---", "", "## Summary", "", summaryText, "");
  }
  return lines.join("\n");
}

export function buildPlainTextExport({ title = "Meeting Transcript", summaryText = session.summaryText } = {}) {
  const startedAt = session.meetingStartedAt ?? Date.now();
  const lines = [title, `Date: ${new Date(startedAt).toLocaleString()}`, ""];

  session.transcriptEntries.forEach((entry) => {
    const elapsed = formatElapsed(entry.timestamp - startedAt);
    lines.push(`[${elapsed}] ${speakerLabel(entry.channel)}: ${entry.text}`);
  });

  if (summaryText) {
    lines.push("", "--- Summary ---", "", summaryText);
  }
  return lines.join("\n");
}

export function downloadMarkdownExport(opts = {}) {
  const content = buildMarkdownExport(opts);
  triggerDownload(
    new Blob([content], { type: "text/markdown;charset=utf-8" }),
    `${opts.filenameBase || "meeting-transcript"}.md`
  );
}

export function downloadPlainTextExport(opts = {}) {
  const content = buildPlainTextExport(opts);
  triggerDownload(
    new Blob([content], { type: "text/plain;charset=utf-8" }),
    `${opts.filenameBase || "meeting-transcript"}.txt`
  );
}

/** Downloads the current session's recorded audio, if any. Returns false if there's nothing to download. */
export function downloadAudioRecording(filenameBase = "meeting-recording") {
  if (!session.audioBlob) return false;
  const type = session.audioBlob.type || "";
  const ext = type.includes("mp4") ? "mp4" : type.includes("ogg") ? "ogg" : "webm";
  triggerDownload(session.audioBlob, `${filenameBase}.${ext}`);
  return true;
}
