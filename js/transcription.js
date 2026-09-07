/**
 * transcription.js
 * ---------------------------------------------------------------------------
 * Wraps the browser's native Web Speech API (SpeechRecognition) to produce
 * real-time, continuous transcription with graceful multi-language handling.
 *
 * IMPORTANT TECHNICAL CONSTRAINT — read before wiring this up:
 * The SpeechRecognition interface has no standard way to accept an arbitrary
 * MediaStream (there is no `.srcObject` / `.stream` property in the spec).
 * It always listens to whatever input device the browser/OS hands it. That
 * means we cannot literally "feed" audioMixer.js's combined stream into this
 * engine. Instead this module supports up to two independent recognition
 * *channels*, each bound to a real input device:
 *   - "mic"    → the user's own microphone (their side of the call)
 *   - "system" → a second input device the user selects — typically a
 *                loopback/virtual-audio device (Stereo Mix, BlackHole,
 *                VB-Audio Cable) that mirrors system/meeting audio — so the
 *                other participant's speech can also be transcribed live.
 * If the user has no loopback device, the "system" channel is simply left
 * disabled and the combined stream from audioMixer.js is still useful for
 * level metering and local recording.
 * ---------------------------------------------------------------------------
 */

const MAX_AUTO_RESTARTS = 6;
// A channel that has never yet heard *anything* (not even an interim result)
// gets a much larger restart budget than one that's already proven it can
// hear speech. Real meetings routinely open with 10-30+ seconds of silence
// (people joining, "can everyone hear me," etc.) — with only the strict
// budget, that silence alone can exhaust all 6 restarts (in well under a
// minute of pure backoff delay) before a single word has been transcribed,
// forcing a manual Stop/Start even though nothing is actually wrong. Once
// the channel proves it can hear something, it drops back to the strict
// budget so a genuinely broken/flaky recognition engine still gives up
// eventually rather than retrying forever.
const MAX_AUTO_RESTARTS_BEFORE_FIRST_RESULT = 20;
const RESTART_BACKOFF_BASE_MS = 400;

export class TranscriptionError extends Error {
  constructor(message, code, cause) {
    super(message);
    this.name = "TranscriptionError";
    this.code = code; // 'not-supported' | 'permission-denied' | 'no-speech' | 'audio-capture' | 'network' | 'aborted' | 'unknown'
    this.cause = cause;
  }
}

