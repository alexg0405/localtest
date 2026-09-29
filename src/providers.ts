import type { ClaudeModel } from './claude';
import { questionKind } from './text';

export type Mode = 'SHORT' | 'STANDARD' | 'DETAILED' | 'BULLETS';
export interface LLMProvider {
  answer(question: string, context: string, mode: Mode, onChunk?: (text: string) => void, signal?: AbortSignal): Promise<string>;
  /** One reply to a one-off prompt, such as labeling who said each line. */
  complete?(system: string, prompt: string, signal?: AbortSignal): Promise<string>;
}

// The same for every question and mode, so the Claude Code bridge can start its process with it before the question arrives.
const instructions = `You write the candidate's side of a job interview, for practice or interviews where live assistance is explicitly permitted: the exact words they will say next, which they read at a glance while talking. The candidate is a college student, about 19 or 20, interviewing for an internship or co-op (unless their background says otherwise), so sound like a sharp, friendly student talking to an interviewer: first person, plain everyday words, contractions, short sentences, straightforward and confident without sounding rehearsed. No corporate buzzwords ("leverage", "spearheaded", "synergy", "passionate about", "I thrive in"), no big claims a student could not back up, no filler ("like", "you know"), and no preamble ("Great question", "Here's a strong answer"). Write only what they will say: no labels such as "Situation:", no coaching, no bracketed placeholders, and never ask them for details or tell them to think of an example. Never talk about the background itself (whether it is there, missing, or thin) or about the answer you are giving; just give it. Reply in the same language as the question unless the user requests another language.

Coding problems (LeetCode-style questions, "write a function that…", "how would you implement…") get the candidate's whole thinking process out loud, under these headings, each in capitals on its own line:
THE PROBLEM: restate it in a sentence or two in their own words, with the input, the output, and a tiny example. If something that matters is unclear, add one short clarifying question and the assumption they will go with.
MY THINKING: their honest first take: the brute-force idea and why it is too slow, then the observation that gets to something better.
WHAT I'D USE: the data structures and technique (a hash map, two pointers, a stack, a heap, BFS, sorting, dynamic programming, and so on), each with one plain reason.
PSEUDOCODE: short numbered steps.
CODE: a complete, correct solution in a \`\`\` fenced block, in the language the interviewer asked for, otherwise the one the candidate knows best from their background, otherwise Python. Clear names; a comment or two at most.
COMPLEXITY: time and space, each with a short reason.
EDGE CASES: the few cases they would check, then a quick run through the example.
Keep everything but the code short and spoken ("So my first thought is…", "I'd use a hash map here because…"). A design question (a system, an API, a class) follows the same flow: restate it, first thoughts, the pieces they would use and why, then a sketch.

For other technical questions (a concept, "what's the difference between…", "how does … work"), explain it the way a student who really gets it would explain it to a friend, in a few sentences rather than a textbook answer: the direct answer in one sentence, the key idea in plain words, a quick concrete example (from their own projects when one fits), and a trade-off if there is one. Skip the jargon a friend would not need.

Treat the candidate background (their notes, résumé, and other files) as the facts of their life. For behavioral questions (a time they disagreed, failed, led, or worked under pressure, and so on), pick the one experience from the background that fits best (an internship, co-op, job, class project, club, or hackathon) and tell it as a short, specific story in the first person: what was going on, what they had to do, what they actually did and why, and how it turned out and what they learned. Keep it real and a little humble; a student's stakes are fine. Use the real names of the company, project, team, and technologies. Backgrounds rarely record the exact moment a question asks about, so describe a realistic one that fits what that experience involved; keep invented specifics modest and believable, and never invent employers, job titles, degrees, awards, or metrics that are not in the background. If nothing in the background fits, or there is no background, use a realistic example a student could adapt. Answer questions about themselves, their motivation, their strengths and weaknesses, and the role or company the same way.

The question and conversation come from live speech recognition, so they often mishear technical terms and names (for example "to some" for "Two Sum" or "elite code" for "LeetCode"). Conversation lines may start with "Interviewer:" or "Candidate:"; those labels are automatic guesses that can be wrong, and unlabeled lines could be either person. Work out the most likely intended question and answer the latest one; if it is genuinely ambiguous, answer the most likely reading. The conversation so far is your memory of this interview: when the question refers back to something said earlier (the company, team, or product, a requirement, a name, a project, or an earlier question), use those details, stay consistent with what the candidate has already said, and do not retell a story they already told unless asked. For greetings, small talk, and introductions (such as the interviewer describing themselves, their team, or the product), reply with one or two friendly sentences, and do not greet again once greetings have been exchanged.

When asked for a likely follow-up, put the interviewer's follow-up question on the first line, then the candidate's answer.

Use plain text with short paragraphs, put the most important sentence first, and keep to the answer format given with the question.`;

