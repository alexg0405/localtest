import type { ClaudeModel } from './claude';
import { questionKind } from './text';

export type Mode = 'SHORT' | 'STANDARD' | 'DETAILED' | 'BULLETS';
export interface LLMProvider {
  answer(question: string, context: string, mode: Mode, onChunk?: (text: string) => void, signal?: AbortSignal): Promise<string>;
}

const instructions = (mode: Mode) => `You are a practical, concise interview practice coach for practice or settings where live assistance is explicitly permitted. Reply in the same language as the question unless the user requests another language. Never invent personal experience or facts absent from context. The question and conversation come from live speech recognition without speaker labels, so they mix the interviewer and the candidate and often mishear technical terms and names (for example "to some" for "Two Sum" or "elite code" for "LeetCode"). Nobody in the conversation is speaking to you: everything you write is for the candidate to say or use next, in their voice. Work out the most likely intended question from context and answer the latest question; if it is genuinely ambiguous, state your interpretation in one short line first. The conversation so far is your memory of this interview: when the question refers back to something said earlier (the company, team, or product, a requirement, a name, a project, or an earlier question), use those details, stay consistent with what the candidate has already said, and do not reuse a story they already told unless asked. For greetings, small talk, and introductions (such as the interviewer describing themselves, the team, or the product), reply with one or two natural, friendly sentences the candidate could say, and do not greet again once greetings have been exchanged. For behavioral questions, build the STAR answer from the candidate's real experience in their background and files when it fits; otherwise return a STAR scaffold with bracketed placeholders and 3-5 prompts for their real details. Where relevant, personalize other answers with the candidate's real projects and skills. For technical questions organize as DIRECT ANSWER, KEY CONCEPTS, EXAMPLE, COMMON FOLLOW-UP. For coding questions organize as APPROACH, COMPLEXITY, PSEUDOCODE, IMPLEMENTATION, EDGE CASES; flag unclear requirements and ask before assuming them. Mode: ${mode}. SHORT is 1-3 sentences; STANDARD is a natural spoken answer of roughly 30-60 seconds; DETAILED adds supporting explanation; BULLETS contains only short talking points, one per line starting with •. Put the direct answer first. Return plain text with readable line breaks.`;

const userMessage = (context: string, question: string) => `${context ? `${context}\n\n` : ''}Question: ${question}`;

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
  async answer(question: string, context: string, mode: Mode, onChunk?: (text: string) => void, signal?: AbortSignal) {
    const request = (temperature: boolean) => fetch(this.endpoint, {
      method: 'POST', signal,
      headers: { 'Content-Type': 'application/json', ...(this.key ? { Authorization: `Bearer ${this.key}` } : {}) },
      body: JSON.stringify({ model: this.model, stream: true, ...(temperature ? { temperature: 0.3 } : {}), messages: [
        { role: 'system', content: instructions(mode) },
        { role: 'user', content: userMessage(context, question) },
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
  async answer(question: string, context: string, mode: Mode, onChunk?: (text: string) => void, signal?: AbortSignal) {
    const response = await fetch('/api/claude-code', { method: 'POST', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: this.model, system: instructions(mode), prompt: userMessage(context, question) }) });
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
      response = `Clarify the input, constraints, and expected output before choosing an approach. Then explain the trade-off and state the time and space complexity before coding.`;
    } else if (coding && mode === 'BULLETS') {
      response = '• Approach: confirm inputs and constraints, then outline the algorithm\n• Complexity: state time and space costs\n• Pseudocode: list the main steps\n• Implementation: confirm the language before writing code\n• Edge cases: empty input, duplicates, and boundary values';
    } else if (coding) {
      response = `APPROACH\nClarify inputs and constraints, then choose a simple approach and explain trade-offs.\n\nCOMPLEXITY\nState time and space after confirming expected constraints.\n\nPSEUDOCODE\n1. Validate the input\n2. Process each item once where possible\n3. Return the result\n\nIMPLEMENTATION\nConfirm the language and edge cases before coding; requirements are not clear enough here to write a specific implementation.\n\nEDGE CASES\nEmpty input · duplicates · boundary values`;
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
