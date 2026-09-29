// What answers remember of the conversation: all of it while it fits, otherwise its opening and the latest part.

export type HeardLine = { text: string; at: number };

/** About 10k tokens: all of a typical 45 to 60 minute interview. */
export const memoryBudget = 40_000;
/** Introductions (names, the team, the product) are what later questions most often refer back to. */
const openingBudget = 6_000;

const cost = (line: HeardLine) => line.text.length + 1;
export const heardCharacters = (lines: readonly HeardLine[]) => lines.reduce((sum, line) => sum + cost(line), 0);

/** The transcript to send with a question, oldest first. When it is over budget, the middle is left out and marked. */
export function conversationMemory(lines: readonly HeardLine[], budget = memoryBudget) {
  if (heardCharacters(lines) <= budget) return { text: lines.map(line => line.text).join('\n'), omitted: 0 };
  let start = 0; let used = 0;
  while (start < lines.length && used + cost(lines[start]) <= Math.min(openingBudget, budget / 4)) used += cost(lines[start++]);
  let end = lines.length; const room = budget - 100; // Space for the note about what was left out.
  while (end > start && used + cost(lines[end - 1]) <= room) used += cost(lines[--end]);
  const skipped = lines.slice(start, end);
  const minutes = Math.max(1, Math.round((skipped[skipped.length - 1].at - skipped[0].at) / 60_000));
  const note = `[… ${skipped.length} line${skipped.length === 1 ? '' : 's'} (about ${minutes} minute${minutes === 1 ? '' : 's'}) of the conversation left out here to save space …]`;
  return { text: [...lines.slice(0, start).map(line => line.text), note, ...lines.slice(end).map(line => line.text)].join('\n'), omitted: skipped.length };
}
