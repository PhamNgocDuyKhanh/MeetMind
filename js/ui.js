// js/ui.js
// ---------------------------------------------------------------------------
// Owns all direct DOM manipulation. main.js calls these functions and never
// touches document.* itself, so DOM structure can change without touching
// orchestration logic.
//
// XSS policy:
//   - Plain transcript / chat text -> always written via textContent. There
//     is never a reason for a spoken transcript line or a typed chat message
//     to contain HTML, so we don't give it the chance to.
//   - AI-generated markdown (summaries, assistant replies) -> converted to a
//     small, explicit HTML subset and THEN passed through DOMPurify with an
//     explicit allow-list before it ever touches innerHTML. Untrusted text
//     never reaches innerHTML unsanitized, full stop.
// ---------------------------------------------------------------------------

import { CHAT_PROMPT_PRESETS } from "./chatPrompts.js";

// ---- Element cache ---------------------------------------------------------

const els = {};

function cacheElements() {
  const ids = [
    "status-pill",
    "status-dot",
    "status-text",
    "meeting-timer",
    "fallback-banner",
    "btn-start",
    "btn-pause",
    "btn-resume",
    "btn-stop",
    "btn-open-settings",
    "btn-close-settings",
    "settings-modal",
    "settings-form",
    "input-gemini-key-primary",
    "input-gemini-key-secondary",
    "input-groq-key",
    "select-gemini-model",
    "input-gemini-model-manual",
    "select-groq-model",
    "input-groq-model-manual",
    "btn-refresh-models",
    "select-mic-device",
    "select-mic-language",
    "select-system-language",
    "checkbox-enable-system-channel",
    "system-channel-help",
    "btn-clear-api-keys",
    "btn-clear-stored-data",
    "btn-clear-meeting",
    "btn-cancel-settings",
    "mic-level-bar",
    "system-level-bar",
    "transcript-log",
    "transcript-empty-state",
    "btn-export",
    "export-menu",
    "btn-export-md",
    "btn-export-txt",
    "btn-download-audio",
    "tab-btn-summary",
    "tab-btn-chat",
    "summary-panel",
    "chat-panel",
    "summary-output",
    "summary-empty-state",
    "btn-summarize",
    "btn-copy-summary",
    "chat-log",
    "chat-empty-state",
    "chat-form",
    "chat-input",
    "btn-clear-chat",
    "chat-prompt-presets",
    "toast-container",
    "unsupported-banner",
    "panel-resize-handle",
    "engine-status-dot",
    "engine-status-text",
    "engine-model-value",
    "engine-last-call-value",
    "engine-fallbacks-value",
  ];
  ids.forEach((id) => {
    els[toCamel(id)] = document.getElementById(id);
  });
}

function toCamel(kebab) {
  return kebab.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
}

