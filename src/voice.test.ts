import { describe, expect, it } from 'vitest';
import { VoiceAnalyzer, semitones, voiceWorklet, type VoiceFrame } from './voice';

/** Runs the worklet source outside a browser: a stand-in base class collects what it posts. */
function worklet(rate: number) {
  let Processor: any;
  class Base { port = { frames: [] as VoiceFrame[], postMessage(frame: VoiceFrame) { this.frames.push(frame); } }; }
  new Function('AudioWorkletProcessor', 'registerProcessor', 'sampleRate', voiceWorklet)(Base, (_name: string, processor: unknown) => { Processor = processor; }, rate);
  const node = new Processor();
  const feed = (samples: Float32Array) => { for (let at = 0; at < samples.length; at += 128) node.process([[samples.subarray(at, at + 128)]]); return node.port.frames as VoiceFrame[]; };
  return { feed };
}
/** A voice-like tone: a fundamental with falling harmonics, at a given loudness. */
function voice(hertz: number, seconds: number, rate: number, amplitude = 0.2) {
  const samples = new Float32Array(Math.round(seconds * rate));
  for (let i = 0; i < samples.length; i++) { const t = i / rate; let value = 0; for (let harmonic = 1; harmonic <= 6; harmonic++) value += Math.sin(2 * Math.PI * hertz * harmonic * t) / harmonic; samples[i] = amplitude * value / 2; }
  return samples;
}
function noise(seconds: number, rate: number, amplitude = 0.01) {
  let seed = 7; const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5;
  return Float32Array.from({ length: Math.round(seconds * rate) }, () => amplitude * random());
}
const medianPitch = (frames: VoiceFrame[]) => { const pitched = frames.map(frame => frame.pitch).filter(Boolean).sort((a, b) => a - b); return pitched[pitched.length >> 1]; };

describe('voice worklet', () => {
  it('finds the pitch of low and high voices at common sample rates', () => {
    for (const rate of [48000, 44100]) for (const hertz of [95, 140, 220, 310]) {
      const frames = worklet(rate).feed(voice(hertz, 0.6, rate)).slice(3);
      expect(frames.length).toBeGreaterThan(20); // A frame every 20 ms.
      expect(Math.abs(medianPitch(frames) - hertz) / hertz).toBeLessThan(0.03);
    }
  });

  it('reports quiet noise as unvoiced and brighter than a voice', () => {
    const quiet = worklet(48000).feed(noise(0.5, 48000)).slice(3);
    expect(quiet.every(frame => frame.pitch === 0)).toBe(true);
    const tone = worklet(48000).feed(voice(140, 0.5, 48000)).slice(3);
    expect(Math.min(...quiet.map(frame => frame.tilt))).toBeGreaterThan(Math.max(...tone.map(frame => frame.tilt)));
    expect(tone[0].level - quiet[0].level).toBeGreaterThan(20);
  });
});

describe('VoiceAnalyzer', () => {
  const frames = (count: number, level: number, pitch = 0, tilt = 0.1) => Array.from({ length: count }, () => ({ level, pitch, tilt }));

  it('detects speech against a noise floor that adapts to the room', () => {
    const changes: boolean[] = []; const analyzer = new VoiceAnalyzer(active => changes.push(active));
    for (const frame of frames(100, -48)) analyzer.push(frame); // Two seconds of a humming room.
    expect(changes).toEqual([]);
    for (const frame of frames(40, -24, 150)) analyzer.push(frame);
    expect(changes).toEqual([true]);
    for (const frame of frames(14, -47)) analyzer.push(frame); // A pause shorter than 300 ms keeps the turn going.
    expect(changes).toEqual([true]);
    for (const frame of frames(2, -47)) analyzer.push(frame);
    expect(changes).toEqual([true, false]);
    expect(analyzer.noiseFloor).toBeCloseTo(-48, 0);
  });

  it('detects speech that starts the moment listening does', () => {
    const changes: boolean[] = []; const analyzer = new VoiceAnalyzer(active => changes.push(active));
    for (const frame of frames(40, -22, 180)) analyzer.push(frame);
    expect(changes).toEqual([true]);
  });

  it('keeps detecting long speech that has the usual short gaps between words', () => {
    const changes: boolean[] = []; const analyzer = new VoiceAnalyzer(active => changes.push(active));
    for (const frame of frames(50, -50)) analyzer.push(frame);
    for (let word = 0; word < 40; word++) { for (const frame of frames(12, -22, 180)) analyzer.push(frame); for (const frame of frames(2, -44)) analyzer.push(frame); }
    expect(changes).toEqual([true]); // Eleven seconds, still one turn.
  });

  it('summarizes each stretch of speech as a voice print', () => {
    const analyzer = new VoiceAnalyzer();
    for (const frame of frames(50, -50)) analyzer.push(frame);
    for (const frame of [...frames(30, -20, 200, 0.2), ...frames(10, -20, 0, 0.6)]) analyzer.push(frame);
    const print = analyzer.takePrint()!;
    expect(print.pitch).toBeCloseTo(semitones(200), 5);
    // The first loud frame only starts the turn, so 29 pitched and 10 unvoiced frames count.
    expect(print.tilt).toBeCloseTo((29 * 0.2 + 10 * 0.6) / 39, 5);
    expect(print.level).toBeCloseTo(30, 0);
    expect(print.seconds).toBeCloseTo(0.78, 5);
    expect(analyzer.takePrint()).toBeUndefined(); // Nothing new since.
  });
});