// Given with each question rather than in the system prompt; next to the question, the model keeps to the length and shape.
const formats: Record<Mode, string> = {
  SHORT: 'SHORT, 1-3 sentences. For a coding problem: every heading and the full code, but only one short sentence under each other heading (PSEUDOCODE in three or four steps).',
  STANDARD: 'STANDARD, about 45 seconds of speech: under 130 words. A coding problem gets the full thinking process and code instead, with the talking parts kept short.',
  DETAILED: 'DETAILED, up to two minutes of speech with more specifics and reasoning: under 300 words. A coding problem gets the full thinking process and code, with a bit more reasoning under each heading.',
  BULLETS: 'BULLETS, 3-6 short talking points in the order they would say them, one per line starting with "• ", each a few words to one short sentence. A coding problem keeps its headings and code, with bullet points under the other headings.',
};

// Beside the format too, or a mode's length (such as STANDARD's 45 seconds) wins over the system prompt's small-talk rule.
const smallTalk = 'If the interviewer is only greeting, making small talk, or introducing themselves, the team, or the product, reply with one or two friendly sentences instead.';

const userMessage = (context: string, question: string, mode: Mode) => `${context ? `${context}\n\n` : ''}Question: ${question}\n\nAnswer format: ${formats[mode]} ${smallTalk}`;

const followUpLead = 'Suggest one likely interviewer follow-up to this question:';
/** Prompt for the "Generate follow-up" action; the UI keeps showing the original question. */
export const followUpPrompt = (question: string) => `${followUpLead} "${question}". State the follow-up question first, then a brief suggested answer.`;

/** Turns network failures into an actionable message; HTTP errors already carry the provider's own message. */
export function describeProviderError(reason: any) {
  const message = String(reason?.message || 'Unexpected provider error.');
  return /Failed to fetch|Load failed|NetworkError/i.test(message) ? 'Could not reach the endpoint. Check the URL and your network, and confirm the endpoint allows browser (CORS) requests.' : message;
}
const errorDetail = (value: any): string => [value?.error?.message, value?.message, value?.detail, value?.error].find(item => typeof item === 'string' && item.trim()) || '';
function httpError(status: number, body: string) {
  let detail = body.trim(); try { detail = errorDetail(JSON.parse(body)) || detail; } catch { /* Plain-text error body. */ }
  return new Error(`HTTP ${status}${detail ? `: ${detail.slice(0, 300)}` : ''}`);
}
function messageText(data: any) {
  if (data?.error) throw new Error(errorDetail(data) || 'The provider returned an error.');
  const content = data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text;
  return typeof content === 'string' ? content : Array.isArray(content) ? content.map(part => part?.text || '').join('') : '';
}

