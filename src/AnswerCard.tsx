// One question and its suggested answer in the running list of answers.
import { memo, useMemo } from 'react';
import { Copy, Pin } from 'lucide-react';
import type { Mode } from './providers';
import { inlineSegments, parseAnswer, type AnswerBlock } from './text';

export type AnswerKind = 'answer' | 'followup';
export type Snapshot = { question: string; answer: string; mode: Mode; kind: AnswerKind };
/** A finished answer in the running list. */
export type Entry = Snapshot & { id: number; time: string; tag: string; possible: boolean };

const inline = (text: string) => inlineSegments(text).map((segment, index) => segment.bold ? <b key={index}>{segment.text}</b> : segment.code ? <code key={index}>{segment.text}</code> : segment.text);
// Only components are exported (plus types), so editing this file keeps the page's state through a hot update.
export const AnswerContent = ({ blocks }: { blocks: AnswerBlock[] }) => <>{blocks.map((block, index) => block.type === 'heading' ? <h4 key={index}>{inline(block.text)}</h4>
  : block.type === 'bullet' ? <div className="bullet" key={index}><i/><span>{inline(block.text)}</span></div>
    : block.type === 'code' ? <pre key={index}><code>{block.text}</code></pre>
      : block.type === 'label' ? <p key={index}><b>{block.label}:</b> {inline(block.text)}</p> : <p key={index}>{inline(block.text)}</p>)}</>;

/** When the question came, what kind it is, and the mode that produced the answer. `live` marks the live answer while
 * listening, `updating` while it is being rewritten. */
export const EntryMeta = (entry: Pick<Entry, 'possible' | 'time' | 'tag' | 'mode' | 'kind'> & { live?: 'on' | 'updating' }) => <div className="entry-meta">
  {entry.live && <span className={'live-badge' + (entry.live === 'updating' ? ' busy' : '')} title="Keeps up with the conversation as people talk"><i/>Live</span>}
  {entry.time && <time>{entry.time}</time>}{entry.tag && <span className="tag">{entry.tag}</span>}
  {entry.kind === 'followup' && <span className="kind">Likely follow-up</span>}<span className="mode">{entry.mode.toLowerCase()}</span>
  {entry.possible && <span className="possible">Possible question</span>}
</div>;

type PastProps = { entry: Entry; pinned: boolean; onPin(entry: Entry): void; onCopy(text: string): void };
/** An earlier answer; it only re-renders when it is pinned or unpinned, not while a new answer streams. */
export const PastAnswer = memo(function PastAnswer({ entry, pinned, onPin, onCopy }: PastProps) {
  const blocks = useMemo(() => parseAnswer(entry.answer), [entry.answer]);
  return <article className="qa-entry past" data-entry={entry.id}>
    <div className="qa-head"><EntryMeta {...entry}/><span className="entry-tools"><button className={'icon-button small' + (pinned ? ' pinned' : '')} onClick={() => onPin(entry)} title={pinned ? 'Unpin answer' : 'Pin answer'} aria-label={pinned ? 'Unpin answer' : 'Pin answer'} aria-pressed={pinned}><Pin size={14}/></button><button className="icon-button small" onClick={() => onCopy(entry.answer)} title="Copy answer" aria-label="Copy answer"><Copy size={14}/></button></span></div>
    <div className="question-text">{entry.question}</div>
    <div className="response-content"><AnswerContent blocks={blocks}/></div>
  </article>;
});
