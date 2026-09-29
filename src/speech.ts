export type SpeechResult = { text: string; confidence?: number };
export interface SpeechCallbacks {
  onFinal(result: SpeechResult): void;
  onInterim(text: string): void;
  onError(message: string, permissionDenied?: boolean): void;
  onListening(listening: boolean): void;
  onVoiceActivity(active: boolean): void;
  /** Non-fatal information, such as falling back from on-device recognition. */
  onNotice?(message: string): void;
}
export interface SpeechToTextProvider {
  start(callbacks: SpeechCallbacks): Promise<void>;
  stop(): void;
  /** Drops words the recognizer is still holding, so cleared context does not reappear. */
  reset?(): void;
}

class MicrophoneInput {
  stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private frame = 0;
  private active = true;
  private voiced = false;
  constructor(private deviceId = '') {}

  async start(onVoiceActivity: (active: boolean) => void) {
    const AudioContextConstructor = window.AudioContext || (window as any).webkitAudioContext;
    if (AudioContextConstructor) {
      const context: AudioContext = new AudioContextConstructor(); this.context = context;
      // Chrome can hold audio until the page is clicked, which never happens when the phone mirror starts listening.
      // Recognition does not need it (only the voice meter does), so continue and resume on the next click or key press.
      await Promise.race([context.resume(), new Promise(resolve => setTimeout(resolve, 500))]);
      if (context.state !== 'running') for (const type of ['pointerdown', 'keydown']) window.addEventListener(type, () => { if (context.state === 'suspended') void context.resume().catch(() => undefined); }, { once: true });
    }
    if (!this.active) return;
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser cannot access a microphone here. Open Roomside on localhost or use Manual Question.');
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, ...(this.deviceId ? { deviceId: { exact: this.deviceId } } : {}) } });
    if (!this.active) { this.release(); return; }
    if (!this.context) return;
    const source = this.context.createMediaStreamSource(this.stream);
    const analyser = this.context.createAnalyser(); analyser.fftSize = 1024; analyser.smoothingTimeConstant = 0.2; source.connect(analyser);
    const samples = new Float32Array(analyser.fftSize); let previousUpdate = 0;
    const meter = (time: number) => {
      if (!this.active) return;
      if (time - previousUpdate > 75) {
        previousUpdate = time; analyser.getFloatTimeDomainData(samples);
        let sum = 0; for (const sample of samples) sum += sample * sample;
        const detected = Math.sqrt(sum / samples.length) > 0.018;
        if (detected !== this.voiced) { this.voiced = detected; onVoiceActivity(detected); }
      }
      this.frame = requestAnimationFrame(meter);
    };
    this.frame = requestAnimationFrame(meter);
  }

  private release() {
    if (this.frame) cancelAnimationFrame(this.frame); this.frame = 0;
    this.stream?.getTracks().forEach(track => track.stop()); this.stream = null;
    if (this.context && this.context.state !== 'closed') void this.context.close(); this.context = null;
  }
  stop(onVoiceActivity?: (active: boolean) => void) {
    this.active = false; this.release();
    if (this.voiced) onVoiceActivity?.(false); this.voiced = false;
  }
}

const browserErrors: Record<string, string> = {
  'not-allowed': 'Microphone permission was denied. Allow microphone access in browser settings, then try again.',
  'service-not-allowed': 'This browser blocked its speech recognition service. Use Chrome, switch to Deepgram in Settings, or type questions manually.',
  network: 'Speech recognition lost its network connection. Check your connection and start listening again, or type questions manually.',
  'audio-capture': 'The microphone could not be captured. Check that it is connected and not in use by another app.',
  'language-not-supported': 'This browser cannot recognize the selected language. Choose another language or switch to Deepgram in Settings.',
  aborted: 'Speech recognition keeps being interrupted, probably by another tab or app that is listening. Close it, then start again.',
};

export type OnDeviceStatus = 'available' | 'downloadable' | 'downloading' | 'unavailable' | 'unsupported';
const recognitionClass = () => { const browser = window as any; return browser.SpeechRecognition || browser.webkitSpeechRecognition; };

/** Whether Chrome's on-device recognition, which vocabulary boosting needs (Chrome 140+), is ready for a language. */
export async function onDeviceStatus(language: string): Promise<OnDeviceStatus> {
  const SpeechRecognition = recognitionClass();
  if (typeof SpeechRecognition?.available !== 'function' || !('SpeechRecognitionPhrase' in window)) return 'unsupported';
  try { return await SpeechRecognition.available({ langs: [language], processLocally: true }); } catch { return 'unsupported'; }
}

