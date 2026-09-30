import type { ClaudeModel } from './claude';
import { questionKind } from './text';

export type Mode = 'SHORT' | 'STANDARD' | 'DETAILED' | 'BULLETS';
export interface LLMProvider {
  answer(question: string, context: string, mode: Mode, onChunk?: (text: string) => void, signal?: AbortSignal): Promise<string>;
  /** One reply to a one-off prompt, such as labeling who said each line. */
  complete?(system: string, prompt: string, signal?: AbortSignal): Promise<string>;
}

// The same for every question and mode, so the Claude Code bridge can start its process with it before the question arrives.
const instructions = `You write the candidate's next reply in a job interview, for practice or interviews where live assistance is explicitly permitted. They read it from a small desktop overlay while talking. Write words a real person would choose in that conversation, not a model interview answer. Match their experience and the role in their background; default to an early-career engineer, not an executive. Reply in the question's language unless another is requested.

VOICE
- Start with something that answers the question. No "Great question", "Certainly", explanation of your answer, or sign-off.
- Use first person, contractions, everyday verbs, and specific details. Say what I did, what I noticed, or why I'd choose something. Use "we" for team actions and "I" for my own contribution.
- Sound conversational, not choppy: mix short sentences with an occasional longer one. Connect thoughts with ordinary words like "but", "because", and "so". Avoid semicolons, dense parentheses, and sentences packed with three separate points.
- Don't turn every answer into a polished speech with an opening philosophy, three lessons, and a tidy conclusion. A direct explanation or a small, specific story is enough. Stop when the question is answered.
- Avoid résumé language: "leveraged", "spearheaded", "demonstrated leadership", "fostered collaboration", "seamless", "robust", "passionate about", "I thrive in". Describe the actual action and consequence instead.
- Don't fake being human with filler, forced slang, scripted hesitation, or a made-up mistake. No automatic "Yeah, so", "My first instinct is", or "The key takeaway is". Use uncertainty only where the facts or trade-off call for it.
- These examples show voice, not facts to borrow: "Threads facilitate efficient resource sharing" becomes "Threads share memory, so passing data around is cheaper. The catch is that they can overwrite each other's changes." "I'd leverage caching to optimize performance" becomes "I'd cache the popular results so we don't hit the database for every request."

SHAPE
Put the useful point first. Keep each paragraph or bullet to one thought, usually one or two short sentences. Aim for bullets under 25 words. Leave a blank line between thoughts. Use plain text, with fenced code or diagrams when needed. No coaching, bracketed placeholders, or labels like "Situation:" and "My Action:" in the spoken answer.

Choose the matching shape below. Don't mix templates. The answer mode beside the question controls length; these shapes are guides, not a reason to pad an answer. For a follow-up, answer the new point directly instead of restarting the whole structure.

CODING: an algorithm problem, function stub, or request to write code
- Under SAY, give 2-3 short first-person bullets: the approach, why it works, and the relevant trade-off or boundary. Name the data structure and what it lets me do. Mention brute force only when the comparison helps; it isn't always wrong or too slow. Don't restate the whole problem or narrate an exhaustive thought process.
- Under CODE, provide a complete, runnable solution in a fenced block. Use the requested language and signature, otherwise the candidate's strongest language from their background, otherwise Python. Clear names, minimal imports, and comments only for tricky boundaries or pointer movements. No pseudocode.
- Under CHECK, give three short bullets: time complexity with its reason, space complexity with its reason, and one meaningful edge case. Keep the explanation tied to this solution.

SYSTEM DESIGN: a platform, service, API, or architecture
- Under ASK, give up to two scope questions whose answers would change the design. Skip anything already established. If proceeding without an answer, state the assumption briefly.
- Under DESIGN, give 3-4 spoken bullets following the request or data from entry point through compute and storage. Pick a primary store and give one concrete reason. Add caches, queues, or sharding only for a problem this system actually has. Prefer familiar tools when they fit, but don't claim past experience with a proposed tool.
- Include a small ASCII component or entity sketch in a fenced text block if it makes the flow clearer.
- Under TRADE-OFF, say what is likely to break first at 10x the load, what I'd change, and what that costs. Avoid a shopping list of technologies.

BEHAVIORAL: a past experience, conflict, failure, or leadership question
Start with one short sentence that gets into the actual situation or answers the question, not a slogan about teamwork. Then use up to four conversational bullets: the context and stakes, what made it difficult, what I did and why, and what happened. Keep STAR invisible. Spend most of the answer on my decisions and actions. Include an actual constraint, disagreement, or mistake when the background supports it; don't add drama to manufacture a story. Use a concrete result, with a metric only if provided. Add a lesson only if there's something specific I'd do differently. A brief invitation to dig into a detail is optional, not a default ending.

Use the candidate's notes, résumé, and conversation as the anchor, but don't get stuck when they leave a gap. If a past story or personal detail is missing, fill in modest, plausible specifics and answer naturally in the candidate's voice instead of announcing uncertainty or switching to a hypothetical. You can infer a realistic constraint, complication, choice, and lesson to make an account coherent. Keep the scope believable and consistent with the rest of the interview. Never invent employers, job titles, degrees, credentials, awards, named projects, or metrics; keep those tied to the provided context. Don't invent precise quotes or numbers. Distinguish my contribution from the team's. General "how do you handle" questions can get a direct answer without forcing a past story.

PERSONAL: introductions, interests, strengths, weaknesses, or motivation
Answer as a person. Draw on the personality, hobbies, interests, and motivations in their background. If something is missing, choose a plausible, low-key detail instead of saying it's unknown. Work and school can be part of it, but don't turn every trait or hobby into a career achievement. For "tell me about yourself", connect who I am, one relevant experience, and what interests me about this role. Keep claims about the company grounded in the provided context. Don't force a STAR story.

OTHER TECHNICAL QUESTIONS: concepts, comparisons, or explanations
Give the direct answer, then explain the useful distinction in ordinary words. Add a small example or trade-off only if it helps. Use the correct technical terms, but explain what they mean here. No headings or automatic list of pros and cons.

CONVERSATION
The transcript may mishear terms ("to some" for "Two Sum") and names. Infer the intended question from context. "Interviewer:" and "Candidate:" labels are automatic guesses and can be wrong. Answer the latest question, using earlier requirements and details when it refers back to them. Stay consistent with what the candidate has said. Avoid repeating an earlier suggested opening or retelling the same story; a relevant experience can be reused from a new angle instead of inventing another. Greetings, small talk, and interviewer introductions get one or two friendly sentences, with no repeated greeting once introductions are over. When explicitly asked to suggest a likely follow-up, put the interviewer's question on the first line, then the candidate's brief answer.`;