function getRecognitionCtor() {
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

export function isSpeechRecognitionSupported() {
  return !!getRecognitionCtor();
}

/**
 * One independent recognition channel (e.g. "mic" or "system").
 * Emits events via the callbacks passed to the constructor:
 *   onResult({ channel, text, isFinal, timestamp })
 *   onError({ channel, error })
 *   onStatusChange({ channel, status })  status: 'listening' | 'stopped'
 */
export class TranscriptionChannel {
  /**
   * @param {string} channelId
   * @param {{ language: string, deviceLabelHint?: string }} config
   * @param {{ onResult: Function, onError: Function, onStatusChange: Function }} callbacks
   */
  constructor(channelId, config, callbacks) {
    const Ctor = getRecognitionCtor();
    if (!Ctor) {
      throw new TranscriptionError(
        "This browser does not support the Web Speech API. Try Chrome or Edge.",
        "not-supported"
      );
    }
    this.channelId = channelId;
    this.language = config.language || "en-US";
    this.callbacks = callbacks;
    this._recognition = null;
    this._userStopped = false;
    this._paused = false;
    this._restartCount = 0;
    this._hasHeardAnything = false; // true once any result (interim or final) has ever arrived
    this._restartTimer = null;
    this._Ctor = Ctor;
    this._currentInterimText = "";
  }

  /** The restart budget currently in effect — generous before this channel has proven
   *  it can hear anything at all, strict afterward (see the constant's comment above). */
  _currentRestartLimit() {
    return this._hasHeardAnything ? MAX_AUTO_RESTARTS : MAX_AUTO_RESTARTS_BEFORE_FIRST_RESULT;
  }

  setLanguage(lang) {
    this.language = lang;
    if (this._recognition) {
      // Language changes only take effect on the next start() cycle.
      this._recognition.lang = lang;
    }
  }

  /**
   * Pausing does NOT stop/restart the underlying SpeechRecognition instance
   * (tearing one down mid-utterance is flaky across browsers and would lose
   * whatever's mid-flight). Instead it just discards results at the source
   * so nothing new reaches the transcript while paused, and clears any
   * dangling interim text so resuming starts clean.
   */
  pause() {
    this._paused = true;
    this._currentInterimText = "";
  }

  resume() {
    this._paused = false;
    this._restartCount = 0; // clean baseline — restarts during the pause never counted anyway (see onend)
  }

  start() {
    this._userStopped = false;
    this._paused = false;
    this._restartCount = 0;
    this._hasHeardAnything = false;
    this._createAndStart();
  }

  _createAndStart() {
    const recognition = new this._Ctor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = this.language;
    recognition.maxAlternatives = 1;

    recognition.onresult = (event) => {
      this._hasHeardAnything = true;
      if (this._paused) return;
      let interimText = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const transcriptPiece = result[0].transcript;
        if (result.isFinal) {
          this._restartCount = 0; // healthy stream resets backoff
          this.callbacks.onResult({
            channel: this.channelId,
            text: transcriptPiece.trim(),
            isFinal: true,
            timestamp: Date.now(),
          });
        } else {
          interimText += transcriptPiece;
        }
      }
      if (interimText && interimText !== this._currentInterimText) {
        this._currentInterimText = interimText;
        this.callbacks.onResult({
          channel: this.channelId,
          text: interimText.trim(),
          isFinal: false,
          timestamp: Date.now(),
        });
      }
    };

    recognition.onerror = (event) => {
      const code = mapRecognitionErrorCode(event.error);
      // "no-speech" is routine (the user paused) — do not surface as a hard error,
      // just let onend's auto-restart logic take over.
      if (code !== "no-speech") {
        this.callbacks.onError({
          channel: this.channelId,
          error: new TranscriptionError(describeRecognitionError(event.error), code, event),
        });
      }
    };

    recognition.onend = () => {
      this.callbacks.onStatusChange({ channel: this.channelId, status: "stopped" });
      if (this._userStopped) return;

      if (this._paused) {
        // Restart quietly on a fixed short delay without touching
        // _restartCount — this is an intentional pause (e.g. a break), not
        // a failure signal, and onresult() discards results while paused
        // anyway (see above), so it should never be able to exhaust the
        // auto-restart limit no matter how long the pause lasts.
        this._restartTimer = setTimeout(() => {
          if (!this._userStopped) this._createAndStart();
        }, RESTART_BACKOFF_BASE_MS);
        return;
      }

      // SpeechRecognition silently stops after periods of silence or fixed
      // browser timeouts even in "continuous" mode — auto-restart with a
      // capped exponential backoff so a flaky mic doesn't spin-loop forever.
      if (this._restartCount >= this._currentRestartLimit()) {
        this.callbacks.onError({
          channel: this.channelId,
          error: new TranscriptionError(
            "Speech recognition stopped repeatedly and hit its auto-restart limit. Press Start to resume.",
            "aborted"
          ),
        });
        return;
      }
      const delay = RESTART_BACKOFF_BASE_MS * Math.pow(1.6, this._restartCount);
      this._restartCount += 1;
      this._restartTimer = setTimeout(() => {
        if (!this._userStopped) this._createAndStart();
      }, delay);
    };

    recognition.onstart = () => {
      this.callbacks.onStatusChange({ channel: this.channelId, status: "listening" });
    };

    this._recognition = recognition;
    this._currentInterimText = "";
    try {
      recognition.start();
    } catch (err) {
      // start() throws synchronously if called while already running (a real,
      // documented Chrome quirk from rapid state transitions). Unlike onerror/
      // onend, onend never fires for a synchronous throw — so without an
      // explicit retry here, this channel would go permanently silent after
      // one transient failure with no auto-recovery at all.
      this.callbacks.onError({
        channel: this.channelId,
        error: new TranscriptionError("Could not start speech recognition.", "unknown", err),
      });
      if (!this._userStopped && this._restartCount < this._currentRestartLimit()) {
        const delay = RESTART_BACKOFF_BASE_MS * Math.pow(1.6, this._restartCount);
        this._restartCount += 1;
        this._restartTimer = setTimeout(() => {
          if (!this._userStopped) this._createAndStart();
        }, delay);
      }
    }
  }

  stop() {
    this._userStopped = true;
    if (this._restartTimer) {
      clearTimeout(this._restartTimer);
      this._restartTimer = null;
    }
    if (this._recognition) {
      try { this._recognition.stop(); } catch (_) { /* already stopped */ }
    }
  }
}

function mapRecognitionErrorCode(rawError) {
  switch (rawError) {
    case "not-allowed":
    case "service-not-allowed":
      return "permission-denied";
    case "no-speech":
      return "no-speech";
    case "audio-capture":
      return "audio-capture";
    case "network":
      return "network";
    case "aborted":
      return "aborted";
    default:
      return "unknown";
  }
}

function describeRecognitionError(rawError) {
  switch (rawError) {
    case "not-allowed":
    case "service-not-allowed":
      return "Microphone permission for speech recognition was denied.";
    case "audio-capture":
      return "No audio could be captured from the selected input device.";
    case "network":
      return "The browser's speech recognition service is unreachable (network issue).";
    default:
      return "Speech recognition error: " + rawError;
  }
}

/**
 * Coordinates up to two TranscriptionChannel instances ("mic" and "system")
 * so the rest of the app can treat transcription as one logical unit.
 */
export class TranscriptionController {
  constructor(callbacks) {
    this.callbacks = callbacks; // { onResult, onError, onStatusChange }
    this.channels = {};
  }

  /**
   * @param {{ mic: {language:string}, system?: {language:string} }} config
   */
  start(config) {
    if (!isSpeechRecognitionSupported()) {
      throw new TranscriptionError(
        "This browser does not support the Web Speech API. Try Chrome or Edge.",
        "not-supported"
      );
    }
    this.channels.mic = new TranscriptionChannel("mic", config.mic, this.callbacks);
    this.channels.mic.start();

    if (config.system) {
      this.channels.system = new TranscriptionChannel("system", config.system, this.callbacks);
      this.channels.system.start();
    }
  }

  setLanguage(channelId, lang) {
    if (this.channels[channelId]) this.channels[channelId].setLanguage(lang);
  }

  pauseAll() {
    Object.values(this.channels).forEach((ch) => ch.pause());
  }

  resumeAll() {
    Object.values(this.channels).forEach((ch) => ch.resume());
  }

  stopAll() {
    Object.values(this.channels).forEach((ch) => ch.stop());
    this.channels = {};
  }
}
