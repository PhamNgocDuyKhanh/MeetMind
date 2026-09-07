// js/main.js
// ---------------------------------------------------------------------------
// Central orchestrator. Every other module is "dumb" on its own — this file
// is the only place that knows the full sequence of a meeting (start ->
// pause/resume -> stop -> summarize/chat/export) and owns the shared state.
//
// Audio/transcription architecture note: this build uses the browser's
// native Web Speech API (transcription.js) driven by two independent
// recognition channels ("mic" and "system"), plus a Web-Audio mixing layer
// (audioMixer.js) used for level metering and local recording. The "system"
// channel only produces useful text if the user has routed their meeting
// audio to a loopback input device — see transcription.js's header comment
// and the in-app Settings help text for the full explanation. This
// supersedes an earlier local-Whisper (Transformers.js) design; if that
// audio.js / js/workers/* still exists in your project folder, remove it —
// this file does not import it.
// ---------------------------------------------------------------------------

import { AudioMixer } from "./audioMixer.js";
import { TranscriptionController, isSpeechRecognitionSupported } from "./transcription.js";
import {
  loadSettings,
  saveSettings,
  hasAnyAiKey,
  clearApiKeys,
  resetSession,
  startSessionClock,
  addTranscriptEntry,
  getTranscriptEntries,
  hasTranscriptEntries,
  setAudioBlob,
  hasAudioBlob,
  setSummaryText,
  getSummaryText,
  loadPersistedSession,
  flushSessionPersistence,
  clearStoredMeetingData,
  downloadMarkdownExport,
  downloadPlainTextExport,
  downloadAudioRecording,
} from "./storage.js";
import {
  fetchGeminiModels,
  summarizeTranscriptStream,
  chatWithTranscriptStream,
  getEngineStatus,
  resetEngineStatus,
} from "./ai.js";
import * as ui from "./ui.js";

// How many recent chat turns get sent to the AI as context on each new
// message. The full conversation still stays visible in the UI — this only
// bounds what's actually transmitted, so a long chat session can't eventually
// blow past a model's context window.
const MAX_CHAT_HISTORY_TURNS = 12;

// Transcript entries, the recorded audio blob, and the summary text all live
// in storage.js (the single owner of "data that gets exported/persisted") —
// this state object only holds orchestration state specific to running a
// meeting in this tab right now.
const state = {
  settings: null,
  modelList: [],
  meetingState: "idle", // 'idle' | 'starting' | 'listening' | 'paused' | 'stopping' | 'stopped'
  chatHistory: [],
  audioMixer: null,
  transcriptionController: null,
  mediaRecorder: null,
  recordedChunks: [],
  levelMeterRaf: null,
  aiAbortController: null,
};

// ---------------------------------------------------------------------------
// Meeting lifecycle
// ---------------------------------------------------------------------------

/** Wipes the transcript/chat/summary — both the underlying data (storage.js)
 *  and the on-screen view — back to a clean slate. Shared by "starting a new
 *  meeting" and the explicit "Clear" action, so both stay in sync. */
function clearMeetingView() {
  resetSession();
  resetEngineStatus();
  ui.renderEngineStatus(getEngineStatus());
  ui.clearTranscriptView();
  ui.clearChatView();
  ui.getSummaryOutputElement().innerHTML = "";
  ui.setSummaryEmptyState(true);
  state.chatHistory = [];
}

