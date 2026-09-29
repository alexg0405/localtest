export type SpeechResult = { text: string; confidence?: number };
export interface SpeechCallbacks {
  onFinal(result: SpeechResult): void;
  onInterim(text: string): void;
  onError(message: string, permissionDenied?: boolean): void;
  onListening(listening: boolean): void;
  onVoiceActivity(active: boolean): void;
}
export interface SpeechToTextProvider { start(callbacks: SpeechCallbacks): Promise<void>; stop(): void }

class MicrophoneInput {
  stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private frame = 0;
  private active = true;
  private voiced = false;
  constructor(private deviceId = '') {}

  async start(onVoiceActivity: (active: boolean) => void) {
    const AudioContextConstructor = window.AudioContext || (window as any).webkitAudioContext;
    if (AudioContextConstructor) { this.context = new AudioContextConstructor(); await this.context.resume(); }
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

/** Browser-backed recognition; the browser's speech provider may process audio remotely. */
export class BrowserSpeechToTextProvider implements SpeechToTextProvider {
  private recognition: any = null;
  private active = false;
  private microphone: MicrophoneInput | null = null;
  private callbacks: SpeechCallbacks | null = null;
  constructor(private language = 'en-US') {}
  async start(callbacks: SpeechCallbacks) {
    const browser = window as any; const SpeechRecognition = browser.SpeechRecognition || browser.webkitSpeechRecognition;
    if (!SpeechRecognition) throw new Error('Live speech recognition is unavailable here. Use Chrome or enter a question manually.');
    if (this.recognition) return;
    this.callbacks = callbacks; this.active = true; this.microphone = new MicrophoneInput();
    try { await this.microphone.start(callbacks.onVoiceActivity); }
    catch (reason) { this.active = false; this.microphone.stop(callbacks.onVoiceActivity); throw reason; }
    if (!this.active) { this.microphone.stop(callbacks.onVoiceActivity); return; }
    const recognition = new SpeechRecognition(); this.recognition = recognition;
    recognition.continuous = true; recognition.interimResults = true; recognition.lang = this.language;
    recognition.onstart = () => callbacks.onListening(true);
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
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') { this.active = false; this.releaseMicrophone(); callbacks.onListening(false); callbacks.onError('Microphone permission was denied. Allow microphone access in browser settings, then try again.', true); }
      else if (event.error !== 'no-speech' && event.error !== 'aborted') { this.active = false; this.releaseMicrophone(); callbacks.onListening(false); callbacks.onError(`Speech recognition: ${event.error}. You can still enter a question manually.`); try { recognition.stop(); } catch { /* Already ended. */ } }
    };
    recognition.onend = () => {
      if (this.active && this.recognition === recognition) { try { recognition.start(); } catch { /* Browser may already be restarting. */ } }
      else if (this.recognition === recognition) { this.recognition = null; callbacks.onListening(false); }
    };
    try { recognition.start(); } catch (reason: any) { this.active = false; this.recognition = null; this.releaseMicrophone(); throw new Error(reason?.message || 'Could not start speech recognition.'); }
  }
  private releaseMicrophone() { this.microphone?.stop(this.callbacks?.onVoiceActivity); this.microphone = null; }
  stop() { this.active = false; try { this.recognition?.stop(); } catch { /* Already stopped. */ } this.releaseMicrophone(); }
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
  constructor(private apiKey: string, private language = 'en-US', private deviceId = '') {}

  static async checkConnection(apiKey: string, language = 'en-US') {
    if (!apiKey.trim()) throw new Error('Enter a Deepgram API key first.');
    const lang = language === 'zh-CN' ? 'zh' : language;
    const query = new URLSearchParams({ model: 'nova-2', language: lang });
    const socket = new WebSocket(`wss://api.deepgram.com/v1/listen?${query}`, ['token', apiKey]);
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
    const deepgramLanguage = this.language === 'zh-CN' ? 'zh' : this.language;
    const query = new URLSearchParams({ model: 'nova-2', language: deepgramLanguage, interim_results: 'true', smart_format: 'true', punctuate: 'true', endpointing: '300', utterance_end_ms: '1000', vad_events: 'true' });
    const url = `wss://api.deepgram.com/v1/listen?${query.toString()}`;
    try { this.socket = new WebSocket(url, ['token', this.apiKey]); }
    catch (reason: any) { this.active = false; this.release(); throw new Error(reason?.message || 'Could not create a transcription connection.'); }
    const socket = this.socket;
    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error('Transcription provider connection timed out.')), 12000);
      socket.onopen = () => { window.clearTimeout(timeout); resolve(); };
      socket.onerror = () => { window.clearTimeout(timeout); reject(new Error('Could not connect to Deepgram. Check your API key and network connection.')); };
      socket.onclose = () => { window.clearTimeout(timeout); reject(new Error('Deepgram closed before the transcription stream started. Check the API key and network connection.')); };
    }).catch(reason => { this.active = false; this.release(); throw reason; });
    if (!this.active || socket.readyState !== WebSocket.OPEN || !this.microphone.stream) { this.release(); return; }
    socket.onmessage = event => this.onMessage(event.data);
    socket.onclose = event => { if (this.active) { this.active = false; this.release(); callbacks.onListening(false); callbacks.onError(`Deepgram connection closed (${event.code}). Check the API key and try again.`); } };
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
      if (message.type === 'Results' && text) {
        const alternative = message.channel?.alternatives?.[0];
        if (message.is_final) this.confirmed = [this.confirmed, text].filter(Boolean).join(' ').trim();
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
}