/** Downloads Chrome's on-device model for a language. Call it from a click; resolves false if Chrome declines. */
export async function installOnDevice(language: string) {
  const SpeechRecognition = recognitionClass();
  if (typeof SpeechRecognition?.install !== 'function') return false;
  try { return await SpeechRecognition.install({ langs: [language], processLocally: true }) === true; } catch { return false; }
}

const phraseBoost = 3; // Range 0-10; stronger boosts start forcing the terms into unrelated speech.

/** Browser-backed recognition; the browser's speech provider may process audio remotely. */
export class BrowserSpeechToTextProvider implements SpeechToTextProvider {
  private recognition: any = null;
  private active = false;
  private listening = false;
  private resetting = false;
  private interruptions: number[] = [];
  private microphone: MicrophoneInput | null = null;
  private callbacks: SpeechCallbacks | null = null;
  /** With phrases, recognition runs on-device (when Chrome has the model) so the phrases can be boosted. */
  constructor(private language = 'en-US', private phrases: string[] = []) {}
  async start(callbacks: SpeechCallbacks) {
    const SpeechRecognition = recognitionClass();
    if (!SpeechRecognition) throw new Error('Live speech recognition is unavailable here. Use Chrome or enter a question manually.');
    if (this.recognition || this.active) return;
    // stop() may run during the awaits below and clear this.microphone, so keep a local handle.
    const microphone = new MicrophoneInput(); this.callbacks = callbacks; this.active = true; this.microphone = microphone;
    try { await microphone.start(callbacks.onVoiceActivity); }
    catch (reason) { this.active = false; microphone.stop(callbacks.onVoiceActivity); throw reason; }
    if (!this.active) { microphone.stop(callbacks.onVoiceActivity); return; }
    const onDevice = this.phrases.length ? await onDeviceStatus(this.language) : null;
    if (!this.active) { microphone.stop(callbacks.onVoiceActivity); return; }
    if (onDevice && onDevice !== 'available') callbacks.onNotice?.(onDevice === 'unsupported' ? 'This browser cannot boost vocabulary (it needs Chrome 140 or newer), so standard recognition is in use.' : onDevice === 'unavailable' ? 'On-device recognition is not available for this language in this browser, so standard recognition is in use.' : onDevice === 'downloading' ? "Chrome is still downloading its on-device speech model; standard recognition is in use until it finishes." : "Download Chrome's on-device speech model in Settings to boost vocabulary; standard recognition is in use for now.");
    const recognition = new SpeechRecognition(); this.recognition = recognition;
    recognition.continuous = true; recognition.interimResults = true; recognition.lang = this.language;
    if (onDevice === 'available') { recognition.processLocally = true; recognition.phrases = this.phrases.map(phrase => new (window as any).SpeechRecognitionPhrase(phrase, phraseBoost)); }
    // Chrome ends and restarts continuous recognition periodically; report only real state changes.
    const setListening = (listening: boolean) => { if (this.listening !== listening) { this.listening = listening; callbacks.onListening(listening); } };
    recognition.onstart = () => { if (this.active) setListening(true); }; // A restart can report in after the session ended.
    recognition.onresult = (event: any) => {
      let interim = '';
      for (let index = event.resultIndex; index < event.results.length; index++) {
        const result = event.results[index]; const text = String(result[0]?.transcript || '').trim();
        if (result.isFinal && text) { const confidence = Number(result[0]?.confidence || 0); callbacks.onFinal({ text, confidence: confidence || undefined }); }
        else if (!result.isFinal) interim += `${text} `;
      }
      callbacks.onInterim(interim.trim());
    };
    recognition.onerror = (event: any) => {
      if (!this.active || event.error === 'no-speech') return;
      if (recognition.processLocally && (event.error === 'phrases-not-supported' || event.error === 'language-not-supported')) {
        // Fall back to standard recognition; onend restarts it without on-device mode.
        recognition.phrases = []; recognition.processLocally = false;
        callbacks.onNotice?.("Chrome's on-device recognition could not boost vocabulary here, so standard recognition is in use.");
        return;
      }
      if (event.error === 'aborted' || event.error === 'network') {
        if (event.error === 'aborted' && this.resetting) { this.resetting = false; return; } // Our own reset(); onend restarts recognition.
        // Ride out brief network drops and another tab taking the recognizer (onend restarts it),
        // but stop if it keeps happening rather than retrying forever.
        const now = Date.now(); this.interruptions = [...this.interruptions.filter(at => now - at < 15000), now];
        if (this.interruptions.length < 3) return;
      }
      this.active = false; this.releaseMicrophone(); try { recognition.stop(); } catch { /* Already ended. */ }
      callbacks.onError(browserErrors[event.error] || `Speech recognition stopped (${event.error}). You can still enter a question manually.`, event.error === 'not-allowed');
      // Report the end even if onstart never fired (WebKit can fail before starting).
      this.listening = false; callbacks.onListening(false);
    };
    recognition.onend = () => {
      this.resetting = false;
      if (this.active && this.recognition === recognition) { try { recognition.start(); } catch { /* Browser may already be restarting. */ } }
      else if (this.recognition === recognition) { this.recognition = null; setListening(false); }
    };
    try { recognition.start(); } catch (reason: any) { this.active = false; this.recognition = null; this.releaseMicrophone(); throw new Error(reason?.message || 'Could not start speech recognition.'); }
  }
  private releaseMicrophone() { this.microphone?.stop(this.callbacks?.onVoiceActivity); this.microphone = null; }
  stop() { this.active = false; try { this.recognition?.stop(); } catch { /* Already stopped. */ } this.releaseMicrophone(); }
  // abort() discards pending results; onend then restarts recognition because the session is still active.
  reset() { if (this.active && this.recognition) { this.resetting = true; try { this.recognition.abort(); } catch { this.resetting = false; } } }
}