async function onStart() {
  // Guards against a second click during the async permission-request window
  // below — without this, a fast double-click could spin up two AudioMixer/
  // SpeechRecognition instances, leaking the first one's mic/tab-share handle.
  if (state.meetingState !== "idle" && state.meetingState !== "stopped") return;

  if (!isSpeechRecognitionSupported()) {
    ui.showToast("This browser does not support live transcription. Try Chrome or Edge.", "error");
    return;
  }

  // If a summarize/chat call from a PREVIOUS meeting is still streaming,
  // cancel it now — otherwise its eventual result would land in the new
  // meeting's freshly-reset session data instead of being discarded.
  state.aiAbortController?.abort();

  state.meetingState = "starting";
  ui.renderMeetingControls("starting");
  ui.renderStatus("requesting-permissions");
  state.audioMixer = new AudioMixer();

  let captureResult;
  try {
    captureResult = await state.audioMixer.start({
      micDeviceId: state.settings.micDeviceId || undefined,
      systemAudio: Boolean(state.settings.enableSystemChannel),
    });
  } catch (err) {
    console.error("AudioMixer.start failed:", err);
    ui.showToast(describeAudioMixerError(err), "error");
    state.meetingState = "idle";
    ui.renderMeetingControls("idle");
    ui.renderStatus("idle");
    state.audioMixer = null;
    return;
  }

  // Only reset the session — and clear the screen of the previous meeting's
  // transcript/chat/summary — once we know this new meeting is actually
  // going to start. Doing this earlier meant a denied permission prompt
  // would silently destroy the prior meeting's recoverable data for nothing.
  clearMeetingView();
  startSessionClock(Date.now());
  ui.setClearButtonEnabled(false);

  if (captureResult.warning) {
    // Non-fatal (e.g. system audio unavailable but mic still works) — "info"
    // rather than "error" styling, since the meeting is continuing normally.
    ui.showToast(captureResult.warning.message, "info");
  }

  startRecording(captureResult.combinedStream);

  state.transcriptionController = new TranscriptionController({
    onResult: handleTranscriptionResult,
    onError: handleTranscriptionError,
    onStatusChange: handleTranscriptionStatus,
  });

  try {
    state.transcriptionController.start({
      mic: { language: state.settings.micLanguage },
      system: captureResult.systemStream ? { language: state.settings.systemLanguage } : undefined,
    });
  } catch (err) {
    console.error("TranscriptionController.start failed:", err);
    ui.showToast(err.message, "error");
    state.meetingState = "idle";
    ui.renderMeetingControls("idle");
    await teardownAudio();
    return;
  }

  state.meetingState = "listening";
  ui.renderMeetingControls("listening");
  ui.renderStatus("listening");
  ui.setFallbackBanner(null);
  startLevelMeterLoop();
}

function onPause() {
  state.transcriptionController?.pauseAll();
  if (state.mediaRecorder && state.mediaRecorder.state === "recording") {
    state.mediaRecorder.pause();
  }
  state.meetingState = "paused";
  ui.renderMeetingControls("paused");
  ui.renderStatus("paused");
}

function onResume() {
  state.transcriptionController?.resumeAll();
  if (state.mediaRecorder && state.mediaRecorder.state === "paused") {
    state.mediaRecorder.resume();
  }
  state.meetingState = "listening";
  ui.renderMeetingControls("listening");
  ui.renderStatus("listening");
}

async function onStop() {
  ui.renderStatus("stopping");

  state.transcriptionController?.stopAll();
  state.transcriptionController = null;

  await stopRecording();
  await teardownAudio();

  state.meetingState = "stopped";
  ui.renderMeetingControls("stopped");
  ui.renderStatus("stopped");
  ui.setFallbackBanner(null);
  ui.setAudioDownloadEnabled(hasAudioBlob());
  ui.setPostMeetingControlsEnabled(hasTranscriptEntries());
  ui.setClearButtonEnabled(hasTranscriptEntries());
  flushSessionPersistence();
}

/** Explicit "Clear" action — wipes the ended meeting's transcript/chat/summary
 *  without starting a new recording, for when someone's done reviewing/exporting
 *  and wants a clean slate before the next meeting (rather than reloading the page). */
function onClearMeeting() {
  if (state.meetingState !== "stopped") return; // only reachable when the button is enabled anyway
  clearMeetingView();
  state.meetingState = "idle";
  ui.renderMeetingControls("idle");
  ui.renderStatus("idle");
  ui.setAudioDownloadEnabled(false);
  ui.setPostMeetingControlsEnabled(false);
  ui.setClearButtonEnabled(false);
  ui.showToast("Cleared — ready for a new meeting.", "info");
}

function handleTranscriptionResult({ channel, text, isFinal }) {
  if (isFinal) {
    const record = { channel, text, timestamp: Date.now() };
    addTranscriptEntry(record);
    ui.renderTranscriptEntry(record);
    ui.setPostMeetingControlsEnabled(true);
  } else {
    ui.renderInterim(channel, text);
  }
}

function handleTranscriptionError({ channel, error }) {
  console.error(`Transcription error [${channel}]:`, error);
  if (error.code === "no-speech") return; // routine — not worth interrupting the user
  if (error.code === "permission-denied") {
    ui.showToast(`Microphone permission was denied for the ${channel} channel.`, "error");
  } else if (error.code === "aborted") {
    ui.showToast(
      `${channel === "system" ? "System" : "Mic"} transcription hit its auto-restart limit. Stop and Start again to resume.`,
      "error"
    );
  } else {
    ui.showToast(error.message, "error");
  }
}

function handleTranscriptionStatus(_statusEvent) {
  // Per-channel listening/stopped transitions happen routinely as
  // SpeechRecognition auto-restarts (see transcription.js) — the top-level
  // status pill reflects meeting lifecycle, not these internal restarts, so
  // there's intentionally nothing to render here.
}

