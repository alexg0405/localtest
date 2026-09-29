// One question and its suggested answer in the running list of answers.
import { memo, useMemo } from 'react';
import { Clipboard, Pin, Sparkles } from 'lucide-react';
import type { Mode } from './providers';
import { inlineSegments, parseAnswer, type AnswerBlock } from './text';

export type AnswerKind = 'answer' | 'followup';
export type Snapshot = { question: string; answer: string; mode: Mode; kind: AnswerKind };
/** A finished answer in the running list. */
export type Entry = Snapshot & { id: number; time: string; tag: string; possible: boolean };

const inline = (text: string) => inlineSegments(text).map((segment, index) => segment.bold ? <b key={index}>{segment.text}</b> : segment.code ? <code key={index}>{segment.text}</code> : segment.text);
export const answerContent = (blocks: AnswerBlock[]) => blocks.map((block, index) => block.type === 'heading' ? <h4 key={index}>{inline(block.text)}</h4>
  : block.type === 'bullet' ? <div className="bullet" key={index}><i/><span>{inline(block.text)}</span></div>
    : block.type === 'code' ? <pre key={index}><code>{block.text}</code></pre>
      : block.type === 'label' ? <p key={index}><b>{block.label}:</b> {inline(block.text)}</p> : <p key={index}>{inline(block.text)}</p>);

export const questionLabel = (entry: Pick<Entry, 'possible' | 'time' | 'tag'>) => <div className="question-label"><span className="question-mark">?</span>{entry.possible ? 'POSSIBLE QUESTION' : 'QUESTION'}{entry.time && <time>{entry.time}</time>}{entry.tag && <span className="tag">{entry.tag}</span>}</div>;

type PastProps = { entry: Entry; pinned: boolean; onPin(entry: Entry): void; onCopy(text: string): void };
/** An earlier answer; it only re-renders when it is pinned or unpinned, not while a new answer streams. */
export const PastAnswer = memo(function PastAnswer({ entry, pinned, onPin, onCopy }: PastProps) {
  const blocks = useMemo(() => parseAnswer(entry.answer), [entry.answer]);
  return <article className="qa-entry past" data-entry={entry.id}>
    <div className="question-card">{questionLabel(entry)}<div className="question-text">{entry.question}</div></div>
    <div className="response-card"><div className="response-top"><span><Sparkles size={14}/> {entry.kind === 'followup' ? 'LIKELY FOLLOW-UP' : 'RESPONSE'} · {entry.mode}</span><span className="entry-tools"><button className={'icon-button small' + (pinned ? ' pinned' : '')} onClick={() => onPin(entry)} title={pinned ? 'Unpin answer' : 'Pin answer'} aria-label={pinned ? 'Unpin answer' : 'Pin answer'} aria-pressed={pinned}><Pin size={14}/></button><button className="icon-button small" onClick={() => onCopy(entry.answer)} title="Copy answer" aria-label="Copy answer"><Clipboard size={14}/></button></span></div>
      <div className="response-content">{answerContent(blocks)}</div></div>
  </article>;
});