/** Deepgram Nova-3 URL; keyterms boost words that general models mishear (up to 100 terms). */
export function deepgramUrl(language: string, keyterms: string[] = [], live = true) {
  const query = new URLSearchParams({ model: 'nova-3', language: language === 'zh-CN' ? 'zh' : language });
  if (live) for (const [key, value] of Object.entries({ interim_results: 'true', smart_format: 'true', punctuate: 'true', endpointing: '300', utterance_end_ms: '1000', vad_events: 'true' })) query.set(key, value);
  for (const term of keyterms) query.append('keyterm', term);
  return `wss://api.deepgram.com/v1/listen?${query}`;
}

/** Deepgram live WebSocket transcription. The API key travels in the WebSocket
 * subprotocol (not the URL); audio is streamed directly from the mic to Deepgram. */
export class DeepgramSpeechToTextProvider implements SpeechToTextProvider {
  private active = false;
  private microphone: MicrophoneInput | null = null;
  private recorder: MediaRecorder | null = null;
  private socket: WebSocket | null = null;
  private callbacks: SpeechCallbacks | null = null;
  private confirmed = '';
  private discardUntil = 0;
  constructor(private apiKey: string, private language = 'en-US', private deviceId = '', private keyterms: string[] = []) {}

  // The browser rejects keys with spaces or unusual characters as WebSocket subprotocols, and its error message
  // repeats the key, so never surface that message.
  private static open(url: string, apiKey: string) {
    try { return new WebSocket(url, ['token', apiKey.trim()]); }
    catch { throw new Error('Could not open a Deepgram connection. Check that the API key was pasted without extra characters.'); }
  }

  static async checkConnection(apiKey: string, language = 'en-US') {
    if (!apiKey.trim()) throw new Error('Enter a Deepgram API key first.');
    const socket = DeepgramSpeechToTextProvider.open(deepgramUrl(language, [], false), apiKey);
    await new Promise<void>((resolve, reject) => {
      let opened = false; const timeout = window.setTimeout(() => { socket.close(); reject(new Error('Connection timed out.')); }, 10000);
      socket.onopen = () => { opened = true; window.clearTimeout(timeout); socket.close(1000, 'Connection check complete'); resolve(); };
      socket.onerror = () => { window.clearTimeout(timeout); reject(new Error('Could not connect. Check the API key and network access.')); };
      socket.onclose = () => { window.clearTimeout(timeout); if (!opened) reject(new Error('The service closed before accepting the connection. Check the API key and permissions.')); };
    });
  }

