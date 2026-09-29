import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MirrorConnection, mirrorBlocks, type MirrorCommand, type MirrorState, type MirrorStatus } from './mirror';
import { parseAnswer } from './text';

class FakeEventSource {
  static CLOSED = 2;
  static instances: FakeEventSource[] = [];
  readyState = 1;
  onerror: (() => void) | null = null;
  private listeners: Record<string, ((event: { data: string }) => void)[]> = {};
  constructor(public url: string) { FakeEventSource.instances.push(this); }
  addEventListener(name: string, listener: (event: { data: string }) => void) { (this.listeners[name] ??= []).push(listener); }
  emit(name: string, data: unknown) { for (const listener of this.listeners[name] ?? []) listener({ data: JSON.stringify(data) }); }
  close() { this.readyState = FakeEventSource.CLOSED; }
}

const state = (question: string): MirrorState => ({ listening: 'off', micError: '', notice: '', question, tag: '', possible: false, kind: 'answer', answerMode: 'STANDARD', mode: 'STANDARD', blocks: [], generating: false, status: '', answerError: '', heard: [], interim: '', provider: '' });
const status = (owner: MirrorStatus['owner']): MirrorStatus => ({ running: true, owner, phones: 1, links: [] });
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

let requests: { url: string; body: any; reply: (status: number) => void }[] = [];
let commands: MirrorCommand[] = []; let stopped = 0;
function connect() {
  const connection = new MirrorConnection({ status: () => undefined, command: command => commands.push(command), stopped: () => stopped++ });
  return { connection, source: FakeEventSource.instances[FakeEventSource.instances.length - 1] };
}
beforeEach(() => {
  requests = []; commands = []; stopped = 0; FakeEventSource.instances = [];
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal('fetch', vi.fn((url: string, init: RequestInit) => new Promise<Response>(resolve => requests.push({ url, body: JSON.parse(String(init.body)), reply: code => resolve(new Response(null, { status: code })) }))));
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('MirrorConnection', () => {
  it('sends state only while this tab is mirrored, keeping just the newest state while a send is in flight', async () => {
    const { connection, source } = connect();
    expect(source.url).toMatch(/^\/api\/mirror\/events\?tab=.+/);
    connection.publish(state('Before hello'));
    expect(requests).toHaveLength(0);

    source.emit('hello', { connection: 'c1', status: status('this') });
    connection.publish(state('A'));
    connection.publish(state('B'));
    connection.publish(state('C'));
    expect(requests.map(request => request.body.state.question)).toEqual(['A']);
    expect(requests[0]).toMatchObject({ url: '/api/mirror/state', body: { connection: 'c1' } });
    requests[0].reply(204); await settle();
    expect(requests.map(request => request.body.state.question)).toEqual(['A', 'C']); // B was already out of date.
    requests[1].reply(204); await settle();

    connection.publish(state('C'));
    expect(requests).toHaveLength(2); // Unchanged.
    source.emit('hello', { connection: 'c2', status: status('this') }); // Reconnected, so the server may have lost it.
    connection.publish(state('C'));
    expect(requests[2].body).toMatchObject({ connection: 'c2', state: { question: 'C' } });
  });

  it('carries out commands only while this tab is mirrored', () => {
    const { source } = connect();
    source.emit('hello', { connection: 'c1', status: status('this') });
    source.emit('command', { type: 'ask', text: 'What is Kafka?' });
    source.emit('status', status('other'));
    source.emit('command', { type: 'listen' });
    expect(commands).toEqual([{ type: 'ask', text: 'What is Kafka?' }]);
  });

  it('stops sending when another tab takes over', async () => {
    const { connection, source } = connect();
    source.emit('hello', { connection: 'c1', status: status('this') });
    connection.publish(state('A')); requests[0].reply(409); await settle();
    connection.publish(state('B'));
    expect(requests).toHaveLength(1);
  });

  it('reports when mirroring stops or the server refuses the stream', () => {
    const first = connect();
    first.source.emit('stopped', {});
    expect(stopped).toBe(1);
    expect(first.source.readyState).toBe(FakeEventSource.CLOSED);
    const second = connect();
    second.source.onerror?.(); // A dropped connection that EventSource will retry.
    expect(stopped).toBe(1);
    second.source.readyState = FakeEventSource.CLOSED; second.source.onerror?.();
    expect(stopped).toBe(2);
  });
});

describe('mirrorBlocks', () => {
  it('splits out bold and code spans so the phone can render answers without the parser', () => {
    expect(mirrorBlocks(parseAnswer('KEY CONCEPTS\n• Use a **hash map** for `O(1)` lookups\nSituation: I led the migration\n```\nreturn seen\n```'))).toEqual([
      { type: 'heading', segments: [{ text: 'KEY CONCEPTS' }] },
      { type: 'bullet', segments: [{ text: 'Use a ' }, { text: 'hash map', bold: true }, { text: ' for ' }, { text: 'O(1)', code: true }, { text: ' lookups' }] },
      { type: 'label', label: 'Situation', segments: [{ text: 'I led the migration' }] },
      { type: 'code', text: 'return seen' },
    ]);
  });
});