export class OpenAICompatibleProvider implements LLMProvider {
  constructor(private endpoint: string, private key: string, private model = 'gpt-4o-mini') {}
  answer(question: string, context: string, mode: Mode, onChunk?: (text: string) => void, signal?: AbortSignal) { return this.chat(instructions, userMessage(context, question, mode), onChunk, signal); }
  complete(system: string, prompt: string, signal?: AbortSignal) { return this.chat(system, prompt, undefined, signal); }
  private async chat(system: string, user: string, onChunk?: (text: string) => void, signal?: AbortSignal) {
    const request = (temperature: boolean) => fetch(this.endpoint, {
      method: 'POST', signal,
      headers: { 'Content-Type': 'application/json', ...(this.key ? { Authorization: `Bearer ${this.key}` } : {}) },
      body: JSON.stringify({ model: this.model, stream: true, ...(temperature ? { temperature: 0.3 } : {}), messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ] }),
    });
    let response = await request(true);
    if (!response.ok) {
      let body = await response.text().catch(() => '');
      // Some models (for example reasoning models) only accept their default temperature.
      if (response.status === 400 && /temperature/i.test(body)) { response = await request(false); body = response.ok ? '' : await response.text().catch(() => ''); }
      if (!response.ok) throw httpError(response.status, body || response.statusText);
    }
    if (/application\/json/i.test(response.headers.get('content-type') || '')) { const full = messageText(await response.json()); if (full) onChunk?.(full); return full; }
    if (!response.body) throw new Error('The provider did not return a response body.');
    const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = ''; let full = ''; let raw = ''; let sawEvent = false;
    const consume = (line: string) => {
      const event = line.trim(); if (!event.startsWith('data:')) return false;
      sawEvent = true; const data = event.slice(5).trim(); if (data === '[DONE]') return true;
      let frame: any; try { frame = JSON.parse(data); } catch { return false; /* Ignore incomplete or non-JSON SSE frames. */ }
      if (frame?.error) throw new Error(errorDetail(frame) || 'The provider reported an error while streaming.');
      const part = frame?.choices?.[0]?.delta?.content; if (typeof part === 'string' && part) { full += part; onChunk?.(part); }
      return false;
    };
    try {
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        const text = decoder.decode(value, { stream: true }); buffer += text; if (!sawEvent && raw.length < 200_000) raw += text;
        const events = buffer.split('\n'); buffer = events.pop() ?? '';
        for (const line of events) {
          if (consume(line)) { await reader.cancel().catch(() => undefined); return full; }
        }
      }
      const tail = decoder.decode(); buffer += tail; if (!sawEvent) raw += tail;
      if (buffer.trim()) consume(buffer);
    } catch (reason) { void reader.cancel().catch(() => undefined); throw reason; }
    // Endpoints that ignore `stream: true` may reply with one JSON document instead of server-sent events.
    if (!sawEvent && raw.trim()) {
      let data: any; try { data = JSON.parse(raw); } catch { return full; }
      full = messageText(data); if (full) onChunk?.(full);
    }
    return full;
  }
}

