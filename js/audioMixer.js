/**
 * audioMixer.js
 * ---------------------------------------------------------------------------
 * Core Audio Engine. Blends Stream A (microphone, via getUserMedia) and
 * Stream B (system / shared-tab audio, via getDisplayMedia) into a single
 * combined MediaStream using the Web Audio API, and exposes per-source
 * level metering for the UI.
 *
 * Honesty note (see transcription.js for the full explanation): the browser's
 * native SpeechRecognition engine cannot accept an arbitrary MediaStream as
 * input on any current browser — it always listens to a device the OS/browser
 * chooses. This module's combined stream is therefore used for level
 * metering and (optionally) local recording/export, while live transcription
 * of "the other side" relies on the user routing system audio to a real
 * input device (a loopback device) that a second SpeechRecognition instance
 * can listen to directly. We don't pretend otherwise here.
 * ---------------------------------------------------------------------------
 */

export class AudioMixerError extends Error {
  constructor(message, code, cause) {
    super(message);
    this.name = "AudioMixerError";
    this.code = code; // 'permission-denied' | 'not-found' | 'not-supported' | 'unknown'
    this.cause = cause;
  }
}

function mapGetUserMediaError(err) {
  const name = err && err.name;
  if (name === "NotAllowedError" || name === "SecurityError") {
    return new AudioMixerError(
      "Microphone permission was denied. Allow microphone access in your browser's site settings and try again.",
      "permission-denied",
      err
    );
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return new AudioMixerError(
      "No matching microphone device was found. Check your input device and try again.",
      "not-found",
      err
    );
  }
  return new AudioMixerError(
    "Could not access the microphone (" + (name || "unknown error") + ").",
    "unknown",
    err
  );
}

function mapGetDisplayMediaError(err) {
  const name = err && err.name;
  if (name === "NotAllowedError") {
    return new AudioMixerError(
      "Screen/tab-audio sharing was cancelled or denied.",
      "permission-denied",
      err
    );
  }
  return new AudioMixerError(
    "Could not capture system audio (" + (name || "unknown error") + "). Some browsers only expose audio when sharing a browser tab, not the whole screen.",
    "unknown",
    err
  );
}

/**
 * Small helper: builds an analyser + a rolling 0..1 level value from a track.
 */
class LevelMeter {
  constructor(audioContext, sourceNode) {
    this.analyser = audioContext.createAnalyser();
    this.analyser.fftSize = 512;
    this.analyser.smoothingTimeConstant = 0.75;
    this._data = new Uint8Array(this.analyser.frequencyBinCount);
    sourceNode.connect(this.analyser);
  }

  read() {
    this.analyser.getByteTimeDomainData(this._data);
    let sumSquares = 0;
    for (let i = 0; i < this._data.length; i++) {
      const centered = (this._data[i] - 128) / 128;
      sumSquares += centered * centered;
    }
    const rms = Math.sqrt(sumSquares / this._data.length);
    // Clamp and apply a light curve so quiet speech is still visible.
    return Math.min(1, rms * 4);
  }

  dispose() {
    try { this.analyser.disconnect(); } catch (_) { /* already disconnected */ }
  }
}

export class AudioMixer {
  constructor() {
    /** @type {AudioContext|null} */
    this.audioContext = null;
    /** @type {MediaStream|null} */
    this.micStream = null;
    /** @type {MediaStream|null} */
    this.systemStream = null;
    /** @type {MediaStreamAudioDestinationNode|null} */
    this.destinationNode = null;

    this._micSourceNode = null;
    this._systemSourceNode = null;
    this._micGainNode = null;
    this._systemGainNode = null;
    this._micMeter = null;
    this._systemMeter = null;

    this.isRunning = false;
  }

  /**
   * Starts the mixer. `systemAudio: false` skips display-media capture
   * entirely (mic-only session).
   * @param {{ micDeviceId?: string, systemAudio: boolean }} options
   */
  async start({ micDeviceId, systemAudio }) {
    if (this.isRunning) {
      throw new AudioMixerError("Audio mixer is already running.", "unknown");
    }

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new AudioMixerError(
        "This browser does not support microphone capture (getUserMedia).",
        "not-supported"
      );
    }

    // --- Stream A: microphone -------------------------------------------------
    try {
      this.micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: micDeviceId ? { exact: micDeviceId } : undefined,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
    } catch (err) {
      throw mapGetUserMediaError(err);
    }

