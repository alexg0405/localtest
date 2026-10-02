import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeCodeProvider, LocalDemoProvider, OpenAICompatibleProvider, claudeCodeStatus, describeProviderError, followUpPrompt } from './providers';

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
    expect(requests[0].body.messages[1].content).toMatch(/^Candidate background:\nBackend engineer\n\nQuestion: How does a hash map work\?\n\nAnswer format: STANDARD, /);
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

describe('OpenAICompatibleProvider.complete', () => {
  it('sends the given system prompt instead of the answer instructions', async () => {
    const requests = mockFetch(() => eventStream(delta('{"1":"C"}'), 'data: [DONE]\n\n'));
    expect(await new OpenAICompatibleProvider('https://llm.test/v1/chat/completions', '', 'test-model').complete('Label speakers.', 'Lines to label:\n1. I built it in Go')).toBe('{"1":"C"}');
    expect(requests[0].body.messages).toEqual([{ role: 'system', content: 'Label speakers.' }, { role: 'user', content: 'Lines to label:\n1. I built it in Go' }]);
  });
});

describe('ClaudeCodeProvider', () => {
  const ndjson = (...events: object[]) => eventStream(...events.map(event => `${JSON.stringify(event)}\n`));

  it('streams the answer from the local Claude Code bridge', async () => {
    const requests: { url: string; body: any }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => { requests.push({ url, body: JSON.parse(String(init.body)) }); return ndjson({ text: 'A hash map ' }, { text: 'stores pairs.' }, { done: true }); }));
    const chunks: string[] = [];
    const result = await new ClaudeCodeProvider('claude-sonnet-5-5').answer('How does a hash map work?', 'Candidate background:\nBackend engineer', 'SHORT', chunk => chunks.push(chunk));
    expect(result).toBe('A hash map stores pairs.');
    expect(chunks).toEqual(['A hash map ', 'stores pairs.']);
    expect(requests[0].url).toBe('/api/claude-code');
    expect(requests[0].body.model).toBe('claude-sonnet-5-5');
    expect(requests[0].body.prompt).toMatch(/^Candidate background:\nBackend engineer\n\nQuestion: How does a hash map work\?\n\nAnswer format: SHORT, /);
    expect(requests[0].body.prompt).toMatch(/If the interviewer is only greeting, making small talk, or introducing themselves, the team, or the product, reply with one or two friendly sentences instead\.$/);
  });

  it('tells the model beside the question when it is about the candidate as a person', async () => {
    const requests: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => { requests.push(JSON.parse(String(init.body))); return ndjson({ text: 'Sure.' }, { done: true }); }));
    const claude = new ClaudeCodeProvider('claude-haiku-4-5');
    for (const question of ['What do you like to do for fun?', 'How would your friends describe you?', "What's your biggest weakness?", 'How does a hash map work?']) await claude.answer(question, '', 'STANDARD');
    expect(requests[0].prompt).toMatch(/This question is about them as a person: lead with their personality and life outside work and school\. .* if a detail is missing, make a plausible, low-key choice and answer naturally/);
    expect(requests[1].prompt).toMatch(/about them as a person/);
    expect(requests[2].prompt).toMatch(/Keep it personal and honest: the example can come from school, friends, a club, or a hobby/);
    expect(requests[3].prompt).not.toMatch(/as a person|personal and honest/);
    expect(requests[0].system.length).toBeLessThanOrEqual(8000); // The bridge refuses longer system prompts.
  });

  it('runs one-off prompts, such as labeling speakers, without taking the process kept waiting for answers', async () => {
    const requests: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => { requests.push(JSON.parse(String(init.body))); return ndjson({ text: '{"1":"I"}' }, { done: true }); }));
    expect(await new ClaudeCodeProvider('claude-haiku-4-5').complete('Label speakers.', 'Lines to label:\n1. why Kafka')).toBe('{"1":"I"}');
    expect(requests[0]).toEqual({ model: 'claude-haiku-4-5', system: 'Label speakers.', prompt: 'Lines to label:\n1. why Kafka', warm: false });
  });

  it('warms up with the system prompt that every answer uses, whatever the mode', async () => {
    const requests: { url: string; body: any }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => { requests.push({ url, body: JSON.parse(String(init.body)) }); return url.endsWith('/warm') ? new Response(null, { status: 204 }) : ndjson({ done: true }); }));
    ClaudeCodeProvider.warm('claude-haiku-4-5');
    await new ClaudeCodeProvider().answer('q', '', 'SHORT'); await new ClaudeCodeProvider().answer('q', '', 'BULLETS');
    expect(requests.map(request => request.url)).toEqual(['/api/claude-code/warm', '/api/claude-code', '/api/claude-code']);
    expect(requests[0].body.model).toBe('claude-haiku-4-5');
    expect(new Set(requests.map(request => request.body.system)).size).toBe(1); // The waiting process only fits answers with the same system prompt.
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    expect(() => ClaudeCodeProvider.warm('claude-haiku-4-5')).not.toThrow();
    await new Promise(resolve => setTimeout(resolve, 0)); // No unhandled rejection either.
  });

  it('surfaces errors reported by the bridge', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ndjson({ text: 'partial' }, { error: 'Claude Code is not signed in to your Claude subscription.' })));
    await expect(new ClaudeCodeProvider().answer('q', '', 'STANDARD')).rejects.toThrow(/not signed in/);
  });

  it('explains that the bridge needs the dev server', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Not found', { status: 404 })));
    await expect(new ClaudeCodeProvider().answer('q', '', 'STANDARD')).rejects.toThrow(/npm start/);
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'Claude Code was not found.' }, 503)));
    await expect(new ClaudeCodeProvider().answer('q', '', 'STANDARD')).rejects.toThrow('Claude Code was not found.');
  });

  it('reads sign-in status without failing when the bridge is missing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ available: true, loggedIn: true, authMethod: 'claude.ai' })));
    expect(await claudeCodeStatus()).toEqual({ available: true, loggedIn: true, authMethod: 'claude.ai' });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    expect(await claudeCodeStatus()).toBeNull();
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

  it('asks for the follow-up on what the candidate actually said, for Follow-up on my answer', async () => {
    const probe = followUpPrompt('How would you scale it?', '  I would shard by user and cache the hot reads  ');
    expect(probe).toContain('about what the candidate actually said in reply, not about a suggested answer');
    expect(probe.endsWith('What they said: "I would shard by user and cache the hot reads"')).toBe(true);
    expect(followUpPrompt('How would you scale it?', ' ')).toBe(followUpPrompt('How would you scale it?')); // Nothing said yet.
    // The offline demo still finds the question in it.
    expect(await demo.answer(followUpPrompt('What is the difference between a process and a thread?', 'a process has its own memory'), '', 'SHORT')).toMatch(/^QUESTION\nWhy are threads generally cheaper/);
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
