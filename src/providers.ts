export type Mode = 'SHORT' | 'STANDARD' | 'DETAILED' | 'BULLETS';
export interface LLMProvider {
  answer(question: string, context: string, mode: Mode, onChunk?: (text: string) => void, signal?: AbortSignal): Promise<string>;
}

const instructions = (mode: Mode) => `You are a practical, concise interview practice coach for practice or settings where live assistance is explicitly permitted. Reply in the same language as the question unless the user requests another language. Never invent personal experience or facts absent from context. If a transcript is uncertain, say what you understood and ask for clarification. For behavioral questions return a STAR scaffold with bracketed placeholders and 3-5 prompts for the user's real details. For technical questions organize as DIRECT ANSWER, KEY CONCEPTS, EXAMPLE, COMMON FOLLOW-UP. For coding questions organize as APPROACH, COMPLEXITY, PSEUDOCODE, IMPLEMENTATION, EDGE CASES; flag unclear requirements and ask before assuming them. Mode: ${mode}. SHORT is 1-3 sentences; STANDARD is a natural spoken answer of roughly 30-60 seconds; DETAILED adds supporting explanation; BULLETS contains only talking points. Put the direct answer first. Return plain text with readable line breaks.`;

export class OpenAICompatibleProvider implements LLMProvider {
  constructor(private endpoint: string, private key: string, private model = 'gpt-4o-mini') {}
  async answer(question: string, context: string, mode: Mode, onChunk?: (text: string) => void, signal?: AbortSignal) {
    const response = await fetch(this.endpoint, {
      method: 'POST', signal,
      headers: { 'Content-Type': 'application/json', ...(this.key ? { Authorization: `Bearer ${this.key}` } : {}) },
      body: JSON.stringify({ model: this.model, stream: true, temperature: 0.3, messages: [
        { role: 'system', content: instructions(mode) },
        { role: 'user', content: `Relevant background: ${context || 'None provided.'}\n\nQuestion: ${question}` },
      ] }),
    });
    if (!response.ok) throw new Error(`${response.status}: ${await response.text().catch(() => response.statusText)}`);
    if (!response.body) throw new Error('The provider did not return a streaming response.');
    const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = ''; let full = '';
    const consume = (raw: string) => {
      const line = raw.trim(); if (!line.startsWith('data:')) return false;
      const data = line.slice(5).trim(); if (data === '[DONE]') return true;
      try { const part = JSON.parse(data).choices?.[0]?.delta?.content; if (typeof part === 'string' && part) { full += part; onChunk?.(part); } } catch { /* Ignore incomplete or non-content SSE frames. */ }
      return false;
    };
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split('\n'); buffer = events.pop() ?? '';
      for (const raw of events) {
        if (consume(raw)) { await reader.cancel().catch(() => undefined); return full; }
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) consume(buffer);
    return full;
  }
}

export class LocalDemoProvider implements LLMProvider {
  async answer(question: string, _context: string, mode: Mode, onChunk?: (text: string) => void, signal?: AbortSignal) {
    const q = question.toLowerCase(); let response: string;
    const behavioral = /tell me about|time you|disagree|challenge|conflict|failure|leadership|strength|weakness/.test(q);
    const coding = /code|implement|algorithm|function|array|reverse|binary search/.test(q);
    const processThread = /process.*thread|thread.*process/.test(q);
    if (behavioral) {
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
    if (mode === 'DETAILED' && !behavioral) response += '\n\nSUPPORTING DETAIL\nAdd the assumptions, trade-offs, and a second example that would help an interviewer follow your reasoning.';
    for (let i = 0; i < response.length; i += 16) { if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError'); await new Promise(resolve => setTimeout(resolve, 8)); onChunk?.(response.slice(i, i + 16)); }
    return response;
  }
}