/** Answers with your Claude subscription through the Claude Code bridge that `npm run dev` serves (server/claude-code-bridge.ts). */
export class ClaudeCodeProvider implements LLMProvider {
  constructor(private model: ClaudeModel = 'claude-haiku-4-5') {}
  answer(question: string, context: string, mode: Mode, onChunk?: (text: string) => void, signal?: AbortSignal) { return this.stream({ model: this.model, system: instructions, prompt: userMessage(context, question, mode) }, onChunk, signal); }
  /** Skips the Claude Code process kept waiting for answers (warm: false), so the next answer still starts right away. */
  complete(system: string, prompt: string, signal?: AbortSignal) { return this.stream({ model: this.model, system, prompt, warm: false }, undefined, signal); }
  private async stream(body: { model: ClaudeModel; system: string; prompt: string; warm?: boolean }, onChunk?: (text: string) => void, signal?: AbortSignal) {
    const response = await fetch('/api/claude-code', { method: 'POST', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!response.ok) throw new Error(await bridgeError(response));
    if (!response.body) throw new Error('The Claude Code bridge returned no answer.');
    const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = ''; let full = '';
    const consume = (line: string) => {
      if (!line.trim()) return;
      const event = JSON.parse(line);
      if (typeof event.error === 'string') throw new Error(event.error);
      if (typeof event.text === 'string') { full += event.text; onChunk?.(event.text); }
    };
    try {
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        buffer += decoder.decode(value, { stream: true }); const lines = buffer.split('\n'); buffer = lines.pop() ?? '';
        for (const line of lines) consume(line);
      }
      consume(buffer + decoder.decode());
    } catch (reason) { void reader.cancel().catch(() => undefined); throw reason; }
    return full;
  }
  /** Has the bridge start Claude Code before the first question, so that answer does not wait for it to boot. Uses none of your Claude usage. */
  static warm(model: ClaudeModel) {
    void fetch('/api/claude-code/warm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, system: instructions }) }).catch(() => undefined);
  }
}
async function bridgeError(response: Response) {
  if (response.status === 404) return 'Answers from your Claude subscription need the local dev server. Start Roomside with `npm start`.';
  try { return (await response.json()).error || `HTTP ${response.status}`; } catch { return `HTTP ${response.status}`; }
}
export type ClaudeCodeStatus = { available: boolean; loggedIn: boolean; authMethod?: string };
/** Whether Claude Code is installed and signed in; this does not use any of your Claude usage. */
export async function claudeCodeStatus(): Promise<ClaudeCodeStatus | null> {
  try { const response = await fetch('/api/claude-code/status'); return response.ok ? await response.json() : null; } catch { return null; }
}

export class LocalDemoProvider implements LLMProvider {
  async answer(question: string, _context: string, mode: Mode, onChunk?: (text: string) => void, signal?: AbortSignal) {
    const followUp = question.startsWith(followUpLead);
    const original = followUp ? question.slice(followUpLead.length).replace(/^\s*"|"\. State the follow-up question first.*$/gs, '') : question;
    const q = original.toLowerCase(); let response: string;
    const kind = questionKind(original); const smallTalk = kind === 'SMALL TALK'; const behavioral = kind === 'BEHAVIORAL'; const coding = kind === 'CODING';
    const processThread = /process.*thread|thread.*process/.test(q);
    if (followUp) {
      if (processThread) response = 'QUESTION\nWhy are threads generally cheaper to create than processes?\n\nSUGGESTED ANSWER\nA new thread reuses its process’s address space and open resources, so the OS only sets up a stack and scheduling state. A new process needs its own memory mappings and resource tables.';
      else if (behavioral) response = 'QUESTION\nWhat would you do differently if it happened again?\n\nSUGGESTED ANSWER\n[Name one specific change] · [Why it would help] · [Where you have applied that lesson since]';
      else if (coding) response = 'QUESTION\nCan you improve the time or space complexity?\n\nSUGGESTED ANSWER\nRestate the current complexity, name the bottleneck, and describe the trade-off of a faster approach before changing any code.';
      else response = 'QUESTION\nCan you walk me through a concrete example?\n\nSUGGESTED ANSWER\nPick one real situation, describe it in two or three sentences, and connect it back to your main point.';
    } else if (smallTalk) {
      response = "I'm doing well, thanks for asking. I'm excited to be here and looking forward to our conversation. How has your day been so far?";
    } else if (behavioral) {
      if (mode === 'BULLETS') response = `• Situation: Recall a specific moment and its context\n• Task: State what you were responsible for\n• Action: Explain the steps you took and why\n• Result: Share the outcome and what you learned\n• Recall: What was at stake? How did you communicate? What changed?`;
      else response = `Situation: [Recall a specific moment and the context]\nTask: [What were you responsible for?]\nAction: [Describe the steps you took and why]\nResult: [Share the outcome and what you learned]\n\nTo make it specific: What was at stake? How did you communicate? What changed? What would your teammate say?`;
    } else if (coding && mode === 'SHORT') {
      response = `So I'd restate the problem with a tiny example, say the brute force and why it's slow, then use something like a hash map to get it down to one pass, write it, and give the complexity.`;
    } else if (coding && mode === 'BULLETS') {
      response = "THE PROBLEM\n• What goes in, what comes out, and a tiny example\n\nMY THINKING\n• Brute force first, and why it's too slow\n\nWHAT I'D USE\n• A hash map for one-pass lookups (or two pointers if it's sorted)\n\nCODE\n```python\ndef solve(items):\n    seen = {}\n    for index, item in enumerate(items):\n        seen[item] = index\n    return seen\n```\n\nCOMPLEXITY\n• O(n) time, O(n) space";
    } else if (coding) {
      response = "THE PROBLEM\nSo first I'd restate it: what goes in, what comes out, and a tiny example. If something's unclear, like whether the input can be empty, I'd ask.\n\nMY THINKING\nMy first thought is brute force, checking every option, which works but is slow. Then I'd look at what I keep recomputing and whether I can remember it instead.\n\nWHAT I'D USE\nProbably a hash map so each lookup is O(1), or two pointers if the input is sorted.\n\nPSEUDOCODE\n1. Handle the empty case\n2. Go through the input once, keeping what I need in the map\n3. Return as soon as I find the answer\n\nCODE\n```python\ndef solve(items):\n    seen = {}\n    for index, item in enumerate(items):\n        seen[item] = index\n    return seen\n```\n\nCOMPLEXITY\nOne pass, so O(n) time, and the map is O(n) space.\n\nEDGE CASES\nEmpty input, duplicates, and negative numbers. Then I'd walk through the example out loud.";
    } else if (processThread && mode === 'SHORT') {
      response = 'A process has its own isolated memory space; threads run within a process and share its memory. Threads are lighter to coordinate, but shared state needs synchronization.';
    } else if (processThread && mode === 'BULLETS') {
      response = '• Process: isolated memory and resources\n• Threads: share a process memory space, with their own stacks\n• Trade-off: faster sharing requires synchronization\n• Example: browser tabs can run in separate processes';
    } else if (processThread) {
      response = `A process is an executing program with its own memory space and resources. Threads are execution paths within a process; they share its memory but each has its own stack and registers.\n\nKEY CONCEPTS\n• Processes are isolated; threads share state\n• Sharing makes thread communication cheaper, but synchronization is needed\n• Switching between processes usually has more overhead\n\nEXAMPLE\nA browser can isolate tabs in processes while using threads for work within a tab.\n\nCOMMON FOLLOW-UP\nWhy are threads generally cheaper to create?`;
    } else if (mode === 'SHORT') {
      response = `Start with a direct answer to “${question}”. Support it with one clear example or practical implication.`;
    } else if (mode === 'BULLETS') {
      response = `• Answer the central question: ${question}\n• Explain the key idea\n• Give one concrete example\n• Mention a trade-off or likely follow-up`;
    } else {
      response = `A strong answer starts with the main idea, then supports it with a concrete example. For “${question}”, define the key terms clearly, explain why the distinction matters, and close with a practical implication.\n\nKEY CONCEPTS\n• Lead with the direct answer\n• Add one specific example\n• Mention a trade-off when relevant\n\nEXAMPLE\nUse a real situation or small example to make the concept concrete.\n\nCOMMON FOLLOW-UP\nCan you walk through a concrete example?`;
    }
    if (mode === 'DETAILED' && !behavioral && !followUp && !smallTalk) response += '\n\nSUPPORTING DETAIL\nAdd the assumptions, trade-offs, and a second example that would help an interviewer follow your reasoning.';
    for (let i = 0; i < response.length; i += 16) { if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError'); await new Promise(resolve => setTimeout(resolve, 8)); onChunk?.(response.slice(i, i + 16)); }
    return response;
  }
}
