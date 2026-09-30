// Main questions: the overarching questions or cases an interview works through after the introductions (a case, a coding
// problem, "tell me about yourself"), which the smaller questions, hints, and back-and-forth happen around. A review by the
// answer provider keeps the list, rewording an entry as the transcript makes it clearer, and says which is being worked on.

/** `from` is the id of the transcript line it was first asked at. */
export type Topic = { id: number; title: string; question: string; from?: number };
export type Topics = { list: Topic[]; current: number | null };
export const noTopics: Topics = { list: [], current: null };
type TopicLine = { id: number; text: string; speaker?: 'interviewer' | 'candidate' };

/** The review request: the list so far, and the transcript numbered by line id (the latest of it, within `limit`). */
export function topicsPrompt(lines: readonly TopicLine[], topics: Topics, limit = 12_000) {
  const named = (line: TopicLine) => `#${line.id} ${line.speaker === 'interviewer' ? 'Interviewer' : line.speaker === 'candidate' ? 'Candidate' : 'Unlabeled'}: ${line.text}`;
  const kept: string[] = []; let used = 0;
  for (let index = lines.length - 1; index >= 0; index--) { const text = named(lines[index]); if (kept.length && used + text.length > limit) break; kept.unshift(text); used += text.length + 1; }
  const list = topics.list.length ? topics.list.map(topic => `${topic.id}. ${topic.title}: ${topic.question}${topic.from ? ` (from #${topic.from})` : ''}${topic.id === topics.current ? ' [current]' : ''}`).join('\n') : 'none yet';
  return `Main questions so far:\n${list}\n\nTranscript, oldest first${kept.length < lines.length ? ' (the latest part)' : ''}:\n${kept.join('\n') || '(nothing yet)'}`;
}

/** Reads the review's JSON reply. Main questions keep their ids and can be reworded; ones the reply left out stay, so the
 * list only grows. An unusable reply keeps what there was. */
export function parseTopics(output: string, previous: Topics): Topics {
  const match = output.match(/\{[\s\S]*\}/); if (!match) return previous;
  let data: any; try { data = JSON.parse(match[0]); } catch { return previous; }
  const text = (value: unknown, limit: number) => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, limit) : '';
  const list: Topic[] = []; const seen = new Set<number>();
  for (const item of Array.isArray(data?.topics) ? data.topics : []) {
    const id = Number(item?.id); const title = text(item?.title, 90); const from = Number(item?.from);
    if (!Number.isInteger(id) || id < 1 || seen.has(id) || !title) continue;
    seen.add(id); list.push({ id, title, question: text(item?.question, 600) || title, ...(Number.isInteger(from) && from > 0 ? { from } : {}) });
  }
  for (const old of previous.list) if (!seen.has(old.id)) list.push(old);
  list.sort((a, b) => a.id - b.id);
  const current = Number(data?.current);
  return { list, current: list.some(topic => topic.id === current) ? current : data?.current === null && !list.length ? null : previous.current ?? (list.length ? list[list.length - 1].id : null) };
}

/** A saved session's main questions, if they are usable. */
export function readTopics(value: any): Topics {
  const list = (Array.isArray(value?.list) ? value.list : []).filter((topic: any) => Number.isInteger(topic?.id) && typeof topic?.title === 'string' && typeof topic?.question === 'string')
    .map((topic: any): Topic => ({ id: topic.id, title: topic.title, question: topic.question, ...(Number.isInteger(topic.from) ? { from: topic.from } : {}) }));
  return { list, current: list.some((topic: Topic) => topic.id === value?.current) ? value.current : null };
}