function describeAudioMixerError(err) {
  if (err?.code === "permission-denied") return "Microphone or screen-share permission was denied.";
  if (err?.code === "not-found") return "No microphone was found. Check your input device in Settings.";
  if (err?.code === "not-supported") return err.message;
  return err?.message || "Could not start audio capture.";
}

// ---------------------------------------------------------------------------
// Recording (for the post-meeting audio download)
// ---------------------------------------------------------------------------

function pickSupportedAudioMimeType() {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];
  return candidates.find((type) => window.MediaRecorder?.isTypeSupported?.(type)) || "";
}

function startRecording(stream) {
  state.recordedChunks = [];

  if (!window.MediaRecorder) return; // recording is a bonus feature — its absence shouldn't block the meeting

  const mimeType = pickSupportedAudioMimeType();
  try {
    state.mediaRecorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
  } catch (err) {
    console.error("MediaRecorder unavailable:", err);
    state.mediaRecorder = null;
    return;
  }

  state.mediaRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) state.recordedChunks.push(e.data);
  };
  state.mediaRecorder.start(1000);
}

function stopRecording() {
  return new Promise((resolve) => {
    if (!state.mediaRecorder || state.mediaRecorder.state === "inactive") {
      resolve();
      return;
    }
    state.mediaRecorder.onstop = () => {
      const type = state.mediaRecorder.mimeType || "audio/webm";
      setAudioBlob(new Blob(state.recordedChunks, { type }));
      resolve();
    };
    try {
      state.mediaRecorder.stop();
    } catch (err) {
      console.error("Error stopping MediaRecorder:", err);
      resolve();
    }
  });
}

// ---------------------------------------------------------------------------
// Hardware teardown + level meters
// ---------------------------------------------------------------------------

async function teardownAudio() {
  stopLevelMeterLoop();
  if (state.audioMixer) {
    try {
      await state.audioMixer.stop();
    } catch (err) {
      console.error("Error stopping AudioMixer:", err);
    }
    state.audioMixer = null;
  }
}

function startLevelMeterLoop() {
  function tick() {
    if (!state.audioMixer || !state.audioMixer.isRunning) return;
    ui.renderLevelMeters(state.audioMixer.readLevels());
    state.levelMeterRaf = requestAnimationFrame(tick);
  }
  state.levelMeterRaf = requestAnimationFrame(tick);
}

