// Local voice analysis for the microphone: when someone is speaking (against a noise floor that adapts to the room) and
// what each stretch of speech sounds like (pitch, brightness, loudness), for telling the interviewer and you apart.
// Nothing here records or sends audio; it keeps a few numbers per utterance.

/** One 20 ms frame: loudness in dBFS, pitch in Hz (0 when unvoiced), and brightness (energy of the signal's changes over its energy). */
export type VoiceFrame = { level: number; pitch: number; tilt: number };
/** What an utterance sounded like: median pitch in semitones above 55 Hz (when voiced enough), mean brightness, loudness above the room's noise in dB, and seconds of speech. */
export type VoicePrint = { pitch?: number; tilt: number; level: number; seconds: number };

const frameSeconds = 0.02;
const median = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b); const middle = sorted.length >> 1; return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2; };
export const semitones = (hertz: number) => 12 * Math.log2(hertz / 55);

/** Voice activity from frame loudness, with hysteresis, and the voice print of each stretch of speech. */
export class VoiceAnalyzer {
  private buckets: number[] = []; // The quietest level in each 100 ms of the last 3 s.
  private bucketMin = Infinity; private bucketFrames = 0;
  // The room's noise: assumed quiet until measured, then it drops at once to a quieter room and rises at most 2 dB a
  // second, so a long answer with few pauses is not mistaken for noise.
  private floor = -50;
  private active = false; private loud = 0; private quiet = 0;
  private pitches: number[] = []; private tilt = 0; private snr = 0; private frames = 0;
  constructor(private onVoiceActivity: (active: boolean) => void = () => undefined) {}

  get noiseFloor() { return this.floor; }
  get speaking() { return this.active; }

  push(frame: VoiceFrame) {
    this.bucketMin = Math.min(this.bucketMin, frame.level);
    if (++this.bucketFrames === 5) {
      this.buckets.push(this.bucketMin); if (this.buckets.length > 30) this.buckets.shift(); this.bucketMin = Infinity; this.bucketFrames = 0;
      const quietest = Math.max(Math.min(...this.buckets), -90); this.floor = quietest < this.floor ? quietest : Math.min(quietest, this.floor + 0.2);
    }
    const above = frame.level - this.floor;
    // Starts after 40 ms clearly above the noise, ends after 300 ms back near it.
    if (!this.active) { this.loud = above > 9 && frame.level > -65 ? this.loud + 1 : 0; if (this.loud >= 2) { this.active = true; this.quiet = 0; this.onVoiceActivity(true); } }
    else { this.quiet = above < 5 ? this.quiet + 1 : 0; if (this.quiet >= 15) { this.active = false; this.loud = 0; this.onVoiceActivity(false); } }
    if (this.active && above > 5) {
      this.frames++; this.tilt += frame.tilt; this.snr += above;
      if (frame.pitch >= 60 && frame.pitch <= 450) this.pitches.push(semitones(frame.pitch));
    }
  }

  /** The print of the speech heard since the last call, or undefined if there was too little of it. */
  takePrint(): VoicePrint | undefined {
    const { frames, pitches } = this; const print = frames >= 15 ? { ...(pitches.length >= 8 ? { pitch: median(pitches) } : {}), tilt: this.tilt / frames, level: this.snr / frames, seconds: frames * frameSeconds } : undefined;
    this.pitches = []; this.tilt = 0; this.snr = 0; this.frames = 0;
    return print;
  }
}

/** AudioWorklet that turns microphone audio into VoiceFrames every 20 ms (downsampled to about 16 kHz, pitch by the YIN method). */
export const voiceWorklet = `
class RoomsideVoice extends AudioWorkletProcessor {
  constructor() {
    super();
    this.step = Math.max(1, Math.round(sampleRate / 16000)); this.rate = sampleRate / this.step;
    this.size = Math.round(this.rate * 0.04); this.hop = Math.round(this.rate * 0.02); // 40 ms covers a period of the lowest voices.
    this.minLag = Math.floor(this.rate / 450); this.maxLag = Math.min(Math.ceil(this.rate / 60), this.size - 64);
    this.ring = new Float32Array(this.size); this.frame = new Float32Array(this.size); this.yin = new Float32Array(this.maxLag + 2);
    this.head = 0; this.filled = 0; this.since = 0; this.sum = 0; this.count = 0;
  }
  process(inputs) {
    const input = inputs[0] && inputs[0][0]; if (!input) return true;
    for (let i = 0; i < input.length; i++) {
      this.sum += input[i]; if (++this.count < this.step) continue;
      this.ring[this.head] = this.sum / this.step; this.head = (this.head + 1) % this.size; this.sum = 0; this.count = 0;
      if (this.filled < this.size) this.filled++;
      if (++this.since >= this.hop && this.filled === this.size) { this.since = 0; this.port.postMessage(this.analyze()); }
    }
    return true;
  }
  analyze() {
    const n = this.size, x = this.frame; let mean = 0;
    for (let i = 0; i < n; i++) { x[i] = this.ring[(this.head + i) % n]; mean += x[i]; }
    mean /= n; let energy = 0, change = 0;
    for (let i = 0; i < n; i++) { x[i] -= mean; energy += x[i] * x[i]; if (i) { const d = x[i] - x[i - 1]; change += d * d; } }
    const level = 10 * Math.log10(energy / n + 1e-12);
    return { level, tilt: energy > 0 ? change / energy : 0, pitch: level > -60 ? this.pitch(x) : 0 };
  }
  pitch(x) {
    const d = this.yin, width = this.size - this.maxLag; let running = 0; d[0] = 1;
    for (let lag = 1; lag <= this.maxLag; lag++) {
      let sum = 0; for (let i = 0; i < width; i++) { const delta = x[i] - x[i + lag]; sum += delta * delta; }
      running += sum; d[lag] = running > 0 ? sum * lag / running : 1;
    }
    for (let lag = this.minLag; lag < this.maxLag; lag++) {
      if (d[lag] >= 0.15) continue;
      while (lag + 1 < this.maxLag && d[lag + 1] < d[lag]) lag++;
      const a = d[lag - 1], b = d[lag], c = d[lag + 1], bend = a - 2 * b + c, shift = bend ? (a - c) / (2 * bend) : 0;
      return this.rate / (lag + (Math.abs(shift) < 1 ? shift : 0));
    }
    return 0;
  }
}
registerProcessor('roomside-voice', RoomsideVoice);
`;

let workletUrl = '';
/** Connects the voice worklet to a microphone source; resolves null where AudioWorklet is unavailable. */
export async function connectVoiceWorklet(context: AudioContext, source: AudioNode, onFrame: (frame: VoiceFrame) => void) {
  if (!context.audioWorklet || typeof AudioWorkletNode === 'undefined') return null;
  try {
    workletUrl ||= URL.createObjectURL(new Blob([voiceWorklet], { type: 'application/javascript' }));
    await context.audioWorklet.addModule(workletUrl);
    const node = new AudioWorkletNode(context, 'roomside-voice', { numberOfInputs: 1, numberOfOutputs: 0 });
    node.port.onmessage = event => onFrame(event.data as VoiceFrame);
    source.connect(node);
    return node;
  } catch { return null; }
}