// ---- Safe markdown rendering ------------------------------------------------

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function markdownToHtml(markdown) {
  // Escape first so any raw tags already present in the source text (e.g. an
  // AI reply that happens to contain "<script>") become inert before we
  // introduce our OWN generated tags below.
  let html = escapeHtml(markdown);

  html = html.replace(/```([\s\S]*?)```/g, (_, code) => `<pre class="code-block"><code>${code.trim()}</code></pre>`);
  html = html.replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>');
  html = html.replace(/^### (.*)$/gim, "<h3>$1</h3>");
  html = html.replace(/^## (.*)$/gim, "<h2>$1</h2>");
  html = html.replace(/^# (.*)$/gim, "<h1>$1</h1>");
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/(^|[^*])\*(?!\*)([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
  html = html.replace(/(^|\n)[-*] (.*)/g, "$1<li>$2</li>");
  html = html.replace(/(<li>.*<\/li>\n?)+/g, (match) => `<ul>${match.replace(/\n/g, "")}</ul>`);
  html = html.replace(/\n{2,}/g, "</p><p>");
  html = html.replace(/\n/g, "<br>");
  return `<p>${html}</p>`;
}

/** Converts AI markdown to sanitized, allow-listed HTML safe to assign to innerHTML. */
export function renderMarkdownSafe(markdown) {
  const raw = markdownToHtml(markdown || "");
  return DOMPurify.sanitize(raw, {
    ALLOWED_TAGS: ["h1", "h2", "h3", "p", "strong", "em", "ul", "li", "pre", "code", "br"],
    ALLOWED_ATTR: ["class"],
  });
}

// ---- Throttled AI stream renderer (keeps DOM updates off the hot path) ----

/**
 * Buffers incoming text deltas and flushes them to the DOM at most once per
 * `intervalMs`, aligned to a rAF, instead of re-rendering on every token.
 * This is what keeps a fast token stream from causing layout thrash.
 */
export function createThrottledStreamRenderer(targetEl, { intervalMs = 60 } = {}) {
  let buffer = "";
  let timerId = null;

  function flush() {
    timerId = null;
    targetEl.innerHTML = renderMarkdownSafe(buffer);
    targetEl.scrollTop = targetEl.scrollHeight;
  }

  return {
    push(delta) {
      buffer += delta;
      if (timerId === null) {
        timerId = setTimeout(() => requestAnimationFrame(flush), intervalMs);
      }
    },
    flushNow() {
      clearTimeout(timerId);
      timerId = null;
      flush();
    },
    reset() {
      buffer = "";
      clearTimeout(timerId);
      timerId = null;
      targetEl.innerHTML = "";
    },
    getText: () => buffer,
  };
}

// ---- Meeting state / controls ----------------------------------------------

const STATUS_STYLES = {
  idle: { text: "Ready", dotModifier: "idle" },
  "requesting-permissions": { text: "Requesting access…", dotModifier: "paused" },
  listening: { text: "Listening", dotModifier: "listening" },
  paused: { text: "Paused", dotModifier: "paused" },
  stopping: { text: "Stopping…", dotModifier: "stopping" },
  processing: { text: "Processing audio…", dotModifier: "stopping" },
  stopped: { text: "Meeting ended", dotModifier: "stopped" },
  error: { text: "Error", dotModifier: "error" },
};

export function renderStatus(stateKey, customText) {
  const style = STATUS_STYLES[stateKey] || STATUS_STYLES.idle;
  els.statusText.textContent = customText || style.text;
  els.statusDot.className = `status-dot status-dot--${style.dotModifier}`;
}

/** Formats milliseconds as "MM:SS", switching to "H:MM:SS" once it crosses an hour. */
function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/** Shows the meeting timer with the given elapsed time (wall-clock ms since the meeting started). */
export function renderMeetingTimer(elapsedMs) {
  els.meetingTimer.textContent = formatDuration(elapsedMs);
  els.meetingTimer.classList.remove("hidden");
}

/** Hides the timer and resets its label — call this when there's no active/ended meeting to show. */
export function hideMeetingTimer() {
  els.meetingTimer.classList.add("hidden");
  els.meetingTimer.textContent = "00:00";
}

/** Shows/hides/disables the Start/Pause/Resume/Stop buttons for a given lifecycle state. */
export function renderMeetingControls(meetingState) {
  const show = (el, visible) => el.classList.toggle("hidden", !visible);

  show(els.btnStart, meetingState === "idle" || meetingState === "stopped" || meetingState === "starting");
  show(els.btnPause, meetingState === "listening");
  show(els.btnResume, meetingState === "paused");
  show(els.btnStop, meetingState === "listening" || meetingState === "paused");

  // "starting" covers the async getUserMedia/getDisplayMedia permission
  // window — Start stays visible but disabled so a second click during that
  // gap can't spin up a duplicate AudioMixer/SpeechRecognition instance.
  const isStarting = meetingState === "starting";
  els.btnStart.disabled = isStarting;
  els.btnStart.classList.toggle("opacity-40", isStarting);
  els.btnStart.classList.toggle("cursor-not-allowed", isStarting);
}

/** Disables Summarize and swaps its label while a summary is streaming. */
export function setSummarizeButtonBusy(isBusy) {
  els.btnSummarize.disabled = isBusy;
  els.btnSummarize.textContent = isBusy ? "Summarizing…" : "Summarize";
  els.btnSummarize.classList.toggle("opacity-40", isBusy);
  els.btnSummarize.classList.toggle("cursor-not-allowed", isBusy);
}

/** Disables the chat input + send button while a reply is streaming. */
export function setChatFormBusy(isBusy) {
  els.chatInput.disabled = isBusy;
  const submitBtn = els.chatForm.querySelector('button[type="submit"]');
  if (submitBtn) submitBtn.disabled = isBusy;
}

export function setPostMeetingControlsEnabled(enabled) {
  [els.btnExport, els.btnSummarize].forEach((el) => {
    el.disabled = !enabled;
    el.classList.toggle("opacity-40", !enabled);
    el.classList.toggle("cursor-not-allowed", !enabled);
  });
  if (!enabled) closeExportMenu();
}

/** Enables the "Clear" button — separate from Export/Summarize since it should only ever
 *  be clickable once a meeting has fully stopped, never while one is still recording. */
export function setClearButtonEnabled(enabled) {
  els.btnClearMeeting.disabled = !enabled;
  els.btnClearMeeting.classList.toggle("opacity-40", !enabled);
  els.btnClearMeeting.classList.toggle("cursor-not-allowed", !enabled);
}

export function setAudioDownloadEnabled(enabled) {
  els.btnDownloadAudio.disabled = !enabled;
  els.btnDownloadAudio.classList.toggle("opacity-40", !enabled);
  els.btnDownloadAudio.classList.toggle("cursor-not-allowed", !enabled);
}

export function showUnsupportedBanner(message) {
  els.unsupportedBanner.textContent = message;
  els.unsupportedBanner.classList.remove("hidden");
  els.btnStart.disabled = true;
  els.btnStart.classList.add("opacity-40", "cursor-not-allowed");
}

export function setFallbackBanner(info /* null to clear */) {
  if (!info) {
    els.fallbackBanner.classList.add("hidden");
    els.fallbackBanner.textContent = "";
    return;
  }
  els.fallbackBanner.textContent = `Rate limit / error on ${info.fromProvider} (${info.fromModel}) — switched to ${info.label || info.toProvider}.`;
  els.fallbackBanner.classList.remove("hidden");
}

// ---- Engine status panel ----------------------------------------------------

const ENGINE_STATE_LABELS = { standby: "Standby", active: "Active", error: "Error" };
const ENGINE_STATE_DOT_MODIFIERS = { standby: "idle", active: "listening", error: "error" };

/** Renders the compact Engine Status card from the snapshot returned by ai.js's getEngineStatus(). */
export function renderEngineStatus(status) {
  const state = status?.state || "standby";
  els.engineStatusDot.className = `status-dot status-dot--${ENGINE_STATE_DOT_MODIFIERS[state] || "idle"}`;
  els.engineStatusText.textContent = ENGINE_STATE_LABELS[state] || "Standby";
  els.engineModelValue.textContent = status?.activeModel || "—";

  if (status?.lastCallAt) {
    const when = new Date(status.lastCallAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    els.engineLastCallValue.textContent = status.lastLatencyMs != null ? `${when} · ${status.lastLatencyMs}ms` : when;
  } else {
    els.engineLastCallValue.textContent = "—";
  }

  els.engineFallbacksValue.textContent = String(status?.fallbackCount ?? 0);
}

// ---- Transcript rendering ----------------------------------------------------

const interimEls = { mic: null, system: null };

function channelStyles(channel) {
  return channel === "system"
    ? { rowModifier: "theirs", bubbleModifier: "theirs", label: "Others" }
    : { rowModifier: "mine", bubbleModifier: "mine", label: "Me" };
}

export function clearTranscriptView() {
  els.transcriptLog.innerHTML = "";
  interimEls.mic = null;
  interimEls.system = null;
  els.transcriptEmptyState.classList.remove("hidden");
}

/** Empties the chat log and restores its empty state — call this when starting a new meeting. */
export function clearChatView() {
  els.chatLog.innerHTML = "";
  els.chatEmptyState.classList.remove("hidden");
  els.chatLog.appendChild(els.chatEmptyState);
}

export function renderTranscriptEntry(entry) {
  els.transcriptEmptyState.classList.add("hidden");
  removeInterim(entry.channel);

  const style = channelStyles(entry.channel);
  const row = document.createElement("div");
  row.className = `bubble-row bubble-row--${style.rowModifier}`;

  const meta = document.createElement("div");
  meta.className = "bubble__meta";
  const nameSpan = document.createElement("span");
  nameSpan.textContent = style.label;
  const timeSpan = document.createElement("span");
  timeSpan.textContent = new Date(entry.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  meta.appendChild(nameSpan);
  meta.appendChild(timeSpan);

  const bubble = document.createElement("div");
  bubble.className = `bubble bubble--${style.bubbleModifier}`;
  bubble.textContent = entry.text; // plain text only — never innerHTML here

  row.appendChild(meta);
  row.appendChild(bubble);
  els.transcriptLog.appendChild(row);
  els.transcriptLog.scrollTop = els.transcriptLog.scrollHeight;
}

function removeInterim(channel) {
  if (interimEls[channel]) {
    interimEls[channel].remove();
    interimEls[channel] = null;
  }
}

export function renderInterim(channel, text) {
  if (!text) {
    removeInterim(channel);
    return;
  }
  els.transcriptEmptyState.classList.add("hidden");
  const style = channelStyles(channel);

  if (!interimEls[channel]) {
    const row = document.createElement("div");
    row.className = `bubble-row bubble-row--${style.rowModifier} bubble-row--interim`;
    const bubble = document.createElement("div");
    bubble.className = "bubble bubble--interim";
    row.appendChild(bubble);
    els.transcriptLog.appendChild(row);
    interimEls[channel] = row;
  }

  interimEls[channel].querySelector("div").textContent = text;
  els.transcriptLog.scrollTop = els.transcriptLog.scrollHeight;
}

export function renderLevelMeters({ mic = 0, system = 0 } = {}) {
  els.micLevelBar.style.width = `${Math.round(mic * 100)}%`;
  els.systemLevelBar.style.width = `${Math.round(system * 100)}%`;
}

// ---- Export dropdown ---------------------------------------------------------

function openExportMenu() {
  if (els.btnExport.disabled) return;
  els.exportMenu.classList.remove("hidden");
}

function closeExportMenu() {
  els.exportMenu.classList.add("hidden");
}

function toggleExportMenu() {
  if (els.exportMenu.classList.contains("hidden")) openExportMenu();
  else closeExportMenu();
}

// ---- Settings modal ----------------------------------------------------------

export function populateModelSelect(models, selectedId) {
  els.selectGeminiModel.innerHTML = "";
  if (models.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "No models loaded — add a key and refresh";
    els.selectGeminiModel.appendChild(opt);
    return;
  }
  if (!selectedId) {
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "Select a model…";
    placeholder.disabled = true;
    placeholder.selected = true;
    els.selectGeminiModel.appendChild(placeholder);
  }
  models.forEach((m) => {
    const opt = document.createElement("option");
    opt.value = m.id;
    opt.textContent = m.displayName;
    if (m.id === selectedId) opt.selected = true;
    els.selectGeminiModel.appendChild(opt);
  });
}

export function populateMicDeviceSelect(devices, selectedId) {
  els.selectMicDevice.innerHTML = "";
  const defaultOpt = document.createElement("option");
  defaultOpt.value = "";
  defaultOpt.textContent = "System default";
  els.selectMicDevice.appendChild(defaultOpt);

  devices.forEach((d, i) => {
    const opt = document.createElement("option");
    opt.value = d.deviceId;
    opt.textContent = d.label || `Microphone ${i + 1}`;
    if (d.deviceId === selectedId) opt.selected = true;
    els.selectMicDevice.appendChild(opt);
  });
}

/**
 * Reconciles a <select> + manual-override <input> pair against a saved value:
 * if the value matches one of the select's options, select it and clear the
 * manual field; otherwise (a custom/typed model the dropdown doesn't know
 * about) leave the select on its default and surface the value in the manual
 * field instead, so Settings never looks like it "forgot" a custom model.
 */
function reconcileModelField(selectEl, manualInputEl, currentValue) {
  const matchesOption = Array.from(selectEl.options).some((o) => o.value === currentValue);
  if (currentValue && !matchesOption) {
    manualInputEl.value = currentValue;
    selectEl.value = "";
  } else {
    manualInputEl.value = "";
    selectEl.value = currentValue || "";
  }
}

let lastFocusedBeforeModal = null;

function getFocusableElements(container) {
  return Array.from(
    container.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')
  ).filter((el) => !el.disabled && el.getClientRects().length > 0);
}

function trapSettingsFocus(e) {
  if (e.key === "Escape") {
    closeSettingsModal();
    return;
  }
  if (e.key !== "Tab") return;

  const focusables = getFocusableElements(els.settingsModal);
  if (focusables.length === 0) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];

  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

export function openSettingsModal(settings) {
  els.inputGeminiKeyPrimary.value = settings.geminiKeyPrimary || "";
  els.inputGeminiKeySecondary.value = settings.geminiKeySecondary || "";
  els.inputGroqKey.value = settings.groqKey || "";
  els.selectMicLanguage.value = settings.micLanguage || "en-US";
  els.selectSystemLanguage.value = settings.systemLanguage || "en-US";
  els.checkboxEnableSystemChannel.checked = Boolean(settings.enableSystemChannel);
  els.selectSystemLanguage.disabled = !settings.enableSystemChannel;

  reconcileModelField(els.selectGeminiModel, els.inputGeminiModelManual, settings.selectedGeminiModel);
  reconcileModelField(els.selectGroqModel, els.inputGroqModelManual, settings.groqModel);

  lastFocusedBeforeModal = document.activeElement;
  els.settingsModal.classList.remove("hidden");
  document.addEventListener("keydown", trapSettingsFocus);
  // Wait a frame so the modal is actually visible/focusable before we move focus into it.
  requestAnimationFrame(() => els.inputGeminiKeyPrimary.focus());
}

export function closeSettingsModal() {
  els.settingsModal.classList.add("hidden");
  document.removeEventListener("keydown", trapSettingsFocus);
  if (lastFocusedBeforeModal && typeof lastFocusedBeforeModal.focus === "function") {
    lastFocusedBeforeModal.focus();
  }
  lastFocusedBeforeModal = null;
}

/** Clears just the three key inputs in-place, without re-running the whole modal-open flow. */
export function clearApiKeyFields() {
  els.inputGeminiKeyPrimary.value = "";
  els.inputGeminiKeySecondary.value = "";
  els.inputGroqKey.value = "";
}

export function readSettingsForm() {
  const manualGemini = els.inputGeminiModelManual.value.trim();
  const manualGroq = els.inputGroqModelManual.value.trim();
  return {
    geminiKeyPrimary: els.inputGeminiKeyPrimary.value.trim(),
    geminiKeySecondary: els.inputGeminiKeySecondary.value.trim(),
    groqKey: els.inputGroqKey.value.trim(),
    selectedGeminiModel: manualGemini || els.selectGeminiModel.value,
    groqModel: manualGroq || els.selectGroqModel.value,
    micDeviceId: els.selectMicDevice.value,
    micLanguage: els.selectMicLanguage.value,
    systemLanguage: els.selectSystemLanguage.value,
    enableSystemChannel: els.checkboxEnableSystemChannel.checked,
  };
}

// Minimal eye / eye-off icons. Shown as: masked field -> "eye" (click to reveal),
// revealed field -> "eye-off" (click to hide) — the two icons swap in place so
// the toggle button never has to resize or reflow its row.
const EYE_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">' +
  '<path stroke-linecap="round" stroke-linejoin="round" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z"/>' +
  '<path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/></svg>';
const EYE_OFF_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">' +
  '<path stroke-linecap="round" stroke-linejoin="round" d="M3.98 8.223A10.477 10.477 0 001.934 12c1.292 4.338 5.31 7.5 10.066 7.5.993 0 1.953-.138 2.863-.395M6.228 6.228A10.45 10.45 0 0112 4.5c4.756 0 8.773 3.162 10.065 7.5a10.522 10.522 0 01-4.293 5.774M6.228 6.228L3 3m3.228 3.228l3.65 3.65m7.894 7.894L21 21m-3.228-3.228l-3.65-3.65m0 0a3 3 0 10-4.243-4.243m4.242 4.242L9.88 9.88"/></svg>';

function setupKeyVisibilityToggles() {
  document.querySelectorAll("[data-toggle-visibility]").forEach((btn) => {
    btn.innerHTML = EYE_ICON;
    btn.setAttribute("aria-label", "Show API key");
    btn.addEventListener("click", () => {
      const input = document.getElementById(btn.getAttribute("data-toggle-visibility"));
      if (!input) return;
      const revealed = input.type === "password";
      input.type = revealed ? "text" : "password";
      btn.innerHTML = revealed ? EYE_OFF_ICON : EYE_ICON;
      btn.setAttribute("aria-label", revealed ? "Hide API key" : "Show API key");
    });
  });
}

function setupSettingsTabs() {
  els.checkboxEnableSystemChannel.addEventListener("change", () => {
    els.selectSystemLanguage.disabled = !els.checkboxEnableSystemChannel.checked;
    els.systemChannelHelp.classList.toggle("hidden", !els.checkboxEnableSystemChannel.checked);
  });
}

// ---- Summary / Chat panels ---------------------------------------------------

export function switchSidePanel(panel /* 'summary' | 'chat' */) {
  const isSummary = panel === "summary";
  els.summaryPanel.classList.toggle("hidden", !isSummary);
  els.chatPanel.classList.toggle("hidden", isSummary);
  els.tabBtnSummary.classList.toggle("is-active", isSummary);
  els.tabBtnChat.classList.toggle("is-active", !isSummary);
}

export function getSummaryOutputElement() {
  return els.summaryOutput;
}

export function setSummaryEmptyState(visible) {
  els.summaryEmptyState.classList.toggle("hidden", !visible);
}

const COPY_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">' +
  '<rect x="9" y="9" width="12" height="12" rx="2" stroke-linecap="round" stroke-linejoin="round"/>' +
  '<path d="M5 15V5a2 2 0 012-2h10" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const CHECK_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">' +
  '<path d="M5 13l4 4L19 7" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/**
 * Builds a small hover-reveal "copy" button. `getText` is called at CLICK
 * time (not creation time) so an assistant bubble's copy button always
 * copies whatever is currently rendered, even after the throttled renderer
 * has replaced the bubble's content multiple times during streaming.
 */
function createCopyButton(getText) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "bubble-copy-btn";
  btn.setAttribute("aria-label", "Copy message");
  btn.title = "Copy message";
  btn.innerHTML = COPY_ICON;
  btn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(getText());
      btn.innerHTML = CHECK_ICON;
      btn.classList.add("is-copied");
      setTimeout(() => {
        btn.innerHTML = COPY_ICON;
        btn.classList.remove("is-copied");
      }, 1500);
    } catch (_) {
      // Clipboard API can fail (permissions, insecure context) — a copy
      // button is low-stakes enough to fail quietly rather than interrupt
      // the conversation with a toast.
    }
  });
  return btn;
}

export function appendChatUserMessage(text) {
  els.chatEmptyState.classList.add("hidden");
  const row = document.createElement("div");
  row.className = "bubble-row bubble-row--mine";
  const bubble = document.createElement("div");
  bubble.className = "bubble bubble--mine";
  bubble.textContent = text;
  row.appendChild(bubble);
  row.appendChild(createCopyButton(() => text));
  els.chatLog.appendChild(row);
  els.chatLog.scrollTop = els.chatLog.scrollHeight;
}

export function createChatAssistantBubble() {
  els.chatEmptyState.classList.add("hidden");
  const row = document.createElement("div");
  row.className = "bubble-row bubble-row--theirs";
  const bubble = document.createElement("div");
  bubble.className = "bubble bubble--theirs";
  row.appendChild(bubble);
  // .innerText (not .textContent) so the copy preserves the reader's visual
  // line breaks/paragraph spacing from the rendered markdown, rather than
  // smashing block-level content together with no separation.
  row.appendChild(createCopyButton(() => bubble.innerText));
  els.chatLog.appendChild(row);
  els.chatLog.scrollTop = els.chatLog.scrollHeight;
  return bubble;
}

/** Renders the predefined quick-prompt chips (content lives in js/chatPrompts.js).
 *  Clicking one populates the chat input for review rather than sending immediately —
 *  a misclick shouldn't be able to fire off an AI call unintentionally. */
function renderChatPromptPresets() {
  els.chatPromptPresets.innerHTML = "";
  CHAT_PROMPT_PRESETS.forEach((preset) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "prompt-chip";
    chip.textContent = preset.label;
    chip.title = preset.prompt;
    chip.addEventListener("click", () => {
      els.chatInput.value = preset.prompt;
      els.chatInput.focus();
    });
    els.chatPromptPresets.appendChild(chip);
  });
}

// ---- Toasts --------------------------------------------------------------

const TOAST_MODIFIERS = ["info", "success", "error"];

export function showToast(message, type = "info", durationMs = 4000) {
  const modifier = TOAST_MODIFIERS.includes(type) ? type : "info";
  const toast = document.createElement("div");
  toast.className = `toast toast--${modifier}`;
  toast.textContent = message;
  els.toastContainer.appendChild(toast);
  setTimeout(() => {
    toast.classList.add("is-leaving");
    setTimeout(() => toast.remove(), 300);
  }, durationMs);
}

// ---- Wiring ----------------------------------------------------------------

/**
 * Caches DOM elements and attaches all event listeners. `handlers` is a map
 * of callback functions supplied by main.js; ui.js never contains business
 * logic itself, only DOM plumbing.
 */
// ---- Resizable panel ---------------------------------------------------------

const SIDEBAR_WIDTH_STORAGE_KEY = "meetingai:sidebarWidth";
const MIN_SIDEBAR_WIDTH = 300;
const MAX_SIDEBAR_WIDTH = 640;
const DEFAULT_SIDEBAR_WIDTH = 400;

function loadSidebarWidth() {
  try {
    const stored = Number(localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY));
    if (stored && stored >= MIN_SIDEBAR_WIDTH && stored <= MAX_SIDEBAR_WIDTH) return stored;
  } catch (_) {
    /* ignore */
  }
  return DEFAULT_SIDEBAR_WIDTH;
}

function applySidebarWidth(px) {
  document.documentElement.style.setProperty("--sidebar-width", `${px}px`);
  try {
    localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(px));
  } catch (_) {
    /* ignore — the width just won't be remembered next time */
  }
}