function stopLevelMeterLoop() {
  if (state.levelMeterRaf) {
    cancelAnimationFrame(state.levelMeterRaf);
    state.levelMeterRaf = null;
  }
  ui.renderLevelMeters({ mic: 0, system: 0 });
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

async function onOpenSettings() {
  ui.openSettingsModal(state.settings);
  ui.populateModelSelect(state.modelList, state.settings.selectedGeminiModel);
  try {
    const devices = await AudioMixer.listInputDevices();
    ui.populateMicDeviceSelect(devices, state.settings.micDeviceId);
  } catch (err) {
    console.error("Could not list input devices:", err);
  }
}

function onCloseSettings() {
  ui.closeSettingsModal();
}

async function onSaveSettings() {
  const formValues = ui.readSettingsForm();
  const previousGeminiKey = state.settings.geminiKeyPrimary;

  try {
    state.settings = saveSettings(formValues);
  } catch (err) {
    console.error("Failed to save settings:", err);
    ui.showToast("Could not save settings — your browser's storage may be full or restricted.", "error");
    return;
  }

  ui.showToast("Settings saved.", "success");
  ui.closeSettingsModal();

  // Only hit the network again if the key actually changed (or we don't have
  // a model list yet) — otherwise every unrelated settings save (language,
  // system-channel toggle, etc.) would trigger a needless model-list refetch.
  const keyChanged = state.settings.geminiKeyPrimary !== previousGeminiKey;
  if (state.settings.geminiKeyPrimary && (keyChanged || state.modelList.length === 0)) {
    await refreshModels({ silent: true });
  }
}

function onClearStoredData() {
  clearStoredMeetingData();
  ui.showToast("Cleared the stored transcript recovery data. Your API keys and other settings are unaffected.", "success");
}

function onClearApiKeys() {
  state.settings = clearApiKeys();
  ui.clearApiKeyFields();
  state.modelList = [];
  ui.populateModelSelect([], "");
  ui.showToast("Cleared your saved API keys from this browser. Other settings are unaffected.", "success");
}

async function onRefreshModels() {
  const formValues = ui.readSettingsForm();
  const key = formValues.geminiKeyPrimary || state.settings.geminiKeyPrimary;
  if (!key) {
    ui.showToast("Enter a Gemini API key first.", "error");
    return;
  }
  try {
    ui.showToast("Fetching available models…", "info");
    state.modelList = await fetchGeminiModels(key);
    ui.populateModelSelect(state.modelList, formValues.selectedGeminiModel || state.settings.selectedGeminiModel);
    ui.showToast(`Loaded ${state.modelList.length} models.`, "success");
  } catch (err) {
    console.error("fetchGeminiModels failed:", err);
    ui.showToast(err.message || "Failed to fetch models.", "error");
  }
}

async function refreshModels({ silent = false } = {}) {
  try {
    state.modelList = await fetchGeminiModels(state.settings.geminiKeyPrimary);
    if (!silent) ui.showToast(`Loaded ${state.modelList.length} models.`, "success");
  } catch (err) {
    console.error("refreshModels failed:", err);
    if (!silent) ui.showToast(err.message, "error");
  }
}

// ---------------------------------------------------------------------------
// Export — the actual file formatting/generation lives in storage.js; this
// is just "which button was clicked."
// ---------------------------------------------------------------------------

function exportFilenameBase() {
  return `meeting-${new Date().toISOString().slice(0, 10)}`;
}

function onExportMarkdown() {
  downloadMarkdownExport({ filenameBase: exportFilenameBase() });
}

function onExportPlainText() {
  downloadPlainTextExport({ filenameBase: exportFilenameBase() });
}

function onDownloadAudio() {
  if (!downloadAudioRecording(exportFilenameBase())) {
    ui.showToast("No recorded audio available yet.", "error");
  }
}

// ---------------------------------------------------------------------------
// AI: summarize + chat
// ---------------------------------------------------------------------------

function buildTranscriptText() {
  return getTranscriptEntries()
    .map((e) => `${e.channel === "system" ? "Others" : "Me"}: ${e.text}`)
    .join("\n");
}

function onAiFallback(info) {
  ui.setFallbackBanner(info);
  ui.renderEngineStatus(getEngineStatus());
}

async function onSummarize() {
  if (!hasTranscriptEntries()) {
    ui.showToast("Nothing to summarize yet.", "error");
    return;
  }

  state.aiAbortController?.abort();
  state.aiAbortController = new AbortController();

  ui.setSummaryEmptyState(false);
  ui.setSummarizeButtonBusy(true);
  const renderer = ui.createThrottledStreamRenderer(ui.getSummaryOutputElement());
  renderer.reset();

  try {
    for await (const delta of summarizeTranscriptStream({
      transcriptText: buildTranscriptText(),
      settings: state.settings,
      modelList: state.modelList,
      onFallback: onAiFallback,
      signal: state.aiAbortController.signal,
    })) {
      renderer.push(delta);
    }
    renderer.flushNow();
    setSummaryText(renderer.getText());
    ui.setFallbackBanner(null);
  } catch (err) {
    if (err.name === "AbortError") {
      // Discard whatever partial text was on screen — it was never saved, so
      // leaving it visible would misrepresent what's actually stored/exportable.
      const savedSummary = getSummaryText();
      if (savedSummary) {
        ui.getSummaryOutputElement().innerHTML = ui.renderMarkdownSafe(savedSummary);
      } else {
        renderer.reset();
        ui.setSummaryEmptyState(true);
      }
    } else {
      console.error("Summarization failed:", err);
      ui.showToast(err.message || "Summarization failed.", "error");
      ui.setSummaryEmptyState(getSummaryText() === "");
    }
  } finally {
    ui.setSummarizeButtonBusy(false);
    ui.renderEngineStatus(getEngineStatus());
  }
}

async function onCopySummary() {
  const summaryText = getSummaryText();
  if (!summaryText) {
    ui.showToast("No summary to copy yet.", "error");
    return;
  }
  try {
    await navigator.clipboard.writeText(summaryText);
    ui.showToast("Summary copied to clipboard.", "success");
  } catch (err) {
    console.error("Clipboard write failed:", err);
    ui.showToast("Could not copy automatically — select and copy the text manually.", "error");
  }
}

async function onChatSubmit(userMessage) {
  if (!hasTranscriptEntries()) {
    ui.showToast("There's no transcript yet to chat about — start a meeting first.", "error");
    return;
  }

  ui.appendChatUserMessage(userMessage);
  state.chatHistory.push({ role: "user", text: userMessage });

  const bubble = ui.createChatAssistantBubble();
  const renderer = ui.createThrottledStreamRenderer(bubble);

  state.aiAbortController?.abort();
  state.aiAbortController = new AbortController();
  ui.setChatFormBusy(true);

  try {
    // Only the most recent turns go to the model as context — the full
    // conversation still stays visible on screen either way — so a very
    // long chat session can't eventually exceed a model's context window.
    const recentHistory = state.chatHistory.slice(-MAX_CHAT_HISTORY_TURNS - 1, -1);
    for await (const delta of chatWithTranscriptStream({
      transcriptText: buildTranscriptText(),
      chatHistory: recentHistory,
      userMessage,
      settings: state.settings,
      modelList: state.modelList,
      onFallback: onAiFallback,
      signal: state.aiAbortController.signal,
    })) {
      renderer.push(delta);
    }
    renderer.flushNow();
    state.chatHistory.push({ role: "assistant", text: renderer.getText() });
    ui.setFallbackBanner(null);
  } catch (err) {
    if (err.name === "AbortError") {
      // Remove the incomplete assistant bubble entirely rather than leaving a
      // half-streamed reply on screen that was never saved to chat history.
      bubble.closest(".bubble-row")?.remove();
    } else {
      console.error("Chat failed:", err);
      bubble.textContent = "Sorry — something went wrong generating a reply.";
      ui.showToast(err.message || "Chat failed.", "error");
    }
  } finally {
    ui.setChatFormBusy(false);
    ui.renderEngineStatus(getEngineStatus());
  }
}

// ---------------------------------------------------------------------------
// Cleanup + init
// ---------------------------------------------------------------------------

/**
 * Recovers a transcript (and summary, if any) left over from before an
 * accidental reload/crash. Audio can't be recovered this way — Blobs don't
 * survive JSON serialization — so that limitation is called out to the user.
 * A restored session is presented as "stopped": there's no way to resume
 * live mic capture into it, but export/summarize/chat all work immediately.
 */
function restorePersistedSession() {
  const restored = loadPersistedSession();
  if (!restored) return;

  restored.transcriptEntries.forEach((entry) => ui.renderTranscriptEntry(entry));
  ui.setPostMeetingControlsEnabled(true);
  ui.setClearButtonEnabled(true);

  if (restored.summaryText) {
    ui.setSummaryEmptyState(false);
    ui.getSummaryOutputElement().innerHTML = ui.renderMarkdownSafe(restored.summaryText);
  }

  state.meetingState = "stopped";
  ui.renderMeetingControls("stopped");
  ui.renderStatus("stopped", "Restored session");
  ui.showToast(
    "Restored your transcript from before the last reload. Recorded audio couldn't be recovered.",
    "info"
  );
}

function onBeforeUnload() {
  // Best-effort synchronous cleanup. Async work isn't guaranteed to finish
  // during unload, but stopping tracks directly still releases hardware and
  // clears the browser's "recording" indicator immediately.
  try {
    state.transcriptionController?.stopAll();
    state.audioMixer?.micStream?.getTracks().forEach((t) => t.stop());
    state.audioMixer?.systemStream?.getTracks().forEach((t) => t.stop());
  } catch (_) {
    /* best-effort only */
  }
}

function init() {
  state.settings = loadSettings();

  ui.bindControls({
    onStart,
    onPause,
    onResume,
    onStop,
    onOpenSettings,
    onCloseSettings,
    onSaveSettings,
    onRefreshModels,
    onClearStoredData,
    onClearApiKeys,
    onClearMeeting,
    onExportMarkdown,
    onExportPlainText,
    onDownloadAudio,
    onSummarize,
    onCopySummary,
    onChatSubmit,
    onBeforeUnload,
  });

  ui.renderMeetingControls("idle");
  ui.renderStatus("idle");
  ui.clearTranscriptView();
  ui.setPostMeetingControlsEnabled(false);
  ui.setAudioDownloadEnabled(false);
  ui.setClearButtonEnabled(false);
  ui.setSummaryEmptyState(true);
  ui.switchSidePanel("summary");
  ui.populateModelSelect([], "");
  resetEngineStatus();
  ui.renderEngineStatus(getEngineStatus());

  restorePersistedSession();

  if (!isSpeechRecognitionSupported()) {
    ui.showUnsupportedBanner("This browser doesn't support live transcription (Web Speech API). Please use Chrome or Edge.");
  }
  if (!navigator.mediaDevices?.getDisplayMedia) {
    ui.showToast("This browser can't capture tab/system audio — mic-only sessions will still work.", "info");
  }

  if (hasAnyAiKey(state.settings) && state.settings.geminiKeyPrimary) {
    refreshModels({ silent: true });
  }
}

document.addEventListener("DOMContentLoaded", init);