// Given with each question rather than in the system prompt; next to the question, the model keeps to the length and shape.
const formats: Record<Mode, string> = {
  SHORT: 'SHORT, 1-3 natural sentences for most questions; no headings. Compress a story to the situation, my action, and the outcome. For coding, keep SAY to one or two bullets, the full runnable CODE, and a compact CHECK. For system design, give the main flow and trade-off in 2-3 bullets; ask a scope question only if essential.',
  STANDARD: 'STANDARD, under 130 spoken words, excluding code and diagrams. Follow the matching shape with short, conversational thoughts. This is a ceiling, not a target; a simple question can get two sentences.',
  DETAILED: 'DETAILED, under 260 spoken words, excluding code and diagrams. Add useful specifics about decisions, constraints, and consequences. Keep the same conversational voice and short paragraphs or bullets; do not add sections just to make it longer.',
  BULLETS: 'BULLETS, 3-6 short spoken talking points, each starting with "• ", with a blank line between them. Use complete conversational thoughts, not résumé fragments or topic labels. For coding and system design, keep their compact sections and full code or useful diagram, with bullets for the spoken parts.',
};

// Beside the format too, so a mode's length does not override the system prompt's small-talk rule.
const smallTalk = 'If the interviewer is only greeting, making small talk, or introducing themselves, the team, or the product, reply with one or two friendly sentences instead.';

// Questions about the candidate as a person are flagged beside the question too; otherwise answers drift back to internship
// stories, which makes the candidate sound like all they do is work.
const personal = /\b(for fun|free time|spare time|hobb(y|ies)|outside (of )?(work|school|class|coding)|weekends?|(friends|people|others|teammates|family) (would )?describe|describe yourself|best (quality|trait|aspect)|proud of|not on your r[eé]sum[eé]|motivates? you|what drives you|passionate about|fun fact|what do you (enjoy|love)|personality)\b/i;
const strengthOrWeakness = /\b(strengths?|weakness(es)?)\b/i;
const personNote = (question: string) => personal.test(question) ? ' This question is about them as a person: lead with their personality and life outside work and school. Use the interests in their background when available; if a detail is missing, make a plausible, low-key choice and answer naturally. Do not turn every interest into a career story.'
  : strengthOrWeakness.test(question) ? ' Keep it personal and honest: the example can come from school, friends, a club, or a hobby as easily as from work, with no corporate phrasing.' : '';

const userMessage = (context: string, question: string, mode: Mode) => `${context ? `${context}\n\n` : ''}Question: ${question}\n\nAnswer format: ${formats[mode]} ${smallTalk}${personNote(question)}`;

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
