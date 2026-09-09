# Meeting AI Assistant

A private, **100% client-side** meeting assistant: live transcription, AI-generated summaries, and transcript-grounded chat — all running directly in the browser, with no backend and no build step. Designed to be cloned and hosted for free on **GitHub Pages**.

Bring your own Gemini and/or Groq API key. Nothing you say, type, or paste ever touches a server other than Google's or Groq's own APIs.

---

## Table of Contents

- [Key Features](#key-features)
- [Architectural Overview](#architectural-overview)
- [Setup & Configuration](#setup--configuration)
- [Deployment (GitHub Pages)](#deployment-github-pages)
- [Maintenance Notes & Guidelines](#maintenance-notes--guidelines)
- [Known Limitations](#known-limitations)
- [License](#license)

---

## Key Features

**Transcription & meeting flow**
- **Live transcription** via the browser's native Web Speech API — no audio ever leaves your machine for transcription itself.
- **Dual audio channels**: your microphone ("Me") and, optionally, the meeting/system audio ("Others") — see [Setup & Configuration](#system-audio-loopback-capturing-remote-participants) for the caveats around the second channel.
- **Elapsed-time timer** next to the status indicator — runs on wall-clock time from the moment a meeting starts (kept deliberately in sync with the exported transcript's own elapsed timestamps), freezes at the final duration on Stop.
- **Resizable layout** — drag the divider between the transcript and the sidebar to resize either side, same idea as Claude's own resizable side panel. Remembered across sessions.
- **Explicit "Clear"** action to wipe the screen and start fresh between meetings without reloading the page.

**AI summaries & chat**
- **AI summaries & chat**, grounded in the live transcript, powered by **Gemini** with **Groq** as an automatic fallback.
- **Intelligent failover chain** on rate limits or errors: same key with a lighter model → secondary Gemini key → Groq — with no artificial retry delay.
- **Engine Status panel**: live view of which model answered, latency, and how many times the app has had to fall back.
- **Predefined quick-prompt chips** in the Chat panel (follow-up questions, list interview questions, evaluate a candidate, etc.) — content lives in its own small data file, so adding one is a one-line change (see [Architectural Overview](#architectural-overview)).
- **Per-message copy buttons** on every chat bubble.
- **Capped chat history** sent to the AI (most recent ~10 messages) so a long back-and-forth can't blow past a model's context window — the full conversation still stays visible on screen either way.
- **Clear chat** control, independent of clearing the meeting itself.

**Data, exports & privacy**
- **Reload-safe**: your transcript and any generated summary are recovered automatically if the tab reloads or crashes mid-meeting (recorded audio itself is not recoverable this way).
- **Professional exports**: `.md` / `.txt` with a metadata header, `[HH:MM:SS]` elapsed timestamps per line, and clear speaker labels.
- **Local audio recording** with one-click download — the downloaded WebM file has its duration metadata patched in-browser (no external library) specifically so it can be seeked and played back at different speeds, which raw `MediaRecorder` output can't do out of the box.
- **Separate "Clear saved API keys" and "Clear transcript recovery data"** controls in Settings, so you can wipe one without touching the other.

**Everything else**
- **Light / dark theme**, matching your OS by default, togglable and remembered.
- **No backend, no database, no build pipeline** — plain HTML/CSS/JS, deployable as static files.

---

## Architectural Overview

The app is intentionally built with **strict separation of concerns** and **zero external JS frameworks** — just native ES modules (`import`/`export`), loaded directly by the browser.

```
index.html            Markup shell only — no inline business logic
css/style.css          Design system: CSS custom properties, light + dark themes

js/main.js             Orchestrator — owns app state and the meeting lifecycle
                        (start → pause/resume → stop → summarize/chat/export).
                        The only file that "knows the whole story."

js/ui.js                DOM rendering, event binding, and UI state only.
                        Contains no business logic and never calls storage/AI
                        APIs directly — main.js is the only thing that calls it.

js/ai.js                All communication with Gemini and Groq: dynamic model
                        discovery, streaming responses, and the failover chain.
                        Has no knowledge of the DOM.

js/storage.js           Owns all persisted/exportable data: settings
                        (localStorage), the in-memory meeting session
                        (transcript, summary, recorded audio blob), the
                        .md/.txt export file generation, and the WebM
                        duration-metadata patch applied before a recording
                        is handed off for download. No DOM access.

js/chatPrompts.js       Predefined quick-prompt presets shown as chips in the
                        Chat panel — a plain data array and nothing else.
                        Kept separate specifically so adding, editing, or
                        reordering a preset never requires touching rendering
                        (ui.js) or orchestration (main.js) logic.

js/audioMixer.js        Web Audio API layer: merges mic + tab/system audio for
                        level metering and local recording. Originally
                        provided as a finished module — treat its internal
                        logic as stable/"don't touch" unless you're
                        intentionally revisiting the audio pipeline.

js/transcription.js     Wraps the native SpeechRecognition API as two
                        independent channels ("mic" and "system"). Also
                        originally provided as a finished module, with one
                        narrow, deliberate fix applied since (see Maintenance
                        Notes below) — see its header comment for an honest
                        explanation of what the Web Speech API can and can't do.

assets/                 Static assets (favicon, future icons/images).
```

**Dependency direction** (who imports whom):

```
main.js  →  ui.js, ai.js, storage.js, audioMixer.js, transcription.js
ui.js    →  chatPrompts.js (data only — no logic flows back the other way)
ai.js    →  (nothing else — pure fetch/streaming logic)
storage.js → (nothing else — pure data/localStorage logic)
```

If you're adding a feature and aren't sure where it belongs, this table should settle it:

| You want to... | Edit this file |
|---|---|
| Change the AI failover order, add a provider, adjust prompts | `js/ai.js` |
| Change what gets exported, or the export file format | `js/storage.js` |
| Change what's persisted across a reload | `js/storage.js` |
| Add/edit a quick-prompt chip in the Chat panel | `js/chatPrompts.js` |
| Add/change a DOM element, button, or visual state | `js/ui.js` + `index.html` |
| Change the sequence of a meeting (start/stop/summarize logic) | `js/main.js` |
| Change colors, spacing, typography, dark mode | `css/style.css` |
| Add a new static asset (icon, image) | `assets/` |

---

## Setup & Configuration

### Prerequisites

- **Chrome or Edge** (desktop). Live transcription depends on the Web Speech API, which is currently only implemented in Chromium-based browsers — Safari and Firefox will show an "unsupported" banner.
- A **Gemini API key** (free tier available at [aistudio.google.com/apikey](https://aistudio.google.com/apikey)).
- Optionally, a **secondary Gemini key** (different project, for the failover chain) and/or a **Groq API key** ([console.groq.com](https://console.groq.com)) as a further fallback.

### First-time configuration

1. Open the app and click the gear icon (Settings).
2. Paste your primary Gemini key, click **Refresh** to pull the live model list, and pick a model (or type one manually if the fetch fails).
3. Optionally add a secondary Gemini key and/or a Groq key + fallback model.
4. Pick your speaking language ("Your language") — includes English (US/UK), Spanish, French, German, Portuguese (BR), Hindi, Japanese, Chinese (Simplified), and Vietnamese.
5. Save. Everything is stored in this browser's `localStorage` only — see the in-app privacy notice for exactly what's stored and why, and use the "Clear saved API keys" / "Clear transcript recovery data" buttons in Settings if you want to wipe either independently.

### Running locally (before deploying)

Because `main.js` uses native ES modules, opening `index.html` directly via `file://` will fail with a CORS-style error the moment it tries to `import` another module — this is a browser restriction on module imports, not a bug. Serve the folder over `http://` instead:

```bash
# Python (usually already installed)
python3 -m http.server 8000

# or Node
npx serve .
```

Then open `http://localhost:8000`. Once deployed to GitHub Pages (served over `https://`), this restriction doesn't apply and no local server is needed.

### System audio ("loopback") — capturing remote participants

This is the single most misunderstood part of the setup, so read this before enabling it.

**The limitation:** browsers give a web page no way to choose *which* input device the Web Speech API listens to — it always uses whatever the operating system currently has set as the default input. There is no API for a page to say "listen to this specific virtual device and my microphone as two separate things." Both of the app's recognition channels are, at the OS level, at the mercy of the same "default input" setting.

**What this means in practice:** to get *any* transcription of the other participants' voices, you need to route your computer's audio *output* (what you hear from the meeting) into an *input* device, and make the OS treat that as the default input — a "loopback." This is a genuine, if slightly fiddly, workaround, and it does not cleanly give you two independent channels the way the UI's "Me" / "Others" labels might imply. For most people, transcribing just your own mic is simpler and fully reliable; treat the system-audio channel as a best-effort, advanced feature.

If you want to try it anyway:

**macOS — BlackHole**
1. Install [BlackHole (2ch)](https://existential.audio/blackhole/) — a free virtual audio driver.
2. In **Audio MIDI Setup**, create a **Multi-Output Device** combining your speakers/headphones with BlackHole, so you still hear the meeting while a copy is routed to BlackHole.
3. Set that Multi-Output Device as your system's audio **output**.
4. Set **BlackHole** as your system's default audio **input**.
5. In the app's Settings, enable "Also transcribe meeting/system audio," then start the meeting.

**Windows — VB-Audio Virtual Cable**
1. Install [VB-CABLE](https://vb-audio.com/Cable/) — a free virtual audio driver.
2. Set your system playback device to **CABLE Input** (or use the driver's "Listen to this device" option on **CABLE Output** so you can still hear it directly).
3. Set **CABLE Output** as your default recording/input device.
4. Enable the same Settings toggle before starting.

Both platforms have per-application audio-routing tools (e.g. Windows' per-app volume/output mixer, or third-party utilities) that get closer to genuinely separating "my mic" from "their audio" — outside the scope of this README, but worth searching for if you need it reliably.

---

## Deployment (GitHub Pages)

The app is fully static — no build step, no environment variables, no server-side config. Deployment is just "put the files on Pages":

1. Push this repository to GitHub.
2. In the repo, go to **Settings → Pages**.
3. Under **Build and deployment → Source**, choose **Deploy from a branch**.
4. Choose your branch (e.g. `main`) and the **`/ (root)`** folder, then **Save**.
5. Wait a minute for GitHub to build the site, then visit `https://<your-username>.github.io/<repo-name>/`.
6. (Optional) Add a custom domain via **Settings → Pages → Custom domain**, which creates a `CNAME` file in the repo root for you.

That's it — no GitHub Actions workflow is required for this project as it stands. GitHub Pages serves everything over HTTPS automatically, which also satisfies the browser's "secure context" requirement for microphone and screen-share permissions.

---

## Maintenance Notes & Guidelines

A few things worth knowing before making changes, so behavior doesn't quietly regress:

- **Keep the module boundaries strict.** `ui.js` should never read `localStorage` or call `fetch`; `storage.js` and `ai.js` should never touch `document`. This is what makes the codebase easy to reason about — if a change starts crossing these lines, it's usually a sign the change belongs in a different file.
- **No build tooling, on purpose.** The lack of bundler/transpiler is a deliberate choice for GitHub Pages simplicity and long-term maintainability by anyone who opens the repo cold. Think carefully before introducing one.
- **`js/audioMixer.js` and `js/transcription.js`** were originally provided as finished modules and contain their own detailed header comments explaining real browser limitations (see the system-audio note above). `audioMixer.js` remains untouched. `transcription.js` has since had one narrow, deliberate fix applied on top: a channel that hasn't yet heard *any* speech gets a much larger auto-restart budget than one that has, because real meetings routinely open with silence that used to exhaust the strict retry budget before a single word was ever transcribed. Everything else about its design is unchanged. Treat further changes to either file with the same caution as before: read the existing comments fully before touching anything, and keep any fix as narrow as possible.
- **API keys and meeting content are both stored in plaintext `localStorage`.** This is disclosed in-app. There is no encryption layer, by design, since there's no backend to hold a decryption key either. Don't add a feature that assumes otherwise.
- **Browser support is Chrome/Edge only**, gated on the Web Speech API. Any change that assumes Firefox/Safari support for live transcription is a dead end until/unless those vendors ship it.
- **Testing changes locally always requires a static server**, never `file://` — see [Running locally](#running-locally-before-deploying).
- **One meeting at a time, per tab.** There's no multi-session or history browser; starting a new meeting (or using the explicit "Clear" action) wipes the previous one's transcript/chat/summary from view and from storage. See [Known Limitations](#known-limitations).
- **The resizable-panel width and the theme choice are both pure UI preferences**, stored under their own dedicated `localStorage` keys directly in `ui.js` / an inline script in `index.html` — deliberately *not* routed through `storage.js`'s settings object, which is reserved for actual app configuration (keys, languages, etc.). Follow that same pattern for any future display-only preference.

---

## Known Limitations

- The "system audio" channel is a best-effort workaround, not a true two-speaker separation — see the dedicated section above.
- Reload recovery covers the transcript and summary text only; a recorded audio file cannot be recovered after a reload (Blobs don't survive `localStorage` serialization).
- Chat history sent to the AI is capped to the most recent ~10 messages, to keep API payloads well under any size limit — very old turns in a long chat session won't be part of the AI's context, though they remain visible on screen.
- No multi-meeting history — only the current/most recent meeting's data is kept at a time.
- No collaborative/multi-user features; this is a single-browser, single-user tool by design.

---

## License

MIT — see [`LICENSE`](./LICENSE).