/** Wires up the draggable divider between the transcript panel and the sidebar.
 *  This is pure display/layout preference (like the theme toggle), so it manages
 *  its own dedicated localStorage key directly rather than going through the
 *  app's settings object in storage.js, which is for actual app configuration. */
function setupPanelResize() {
  const handle = els.panelResizeHandle;
  if (!handle) return;

  applySidebarWidth(loadSidebarWidth());

  let dragging = false;

  function onPointerMove(e) {
    if (!dragging) return;
    const layoutEl = handle.parentElement;
    const containerRight = layoutEl.getBoundingClientRect().right;
    const newWidth = Math.round(containerRight - e.clientX);
    applySidebarWidth(Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, newWidth)));
  }

  function endDrag() {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove("is-dragging");
    document.body.classList.remove("is-resizing-panel");
    document.removeEventListener("pointermove", onPointerMove);
    document.removeEventListener("pointerup", endDrag);
  }

  handle.addEventListener("pointerdown", (e) => {
    dragging = true;
    handle.classList.add("is-dragging");
    document.body.classList.add("is-resizing-panel");
    document.addEventListener("pointermove", onPointerMove);
    document.addEventListener("pointerup", endDrag);
    e.preventDefault();
  });

  // Keyboard accessibility: arrow keys nudge the width in 16px steps.
  handle.addEventListener("keydown", (e) => {
    const current = parseInt(getComputedStyle(document.documentElement).getPropertyValue("--sidebar-width"), 10) || DEFAULT_SIDEBAR_WIDTH;
    if (e.key === "ArrowLeft") {
      applySidebarWidth(Math.min(MAX_SIDEBAR_WIDTH, current + 16));
      e.preventDefault();
    } else if (e.key === "ArrowRight") {
      applySidebarWidth(Math.max(MIN_SIDEBAR_WIDTH, current - 16));
      e.preventDefault();
    }
  });
}