    // --- Stream B: system / tab audio (optional) ------------------------------
    if (systemAudio) {
      if (!navigator.mediaDevices.getDisplayMedia) {
        this._teardownTracksOnly();
        throw new AudioMixerError(
          "This browser does not support system-audio capture (getDisplayMedia).",
          "not-supported"
        );
      }
      try {
        // Chromium requires video:true to be requestable even when only audio
        // is wanted; we drop the video track immediately below.
        this.systemStream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: true,
        });
      } catch (err) {
        // Non-fatal: continue mic-only so the session can still proceed.
        this.systemStream = null;
        this._teardownVideoTracksOnly();
        const mapped = mapGetDisplayMediaError(err);
        mapped.nonFatal = true;
        this._pendingSystemAudioWarning = mapped;
      }

      if (this.systemStream) {
        // We only need the audio track; stop and drop any video track right away.
        this.systemStream.getVideoTracks().forEach((track) => track.stop());
        if (this.systemStream.getAudioTracks().length === 0) {
          this.systemStream.getTracks().forEach((track) => track.stop());
          this.systemStream = null;
          this._pendingSystemAudioWarning = new AudioMixerError(
            "The shared source had no audio track. Re-share and tick \"Share tab audio\" / \"Share system audio\".",
            "not-found"
          );
          this._pendingSystemAudioWarning.nonFatal = true;
        }
      }
    }

    // --- Web Audio graph -------------------------------------------------------
    try {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      this.audioContext = new AudioContextClass();
      this.destinationNode = this.audioContext.createMediaStreamDestination();

      this._micSourceNode = this.audioContext.createMediaStreamSource(this.micStream);
      this._micGainNode = this.audioContext.createGain();
      this._micGainNode.gain.value = 1.0;
      this._micSourceNode.connect(this._micGainNode).connect(this.destinationNode);
      // Tapped *after* the gain node (not the raw source) so the meter visibly
      // drops to zero when setMicMuted(true) is called, instead of continuing
      // to show live input while the UI claims it's muted.
      this._micMeter = new LevelMeter(this.audioContext, this._micGainNode);

      if (this.systemStream) {
        this._systemSourceNode = this.audioContext.createMediaStreamSource(this.systemStream);
        this._systemGainNode = this.audioContext.createGain();
        this._systemGainNode.gain.value = 1.0;
        this._systemSourceNode.connect(this._systemGainNode).connect(this.destinationNode);
        this._systemMeter = new LevelMeter(this.audioContext, this._systemGainNode);
      }
    } catch (err) {
      // getUserMedia/getDisplayMedia already succeeded by this point — without
      // this cleanup, a failure here (e.g. hitting the browser's per-page
      // AudioContext limit) would leak a live, recording microphone with no
      // reference left anywhere to stop it.
      if (this.micStream) { this.micStream.getTracks().forEach((t) => t.stop()); this.micStream = null; }
      if (this.systemStream) { this.systemStream.getTracks().forEach((t) => t.stop()); this.systemStream = null; }
      if (this.audioContext && this.audioContext.state !== "closed") {
        try { await this.audioContext.close(); } catch (_) { /* already closed */ }
      }
      this.audioContext = null;
      throw new AudioMixerError("Could not set up the audio pipeline.", "unknown", err);
    }

    this.isRunning = true;
    return {
      combinedStream: this.destinationNode.stream,
      micStream: this.micStream,
      systemStream: this.systemStream,
      warning: this._pendingSystemAudioWarning || null,
    };
  }

  /** Returns { mic: 0..1, system: 0..1 } instantaneous levels for UI meters. */
  readLevels() {
    return {
      mic: this._micMeter ? this._micMeter.read() : 0,
      system: this._systemMeter ? this._systemMeter.read() : 0,
    };
  }

  setMicMuted(muted) {
    if (this._micGainNode) this._micGainNode.gain.value = muted ? 0 : 1;
  }

  setSystemMuted(muted) {
    if (this._systemGainNode) this._systemGainNode.gain.value = muted ? 0 : 1;
  }

  _teardownVideoTracksOnly() {
    if (this.systemStream) {
      this.systemStream.getVideoTracks().forEach((t) => t.stop());
    }
  }

  _teardownTracksOnly() {
    if (this.micStream) this.micStream.getTracks().forEach((t) => t.stop());
  }

  /**
   * Fully disconnects all Web Audio nodes and stops every underlying
   * hardware track so devices are released and nothing leaks across a long
   * meeting or repeated start/stop cycles.
   */
  async stop() {
    if (this._micMeter) { this._micMeter.dispose(); this._micMeter = null; }
    if (this._systemMeter) { this._systemMeter.dispose(); this._systemMeter = null; }

    [this._micSourceNode, this._micGainNode, this._systemSourceNode, this._systemGainNode, this.destinationNode]
      .forEach((node) => {
        if (!node) return;
        try { node.disconnect(); } catch (_) { /* already disconnected */ }
      });
    this._micSourceNode = null;
    this._micGainNode = null;
    this._systemSourceNode = null;
    this._systemGainNode = null;
    this.destinationNode = null;

    if (this.micStream) {
      this.micStream.getTracks().forEach((t) => t.stop());
      this.micStream = null;
    }
    if (this.systemStream) {
      this.systemStream.getTracks().forEach((t) => t.stop());
      this.systemStream = null;
    }

    if (this.audioContext && this.audioContext.state !== "closed") {
      try { await this.audioContext.close(); } catch (_) { /* already closed */ }
    }
    this.audioContext = null;

    this.isRunning = false;
    this._pendingSystemAudioWarning = null;
  }

  /** Lists available audio input devices. Requires a prior getUserMedia grant to show labels. */
  static async listInputDevices() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return [];
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices.filter((d) => d.kind === "audioinput");
    } catch (_) {
      return [];
    }
  }
}
