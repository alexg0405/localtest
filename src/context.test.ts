import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildProfile, forgetSavedContext, loadSavedContext, saveContext, type ContextFile } from './context';

const file = (name: string, text: string, status: ContextFile['status'] = 'ready'): ContextFile => ({ id: name, name, size: text.length, text, status });

describe('buildProfile', () => {
  it('orders role, notes, then readable files', () => {
    const { text, truncated } = buildProfile({ role: ' SWE intern at Stripe ', about: 'Built a Kafka pipeline.', files: [file('resume.pdf', 'Jane Doe'), file('broken.pdf', '', 'error'), file('reading.pdf', 'x', 'reading')] });
    expect(text).toBe('Interviewing for:\nSWE intern at Stripe\n\nAbout the candidate:\nBuilt a Kafka pipeline.\n\nFrom "resume.pdf":\nJane Doe');
    expect(truncated).toEqual([]);
  });

  it('shortens what does not fit the budget and reports it', () => {
    const { text, used, truncated } = buildProfile({ role: '', about: 'a'.repeat(700), files: [file('big.txt', 'b'.repeat(5000)), file('late.txt', 'c'.repeat(100))] }, 1000);
    expect(used).toBeLessThanOrEqual(1000);
    expect(text.length).toBeLessThanOrEqual(1000);
    expect(text).toContain('a'.repeat(700));
    expect(truncated).toEqual(['From "big.txt"', 'From "late.txt"']);
  });

  it('is empty without any context', () => {
    expect(buildProfile({ role: '', about: '  ', files: [] })).toEqual({ text: '', used: 0, truncated: [] });
  });
});

describe('saved context', () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  const memoryStorage = () => { const data = new Map<string, string>(); return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => void data.set(key, value), removeItem: (key: string) => void data.delete(key), data }; };

  it('saves only extracted text and restores it', () => {
    const storage = memoryStorage(); vi.stubGlobal('localStorage', storage);
    expect(saveContext({ role: 'SWE', about: 'Notes', files: [file('resume.pdf', 'Jane'), file('reading.pdf', '', 'reading')] })).toBe(true);
    expect(JSON.parse(storage.data.get('roomside.context.v1')!)).toEqual({ role: 'SWE', about: 'Notes', files: [{ name: 'resume.pdf', size: 4, text: 'Jane' }] });
    expect(loadSavedContext()).toEqual({ role: 'SWE', about: 'Notes', files: [{ id: 'saved-0', name: 'resume.pdf', size: 4, text: 'Jane', status: 'ready' }] });
    forgetSavedContext();
    expect(loadSavedContext()).toBeNull();
  });

  it('never throws when storage is blocked or corrupt', () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => { throw new Error('blocked'); } });
    expect(loadSavedContext()).toBeNull();
    expect(saveContext({ role: '', about: '', files: [] })).toBe(false);
    expect(() => forgetSavedContext()).not.toThrow();
    vi.stubGlobal('localStorage', { getItem: () => '{not json' });
    expect(loadSavedContext()).toBeNull();
  });
});
