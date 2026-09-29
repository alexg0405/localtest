import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserSpeechToTextProvider, DeepgramSpeechToTextProvider, deepgramUrl, installOnDevice, onDeviceStatus, type SpeechCallbacks } from './speech';

const settle = () => new Promise(resolve => setTimeout(resolve, 0));
function recordingCallbacks() {
  const events: string[] = [];
  const callbacks: SpeechCallbacks = {
    onFinal: result => events.push(`final:${result.text}`), onInterim: text => events.push(`interim:${text}`), onError: message => events.push(`error:${message}`),
    onListening: listening => events.push(`listening:${listening}`), onVoiceActivity: () => undefined, onNotice: message => events.push(`notice:${message}`),
  };
  return { events, callbacks };
}

// Validates subprotocols the way browsers do, including echoing the bad value in the error.
class FakeWebSocket {
  static OPEN = 1; static CLOSING = 2;
  readyState = 0; protocols: string[];
  constructor(_url: string, protocols: string[]) {
    for (const protocol of protocols) if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(protocol)) throw new DOMException(`The subprotocol '${protocol}' is invalid.`, 'SyntaxError');
    this.protocols = protocols;
  }
  close() { /* Nothing to close. */ }
}

describe('deepgramUrl', () => {
  it('streams with Nova-3 and boosts each key term', () => {
    const url = new URL(deepgramUrl('en-US', ['LeetCode', 'Two Sum']));
    expect(url.origin + url.pathname).toBe('wss://api.deepgram.com/v1/listen');
    expect(url.searchParams.get('model')).toBe('nova-3');
    expect(url.searchParams.getAll('keyterm')).toEqual(['LeetCode', 'Two Sum']);
    expect(url.search).toContain('keyterm=Two+Sum');
    expect(url.searchParams.get('interim_results')).toBe('true');
  });

  it('maps Mandarin and leaves streaming options out of the connection check', () => {
    const url = new URL(deepgramUrl('zh-CN', [], false));
    expect(url.searchParams.get('language')).toBe('zh');
    expect(url.searchParams.has('interim_results')).toBe(false);
    expect(url.searchParams.has('keyterm')).toBe(false);
  });
});

