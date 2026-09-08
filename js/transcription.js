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
    this._errorReportedSinceLastStart = false; // caps onError to once per problem streak — see onerror/catch below
    this._restartTimer = null;
    this._Ctor = Ctor;
    this._currentInterimText = "";
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
    this._errorReportedSinceLastStart = false;
  }

  start() {
    this._userStopped = false;
    this._paused = false;
    this._restartCount = 0;
    this._hasHeardAnything = false;
    this._errorReportedSinceLastStart = false;
    this._createAndStart();
  }

  /** Detaches the previous recognition instance's listeners and force-stops it,
   *  before a new one is created. Chrome in particular can throw InvalidStateError
   *  if a new instance's start() is called before the browser has fully released
   *  the previous instance's underlying native speech-recognition resource — this
   *  gives it an explicit signal to let go, rather than just hoping the timing
   *  works out. Detaching listeners first also means a stray late event from the
   *  old instance can never affect this channel's state after it's been replaced. */
  _teardownCurrentRecognition() {
    if (!this._recognition) return;
    const rec = this._recognition;
    rec.onresult = null;
    rec.onerror = null;
    rec.onend = null;
    rec.onstart = null;
    try {
      rec.abort();
    } catch (_) {
      /* already stopped/aborted — nothing to clean up */
    }
    this._recognition = null;
  }

  _createAndStart() {
    this._teardownCurrentRecognition();

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
          this._errorReportedSinceLastStart = false; // confirmed healthy — a future problem can be reported again
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
      // just let onend's auto-restart logic take over. Beyond that, cap real
      // errors to ONE toast per problem streak (reset on the next successful
      // start/result) rather than one per retry attempt — with unbounded
      // pre-speech retries, an error that keeps recurring every attempt would
      // otherwise flood the UI exactly as often as it retries.
      if (code !== "no-speech" && !this._errorReportedSinceLastStart) {
        this._errorReportedSinceLastStart = true;
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

      if (!this._hasHeardAnything) {
        // Nothing has been heard yet at all — completely normal at the start
        // of a real meeting (people joining, "can everyone hear me," silence
        // before anyone speaks) and not a sign anything is actually wrong.
        // Restart immediately on a flat base delay, without touching
        // _restartCount or checking any limit, so pre-speech silence can
        // never exhaust the auto-restart budget meant to catch a genuinely
        // broken recognition engine.
        this._restartTimer = setTimeout(() => {
          if (!this._userStopped) this._createAndStart();
        }, RESTART_BACKOFF_BASE_MS);
        return;
      }

      // SpeechRecognition silently stops after periods of silence or fixed
      // browser timeouts even in "continuous" mode — auto-restart with a
      // capped exponential backoff so a flaky mic doesn't spin-loop forever.
      // This strict budget only kicks in once the channel has proven it can
      // actually hear something (see the !this._hasHeardAnything branch above).
      if (this._restartCount >= MAX_AUTO_RESTARTS) {
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
      this._errorReportedSinceLastStart = false; // this instance is confirmed running — clear slate for any future problem
      this.callbacks.onStatusChange({ channel: this.channelId, status: "listening" });
    };

    this._recognition = recognition;
    this._currentInterimText = "";
    try {
      recognition.start();
    } catch (err) {
      // InvalidStateError here is the well-known Chrome race described above
      // _teardownCurrentRecognition() — inherently transient and expected to
      // clear up on its own, so it's logged for developers but never shown to
      // the user, and never counts against any retry budget. Anything else is
      // a genuinely unexpected failure worth surfacing — but still only once
      // per problem streak (see _errorReportedSinceLastStart), since with
      // unbounded pre-speech retries, surfacing it on every single attempt
      // would flood the UI exactly as fast as it retries.
      const isKnownTransientRace = err && err.name === "InvalidStateError";
      if (isKnownTransientRace) {
        console.warn(`[transcription:${this.channelId}] start() hit the known InvalidStateError race — retrying quietly.`, err);
      } else if (!this._errorReportedSinceLastStart) {
        this._errorReportedSinceLastStart = true;
        this.callbacks.onError({
          channel: this.channelId,
          error: new TranscriptionError("Could not start speech recognition.", "unknown", err),
        });
      }

      if (this._userStopped) return;

      if (!this._hasHeardAnything) {
        // Same reasoning as onend's pre-speech branch above: don't burn the
        // restart budget on failures that happen before anything's been heard.
        this._restartTimer = setTimeout(() => {
          if (!this._userStopped) this._createAndStart();
        }, RESTART_BACKOFF_BASE_MS);
      } else if (this._restartCount < MAX_AUTO_RESTARTS) {
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
