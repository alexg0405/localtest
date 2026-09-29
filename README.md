# Roomside

A desktop-sized, memory-only interview practice copilot prototype. It uses only the secondary device's microphone when **Start listening** is explicitly pressed. Use it for practice or when live AI assistance is explicitly permitted.

## Run

Install Node.js 20+ and npm, then double-click `run.command` on macOS, or run `./run.sh` in a terminal. The first run installs dependencies and opens the app in your browser. You can also run `npm install` and `npm start`. The development server listens on this computer only (`127.0.0.1`). Use a browser with Web Speech API support (Chrome is recommended). Browser speech recognition availability and audio processing depend on the browser and its provider.

## Desktop app

The Tauri 2 shell is scaffolded as an installable desktop app, including a Roomside app icon. On macOS, install Xcode Command Line Tools, Node.js 20+, and Rust, then double-click `desktop.command` (or run `npm install` followed by `npm run desktop`). `npm run desktop:build` creates a release bundle. Windows needs the Microsoft C++ Build Tools and WebView2; Linux needs the Tauri WebKitGTK build dependencies. The shell requests microphone permission with a clear macOS usage description. If the system webview does not expose its speech recognition API, use the browser launcher or type questions manually.

If macOS blocks the microphone, open the site in Chrome and allow microphone access for `127.0.0.1` in the address bar/site settings. If speech recognition is unavailable or network speech processing is disabled, type the question in the manual field. For model errors, confirm the endpoint and model name, then verify that the endpoint accepts browser CORS requests.

## Tests

Run `npm test` for the Vitest unit tests (they need Node.js 22.12 or newer). They cover question detection, answer formatting, the OpenAI-compatible and demo answer providers (with `fetch` mocked), Deepgram message handling, and how browser speech recognition starts, restarts, and fails.

## Providers

- **Speech recognition:** choose the browser's built-in `SpeechRecognition` / `webkitSpeechRecognition` adapter, or select Deepgram streaming and enter an API key in Settings. Both run through a replaceable `SpeechToTextProvider` interface. The local Web Audio meter detects room voice activity to confirm the mic is picking up sound; it does not record or transmit audio itself. Browser transcription may use its speech service; Deepgram mode streams microphone audio directly to Deepgram. The API key stays in memory and is sent in the WebSocket handshake, not its URL.
- Use **Test transcription connection** to verify Deepgram access without turning on the microphone or sending audio.
- Select a transcription language in Settings (English, Spanish, French, German, Brazilian Portuguese, Japanese, or Mandarin Chinese). Connected AI providers are prompted to answer in the question's language; offline demo responses use English sample content.
- In Deepgram mode, **Detect microphones** lists inputs after you explicitly grant mic permission; choose the room mic or keep System default. Browser built-in recognition uses the operating system's default microphone.
- **Answer generation:** works offline with streaming demo answers. To use a model, open Settings and configure an OpenAI-compatible chat completions endpoint, model, and optional API key. Answers stream as server-sent events; endpoints that reply with a single JSON response also work, and models that only accept their default temperature are retried without one. Requests go only to the endpoint you enter. Keys and transcripts remain in page memory and are cleared on refresh/close. The endpoint must allow browser cross-origin requests (CORS).

## Controls

- Start / Stop Listening: start or stop recognition; Escape stops listening (or closes Settings). Words still being recognized when you stop are kept in the transcript.
- Type a question and press Enter (or `⌘/Ctrl + Enter` from anywhere) to submit it.
- Clear context removes the transcript and current answer without stopping the microphone.
- Choose Short, Standard, Detailed, or Bullets for all answers. The quick actions are one-off requests for a shorter, expanded, or likely follow-up answer and keep the selected mode; the response header shows which mode produced the current answer.
- Pin the current answer to keep a snapshot while exploring other responses (pinning another answer replaces it); Restore brings the pinned answer back.
- Read aloud is available when the microphone is off, so the app does not transcribe its own voice.
- Add optional résumé/background details in Settings; these are included as context only for the current page session.
- Use **Test connection** in Settings to check a remote provider before starting. It sends a small test prompt to the configured endpoint.
- `⌘ + Shift + Space` on macOS (`⌘ + Space` opens Spotlight) or `Ctrl + Space` elsewhere toggles listening, `Escape` stops, `⌘/Ctrl + 1` requests a short answer, `⌘/Ctrl + 2` requests a detailed answer, and `⌘/Ctrl + P` pins/unpins the current answer. Shortcuts are paused while Settings is open.
- Enable **Clear transcript when stopping** in Settings to discard transcript and answer context when ending microphone listening.

## Current scope

The desktop shell is scaffolded but has not been compiled or packaged in this environment. Recognition uses browser interim/final events and provider-specific behavior; question detection is heuristic (it recognizes spoken lead-ins such as “so, what…” and question cues for each supported language, since browser recognition adds no punctuation), starts a debounced draft from likely question partials, keeps that draft when the final wording matches, and otherwise revises from the final speech segment. Low browser confidence is surfaced as “Possible question.” Manual Question is available when recognition is unavailable. The web app type-checks and builds with Node.js 24; desktop builds also require Rust, which has not been installed here.
