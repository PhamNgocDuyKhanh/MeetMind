/**
 * transcription.js
 * ---------------------------------------------------------------------------
 * Wraps the browser's native Web Speech API (SpeechRecognition) to produce
 * real-time, continuous transcription with graceful multi-language handling.
 *
 * IMPORTANT TECHNICAL CONSTRAINT:
 * The SpeechRecognition interface has no standard way to accept an arbitrary
 * MediaStream (there is no `.srcObject` / `.stream` property in the spec).
 * It always listens to whatever input device the browser/OS hands it.
 * This module supports up to two independent recognition channels ("mic" and "system").
 * ---------------------------------------------------------------------------
 */

const RESTART_BACKOFF_BASE_MS = 600;

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
    this._hasAudioStarted = false; // Tracks if valid speech/audio signal was ever received
    this._restartCount = 0;
    this._restartTimer = null;
    this._Ctor = Ctor;
    this._currentInterimText = "";
  }

  setLanguage(lang) {
    this.language = lang;
    if (this._recognition) {
      // Language changes take effect on the next recognition cycle
      this._recognition.lang = lang;
    }
  }

  pause() {
    this._paused = true;
    this._currentInterimText = "";
  }

  resume() {
    this._paused = false;
    this._restartCount = 0; // Clean baseline for user unpause
  }

  start() {
    this._userStopped = false;
    this._paused = false;
    this._hasAudioStarted = false;
    this._restartCount = 0;
    this._clearTimer();
    this._createAndStart();
  }

  _clearTimer() {
    if (this._restartTimer) {
      clearTimeout(this._restartTimer);
      this._restartTimer = null;
    }
  }

  _createAndStart() {
    if (this._userStopped) return;

    // Teardown any existing recognition instance to prevent listener leaks or duplicate sessions
    if (this._recognition) {
      try {
        this._recognition.onresult = null;
        this._recognition.onerror = null;
        this._recognition.onend = null;
        this._recognition.onstart = null;
        this._recognition.abort();
      } catch (_) {
        /* ignore cleanup errors */
      }
      this._recognition = null;
    }

    const recognition = new this._Ctor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = this.language;
    recognition.maxAlternatives = 1;

    recognition.onresult = (event) => {
      if (this._paused) return;
      this._restartCount = 0; // Healthy stream resets auto-restart backoff
      this._hasAudioStarted = true;

      let interimText = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const transcriptPiece = result[0].transcript;
        if (result.isFinal) {
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

      // CRITICAL: "no-speech" and "aborted" are routine browser events during silence or restarts.
      // Do NOT bubble them up to UI error callbacks to prevent UI error spam.
      if (code === "no-speech" || code === "aborted") {
        console.warn(`[Transcription:${this.channelId}] Transient condition (${event.error}), auto-recovering silently.`);
        return;
      }

      // Only report actionable, hard failure errors to the UI layer
      this.callbacks.onError({
        channel: this.channelId,
        error: new TranscriptionError(describeRecognitionError(event.error), code, event),
      });
    };

    recognition.onend = () => {
      this.callbacks.onStatusChange({ channel: this.channelId, status: "stopped" });
      if (this._userStopped) return;

      // Allow higher restart ceiling if channel actively received audio during session.
      // Otherwise cap at 15 attempts if device never captured audio signal.
      const maxAllowedRestarts = this._hasAudioStarted ? 9999 : 15;

      if (this._restartCount >= maxAllowedRestarts) {
        this.callbacks.onError({
          channel: this.channelId,
          error: new TranscriptionError(
            "Speech recognition stopped repeatedly. Please check audio device and press Start.",
            "aborted"
          ),
        });
        return;
      }

      // Exponential backoff to prevent continuous CPU spinning on silent disconnects
      const delay = Math.min(RESTART_BACKOFF_BASE_MS * Math.pow(1.3, Math.min(this._restartCount, 10)), 5000);
      this._restartCount += 1;

      this._clearTimer();
      this._restartTimer = setTimeout(() => {
        this._createAndStart();
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
      // Chrome throws synchronously if start() is called during rapid state transitions.
      // Silently schedule a retry backoff instead of emitting a noisy UI error popup.
      if (!this._userStopped) {
        this._clearTimer();
        this._restartTimer = setTimeout(() => {
          this._createAndStart();
        }, 1000);
      }
    }
  }

  stop() {
    this._userStopped = true;
    this._clearTimer();
    if (this._recognition) {
      try {
        this._recognition.onresult = null;
        this._recognition.onerror = null;
        this._recognition.onend = null;
        this._recognition.abort();
      } catch (_) {
        /* ignore stop errors */
      }
      this._recognition = null;
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
    this.callbacks = callbacks;
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
    this.stopAll(); // Ensure clean state before starting new session

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