export function bindControls(handlers) {
  cacheElements();
  setupKeyVisibilityToggles();
  setupSettingsTabs();
  setupPanelResize();
  renderChatPromptPresets();

  els.btnStart.addEventListener("click", handlers.onStart);
  els.btnPause.addEventListener("click", handlers.onPause);
  els.btnResume.addEventListener("click", handlers.onResume);
  els.btnStop.addEventListener("click", handlers.onStop);

  els.btnOpenSettings.addEventListener("click", handlers.onOpenSettings);
  els.btnCloseSettings.addEventListener("click", handlers.onCloseSettings);
  els.btnCancelSettings.addEventListener("click", handlers.onCloseSettings);
  els.settingsModal.addEventListener("click", (e) => {
    if (e.target === els.settingsModal) handlers.onCloseSettings();
  });
  els.settingsForm.addEventListener("submit", (e) => {
    e.preventDefault();
    handlers.onSaveSettings();
  });
  els.btnRefreshModels.addEventListener("click", handlers.onRefreshModels);
  els.btnClearStoredData.addEventListener("click", handlers.onClearStoredData);
  els.btnClearApiKeys.addEventListener("click", handlers.onClearApiKeys);
  els.btnClearMeeting.addEventListener("click", handlers.onClearMeeting);

  els.btnExport.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleExportMenu();
  });
  els.btnExportMd.addEventListener("click", () => {
    closeExportMenu();
    handlers.onExportMarkdown();
  });
  els.btnExportTxt.addEventListener("click", () => {
    closeExportMenu();
    handlers.onExportPlainText();
  });
  document.addEventListener("click", (e) => {
    if (!els.exportMenu.contains(e.target) && e.target !== els.btnExport) closeExportMenu();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeExportMenu();
  });
  els.btnDownloadAudio.addEventListener("click", handlers.onDownloadAudio);

  els.tabBtnSummary.addEventListener("click", () => switchSidePanel("summary"));
  els.tabBtnChat.addEventListener("click", () => switchSidePanel("chat"));

  els.btnSummarize.addEventListener("click", handlers.onSummarize);
  els.btnCopySummary.addEventListener("click", handlers.onCopySummary);

  els.chatForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = els.chatInput.value.trim();
    if (!text) return;
    els.chatInput.value = "";
    handlers.onChatSubmit(text);
  });
  els.btnClearChat.addEventListener("click", handlers.onClearChat);

  window.addEventListener("beforeunload", handlers.onBeforeUnload);
}