describe('DeepgramSpeechToTextProvider', () => {
  beforeEach(() => { vi.stubGlobal('WebSocket', FakeWebSocket); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
  function setup() {
    const { events, callbacks } = recordingCallbacks();
    const provider = new DeepgramSpeechToTextProvider('key') as any; provider.callbacks = callbacks;
    const send = (message: object) => provider.onMessage(JSON.stringify(message));
    const results = (transcript: string, isFinal: boolean, speechFinal = false) => send({ type: 'Results', is_final: isFinal, speech_final: speechFinal, channel: { alternatives: [{ transcript, confidence: 0.9 }] } });
    return { events, provider, send, results };
  }

  it('joins finalized segments until speech_final', () => {
    const { events, results } = setup();
    results('what is', false); results('what is', true); results('a hash', false); results('a hash map', true, true);
    expect(events).toEqual(['interim:what is', 'interim:what is', 'interim:what is a hash', 'final:what is a hash map', 'interim:']);
  });

  it('ends the utterance on a speech_final result with an empty transcript', () => {
    const { events, results } = setup();
    results('tell me about yourself', true); results('', true, true);
    expect(events).toEqual(['interim:tell me about yourself', 'final:tell me about yourself', 'interim:']);
  });

  it('flushes confirmed words on UtteranceEnd and ignores empty interim results', () => {
    const { events, results, send } = setup();
    results('', false); results('why kafka', true); send({ type: 'UtteranceEnd' }); send({ type: 'UtteranceEnd' });
    expect(events).toEqual(['interim:why kafka', 'final:why kafka', 'interim:']);
  });

  it('reports Deepgram errors and skips non-JSON frames', () => {
    const { events, send, provider } = setup();
    send({ type: 'Error', description: 'bad audio' }); provider.onMessage('not json');
    expect(events).toEqual(['error:bad audio']);
  });

  it('reset flushes the current segment and drops the words that come back', () => {
    const { events, provider, results, send } = setup();
    const sent: string[] = []; provider.active = true; provider.socket = { readyState: FakeWebSocket.OPEN, send: (frame: string) => sent.push(frame) };
    results('what did you', false);
    provider.reset();
    expect(sent).toEqual(['{"type":"Finalize"}']);
    results('what did you think', false);
    send({ type: 'Results', is_final: true, from_finalize: true, channel: { alternatives: [{ transcript: 'what did you think' }] } });
    results('why rust', true, true);
    expect(events).toEqual(['interim:what did you', 'final:why rust', 'interim:']);
  });

  it('resumes after a short window if the flush is never confirmed', () => {
    vi.useFakeTimers();
    const { events, provider, results } = setup();
    provider.active = true; provider.socket = { readyState: FakeWebSocket.OPEN, send: () => undefined };
    provider.reset(); results('late words', false);
    vi.advanceTimersByTime(1600); results('new question', true, true);
    expect(events).toEqual(['final:new question', 'interim:']);
  });

  it('never shows the API key in connection errors and trims pasted whitespace', () => {
    const open = (DeepgramSpeechToTextProvider as any).open;
    expect(() => open('wss://deepgram.test', 'sk secret key')).toThrow(/extra characters/);
    try { open('wss://deepgram.test', 'sk secret key'); } catch (error) { expect(String(error)).not.toContain('secret'); }
    expect(open('wss://deepgram.test', '  validkey123 \n').protocols).toEqual(['token', 'validkey123']);
  });
});

class FakePhrase { constructor(public phrase: string, public boost: number) {} }

class FakeRecognition {
  static instances: FakeRecognition[] = [];
  static failBeforeStart = '';
  static available?: (options: unknown) => Promise<string>;
  static install?: (options: unknown) => Promise<boolean>;
  processLocally?: boolean; phrases?: FakePhrase[];
  continuous = false; interimResults = false; lang = ''; started = false; calls: string[] = [];
  onstart?: () => void; onend?: () => void; onerror?: (event: { error: string }) => void; onresult?: (event: unknown) => void;
  constructor() { FakeRecognition.instances.push(this); }
  start() {
    if (this.started) throw new DOMException('recognition has already started', 'InvalidStateError');
    this.started = true; this.calls.push('start'); const failure = FakeRecognition.failBeforeStart;
    queueMicrotask(() => { if (failure) { this.started = false; this.onerror?.({ error: failure }); this.onend?.(); } else this.onstart?.(); });
  }
  stop() { this.calls.push('stop'); if (this.started) { this.started = false; queueMicrotask(() => this.onend?.()); } }
  abort() { this.calls.push('abort'); if (this.started) { this.started = false; queueMicrotask(() => { this.onerror?.({ error: 'aborted' }); this.onend?.(); }); } }
  /** Chrome ends continuous recognition on its own now and then. */
  endOnItsOwn() { this.started = false; this.onend?.(); }
  /** Chrome reports an error ('aborted' when another tab or app takes the recognizer), then ends. */
  interrupt(error: string) { this.started = false; this.onerror?.({ error }); this.onend?.(); }
}

describe('BrowserSpeechToTextProvider', () => {
  let getUserMedia: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    FakeRecognition.instances = []; FakeRecognition.failBeforeStart = ''; FakeRecognition.available = undefined; FakeRecognition.install = undefined;
    getUserMedia = vi.fn(async () => ({ getTracks: () => [] }));
    vi.stubGlobal('window', { SpeechRecognition: FakeRecognition });
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
  });
  afterEach(() => { vi.unstubAllGlobals(); });
  async function listen(phrases: string[] = []) {
    const { events, callbacks } = recordingCallbacks(); const provider = new BrowserSpeechToTextProvider('en-US', phrases);
    await provider.start(callbacks); await settle();
    return { events, provider, recognition: FakeRecognition.instances[0] };
  }

  it('reports the end when recognition fails before it starts', async () => {
    FakeRecognition.failBeforeStart = 'service-not-allowed';
    const { events } = await listen();
    expect(events).toEqual(['error:This browser blocked its speech recognition service. Use Chrome, switch to Deepgram in Settings, or type questions manually.', 'listening:false']);
  });

  it('restarts quietly when recognition ends on its own', async () => {
    const { events, recognition } = await listen();
    recognition.endOnItsOwn(); await settle();
    expect(recognition.calls).toEqual(['start', 'start']);
    expect(events).toEqual(['listening:true']);
  });

  it('reset restarts recognition without an error', async () => {
    const { events, provider, recognition } = await listen();
    provider.reset(); await settle();
    expect(recognition.calls).toEqual(['start', 'abort', 'start']);
    expect(events).toEqual(['listening:true']);
  });

  it('gives up after repeated aborts from another tab', async () => {
    const { events, recognition } = await listen();
    recognition.interrupt('aborted'); recognition.interrupt('aborted');
    expect(events).toEqual(['listening:true']);
    recognition.interrupt('aborted'); await settle();
    expect(events.slice(1)).toEqual(['error:Speech recognition keeps being interrupted, probably by another tab or app that is listening. Close it, then start again.', 'listening:false']);
  });

  it('keeps listening through a brief network drop', async () => {
    const { events, recognition } = await listen();
    recognition.interrupt('network'); await settle();
    expect(recognition.calls).toEqual(['start', 'start']);
    expect(events).toEqual(['listening:true']);
  });

  it('stops when the network keeps failing', async () => {
    const { events, recognition } = await listen();
    for (let attempt = 0; attempt < 3; attempt++) { recognition.interrupt('network'); await settle(); }
    expect(events.slice(1)).toEqual(['error:Speech recognition lost its network connection. Check your connection and start listening again, or type questions manually.', 'listening:false']);
  });

  it('fails right away on errors that a restart cannot fix', async () => {
    const { events, recognition } = await listen();
    recognition.interrupt('audio-capture'); await settle();
    expect(recognition.calls).toEqual(['start', 'stop']);
    expect(events.slice(1)).toEqual(['error:The microphone could not be captured. Check that it is connected and not in use by another app.', 'listening:false']);
  });

  describe('vocabulary boosting', () => {
    const withPhrases = () => vi.stubGlobal('window', { SpeechRecognition: FakeRecognition, SpeechRecognitionPhrase: FakePhrase });

    it('runs on-device and boosts the phrases when Chrome has the model', async () => {
      withPhrases(); const available = vi.fn(async () => 'available'); FakeRecognition.available = available;
      const { events, recognition } = await listen(['LeetCode', 'Two Sum']);
      expect(available).toHaveBeenCalledWith({ langs: ['en-US'], processLocally: true });
      expect(recognition.processLocally).toBe(true);
      expect(recognition.phrases).toEqual([new FakePhrase('LeetCode', 3), new FakePhrase('Two Sum', 3)]);
      expect(events).toEqual(['listening:true']);
    });

    it('uses standard recognition, with a note, until the model is downloaded', async () => {
      withPhrases(); FakeRecognition.available = async () => 'downloadable';
      const { events, recognition } = await listen(['LeetCode']);
      expect(recognition.processLocally).toBeUndefined();
      expect(events[0]).toMatch(/^notice:Download Chrome's on-device speech model in Settings/);
    });

    it('explains when the browser cannot boost vocabulary', async () => {
      FakeRecognition.available = async () => 'available'; // No SpeechRecognitionPhrase: an older browser.
      const { events, recognition } = await listen(['LeetCode']);
      expect(recognition.processLocally).toBeUndefined();
      expect(events[0]).toMatch(/Chrome 140 or newer/);
    });

    it('falls back to standard recognition if Chrome rejects the phrases', async () => {
      withPhrases(); FakeRecognition.available = async () => 'available';
      const { events, recognition } = await listen(['LeetCode']);
      recognition.interrupt('phrases-not-supported'); await settle();
      expect(recognition.processLocally).toBe(false);
      expect(recognition.phrases).toEqual([]);
      expect(recognition.calls).toEqual(['start', 'start']);
      expect(events).toEqual(['listening:true', expect.stringMatching(/^notice:.*standard recognition/)]);
    });

    it('does not touch on-device support when boosting is off', async () => {
      withPhrases(); const available = vi.fn(async () => 'available'); FakeRecognition.available = available;
      const { recognition } = await listen();
      expect(available).not.toHaveBeenCalled();
      expect(recognition.processLocally).toBeUndefined();
    });

    it('reports status and downloads through the static API', async () => {
      expect(await onDeviceStatus('en-US')).toBe('unsupported');
      withPhrases(); FakeRecognition.available = async () => 'downloadable';
      expect(await onDeviceStatus('en-US')).toBe('downloadable');
      FakeRecognition.available = async () => { throw new Error('boom'); };
      expect(await onDeviceStatus('en-US')).toBe('unsupported');
      expect(await installOnDevice('en-US')).toBe(false);
      const install = vi.fn(async () => true); FakeRecognition.install = install;
      expect(await installOnDevice('en-US')).toBe(true);
      expect(install).toHaveBeenCalledWith({ langs: ['en-US'], processLocally: true });
      FakeRecognition.install = async () => { throw new Error('no activation'); };
      expect(await installOnDevice('en-US')).toBe(false);
    });
  });

  it('creates no recognizer when stopped while waiting for microphone permission', async () => {
    let grant: (stream: unknown) => void = () => undefined;
    getUserMedia.mockImplementation(() => new Promise(resolve => { grant = resolve; }));
    const { callbacks } = recordingCallbacks(); const provider = new BrowserSpeechToTextProvider('en-US');
    const starting = provider.start(callbacks);
    await settle(); provider.stop(); grant({ getTracks: () => [] });
    await expect(starting).resolves.toBeUndefined();
    expect(FakeRecognition.instances).toHaveLength(0);
  });
});