  async start(callbacks: SpeechCallbacks) {
    if (!this.apiKey.trim()) throw new Error('Add a Deepgram API key in Settings first.');
    if (this.active) return;
    this.callbacks = callbacks; this.active = true; this.confirmed = ''; this.microphone = new MicrophoneInput(this.deviceId);
    try { await this.microphone.start(callbacks.onVoiceActivity); }
    catch (reason) { this.active = false; this.release(); throw reason; }
    if (!this.active || !this.microphone.stream) { this.release(); return; }
    try { this.socket = DeepgramSpeechToTextProvider.open(deepgramUrl(this.language, this.keyterms), this.apiKey); }
    catch (reason) { this.active = false; this.release(); throw reason; }
    const socket = this.socket;
    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error('Transcription provider connection timed out.')), 12000);
      socket.onopen = () => { window.clearTimeout(timeout); resolve(); };
      socket.onerror = () => { window.clearTimeout(timeout); reject(new Error('Could not connect to Deepgram. Check your API key and network connection.')); };
      socket.onclose = () => { window.clearTimeout(timeout); reject(new Error('Deepgram closed before the transcription stream started. Check the API key and network connection.')); };
    }).catch(reason => { this.active = false; this.release(); throw reason; });
    if (!this.active || socket.readyState !== WebSocket.OPEN || !this.microphone.stream) { this.release(); return; }
    socket.onmessage = event => this.onMessage(event.data);
    socket.onclose = event => { if (this.active) { this.active = false; this.release(); callbacks.onError(`Deepgram connection closed (${event.code}${event.reason ? `: ${event.reason}` : ''}). Check the API key and network, then try again.`); callbacks.onListening(false); } };
    socket.onerror = () => { if (this.active) callbacks.onError('Deepgram transcription connection reported an error.'); };
    try {
      if (typeof MediaRecorder === 'undefined') throw new Error('This browser cannot stream microphone audio. Try the browser built-in speech provider.');
      const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find(type => MediaRecorder.isTypeSupported(type));
      this.recorder = mime ? new MediaRecorder(this.microphone.stream, { mimeType: mime }) : new MediaRecorder(this.microphone.stream);
      this.recorder.ondataavailable = event => { if (event.data.size && socket.readyState === WebSocket.OPEN) socket.send(event.data); };
      this.recorder.onerror = () => { this.active = false; this.release(); callbacks.onListening(false); callbacks.onError('Could not read microphone audio for streaming transcription.'); };
      this.recorder.start(150); callbacks.onListening(true);
    } catch (reason: any) { this.active = false; this.release(); throw new Error(reason?.message || 'This browser cannot stream microphone audio in a supported format.'); }
  }
  private onMessage(data: string) {
    try {
      const message = JSON.parse(data); const text = String(message.channel?.alternatives?.[0]?.transcript || '').trim();
      if (this.discardUntil && (message.type === 'Results' || message.type === 'UtteranceEnd')) {
        if (message.from_finalize) { this.discardUntil = 0; return; } // Words spoken before reset().
        if (Date.now() < this.discardUntil) return;
        this.discardUntil = 0;
      }
      // speech_final can arrive on a result with an empty transcript; it still ends the utterance.
      if (message.type === 'Results' && (text || message.speech_final)) {
        const alternative = message.channel?.alternatives?.[0];
        if (message.is_final && text) this.confirmed = [this.confirmed, text].filter(Boolean).join(' ').trim();
        if (message.speech_final) {
          if (this.confirmed) this.callbacks?.onFinal({ text: this.confirmed, confidence: Number(alternative?.confidence) || undefined });
          this.confirmed = ''; this.callbacks?.onInterim('');
        } else this.callbacks?.onInterim([this.confirmed, message.is_final ? '' : text].filter(Boolean).join(' ').trim());
      } else if (message.type === 'UtteranceEnd' && this.confirmed) {
        this.callbacks?.onFinal({ text: this.confirmed }); this.confirmed = ''; this.callbacks?.onInterim('');
      } else if (message.type === 'Error') this.callbacks?.onError(message.description || 'Deepgram returned a transcription error.');
    } catch { /* Ignore non-JSON control frames. */ }
  }
  private release() {
    try { this.recorder?.stop(); } catch { /* Already stopped. */ } this.recorder = null;
    if (this.socket && this.socket.readyState < WebSocket.CLOSING) this.socket.close(); this.socket = null;
    this.microphone?.stop(this.callbacks?.onVoiceActivity); this.microphone = null;
  }
  stop() { this.active = false; this.release(); this.callbacks?.onListening(false); }
  // Deepgram repeats a segment's earlier words in its final result, so flush the segment and drop what comes back.
  reset() {
    this.confirmed = '';
    if (this.active && this.socket?.readyState === WebSocket.OPEN) { this.socket.send(JSON.stringify({ type: 'Finalize' })); this.discardUntil = Date.now() + 1500; }
  }
}
