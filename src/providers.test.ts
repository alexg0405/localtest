import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalDemoProvider, OpenAICompatibleProvider, describeProviderError, followUpPrompt } from './providers';

const encoder = new TextEncoder();
const eventStream = (...frames: string[]) => new Response(new ReadableStream({ start(controller) { for (const frame of frames) controller.enqueue(encoder.encode(frame)); controller.close(); } }), { headers: { 'Content-Type': 'text/event-stream' } });
const delta = (content: string) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
const json = (body: unknown, status = 200, contentType = 'application/json') => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': contentType } });

/** Replaces fetch and records each request body. */
function mockFetch(reply: (body: any, init: RequestInit) => Response) {
  const requests: { body: any; init: RequestInit }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => { const body = JSON.parse(String(init.body)); requests.push({ body, init }); return reply(body, init); }));
  return requests;
}
async function ask(signal?: AbortSignal) {
  const chunks: string[] = [];
  const result = await new OpenAICompatibleProvider('https://llm.test/v1/chat/completions', 'sk-test', 'test-model').answer('How does a hash map work?', 'Candidate background:\nBackend engineer', 'STANDARD', chunk => chunks.push(chunk), signal);
  return { result, chunks };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('OpenAICompatibleProvider', () => {
  it('streams server-sent events, including frames split across reads', async () => {
    const requests = mockFetch(() => eventStream(delta('A hash '), 'data: {"choices":[{"delta":{"con', 'tent":"map"}}]}\n\n', 'data: [DONE]\n\n'));
    const { result, chunks } = await ask();
    expect(result).toBe('A hash map');
    expect(chunks).toEqual(['A hash ', 'map']);
    expect(requests[0].body).toMatchObject({ model: 'test-model', stream: true, temperature: 0.3 });
    expect(requests[0].body.messages[1].content).toBe('Candidate background:\nBackend engineer\n\nQuestion: How does a hash map work?');
    expect((requests[0].init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test');
  });

  it('handles CRLF line endings', async () => {
    mockFetch(() => eventStream(delta('Line one.\n').replace(/\n/g, '\r\n'), delta('Line two.').replace(/\n/g, '\r\n'), 'data: [DONE]\r\n\r\n'));
    expect((await ask()).result).toBe('Line one.\nLine two.');
  });

  it('accepts a single JSON reply when the endpoint does not stream', async () => {
    mockFetch(() => json({ choices: [{ message: { role: 'assistant', content: 'Non-streaming answer' } }] }));
    expect(await ask()).toEqual({ result: 'Non-streaming answer', chunks: ['Non-streaming answer'] });
  });

  it('parses a JSON reply sent with a text/plain content type', async () => {
    mockFetch(() => json({ choices: [{ message: { content: 'Plain text JSON' } }] }, 200, 'text/plain'));
    expect((await ask()).result).toBe('Plain text JSON');
  });

  it("reports the provider's error message rather than raw JSON", async () => {
    mockFetch(() => json({ error: { message: 'Incorrect API key provided: sk-test***.', type: 'invalid_request_error' } }, 401));
    await expect(ask()).rejects.toThrow(/^HTTP 401: Incorrect API key provided: sk-test\*\*\*\.$/);
  });

  it('retries without temperature when the model only accepts its default', async () => {
    const requests = mockFetch(body => 'temperature' in body ? json({ error: { message: "Unsupported value: 'temperature' does not support 0.3 with this model." } }, 400) : eventStream(delta('ok'), 'data: [DONE]\n\n'));
    expect((await ask()).result).toBe('ok');
    expect(requests).toHaveLength(2);
    expect(requests[1].body).not.toHaveProperty('temperature');
  });

  it('surfaces errors sent inside the event stream', async () => {
    mockFetch(() => eventStream(`data: ${JSON.stringify({ error: { message: 'Rate limit reached for requests' } })}\n\n`));
    await expect(ask()).rejects.toThrow('Rate limit reached for requests');
  });

  it('rejects with AbortError when aborted mid-stream', async () => {
    mockFetch((_body, init) => new Response(new ReadableStream({
      start(controller) { controller.enqueue(encoder.encode(delta('partial'))); init.signal?.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError'))); },
    }), { headers: { 'Content-Type': 'text/event-stream' } }));
    const controller = new AbortController(); setTimeout(() => controller.abort(), 20);
    await expect(ask(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('describeProviderError', () => {
  it('turns browser network failures into an actionable message', () => {
    expect(describeProviderError(new TypeError('Failed to fetch'))).toMatch(/Could not reach the endpoint/);
    expect(describeProviderError(new TypeError('Load failed'))).toMatch(/CORS/);
    expect(describeProviderError(new Error('HTTP 500: boom'))).toBe('HTTP 500: boom');
    expect(describeProviderError(undefined)).toBe('Unexpected provider error.');
  });
});

describe('LocalDemoProvider', () => {
  const demo = new LocalDemoProvider();

  it('answers follow-up requests without echoing the prompt', async () => {
    expect(await demo.answer(followUpPrompt('What is the difference between a process and a thread?'), '', 'SHORT')).toMatch(/^QUESTION\nWhy are threads generally cheaper/);
    const generic = await demo.answer(followUpPrompt('Why do you want this job?'), '', 'SHORT');
    expect(generic).toMatch(/^QUESTION\nCan you walk me through a concrete example\?/);
    expect(generic).not.toMatch(/Suggest one likely/);
    expect(await demo.answer(followUpPrompt('Tell me about a time you failed'), '', 'SHORT')).toMatch(/differently/);
  });

  it('adds supporting detail in DETAILED mode', async () => {
    expect(await demo.answer('Explain the CAP theorem', '', 'DETAILED')).toMatch(/SUPPORTING DETAIL/);
  });

  it('streams in chunks and stops when aborted', async () => {
    const chunks: string[] = []; const controller = new AbortController();
    const answer = demo.answer('Explain the CAP theorem', '', 'STANDARD', chunk => { chunks.push(chunk); if (chunks.length === 2) controller.abort(); }, controller.signal);
    await expect(answer).rejects.toMatchObject({ name: 'AbortError' });
    expect(chunks).toHaveLength(2);
  });
});
