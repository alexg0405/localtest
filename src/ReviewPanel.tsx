// The Review panel: how you answered each question in this session, measured from the transcript (see review.ts), with
// coaching from your answer provider when you ask for it.
import { forwardRef } from 'react';
import { Check, Circle, RefreshCw, Sparkles, X } from 'lucide-react';
import { speakingSeconds, type Coaching, type SessionReview } from './review';

/** `questions` are the questions coached, in the order the coach numbered them. */
export type CoachingState = { state: 'idle' | 'loading' | 'done' | 'error'; result?: Coaching; message?: string; questions?: string[] };
type Props = { review: SessionReview; coaching: CoachingState; coachNote: string; onCoach(): void; onClose(): void };

const percent = (part: number, whole: number) => whole ? Math.round((part / whole) * 100) : 0;

export const ReviewPanel = forwardRef<HTMLElement, Props>(function ReviewPanel({ review, coaching, coachNote, onCoach, onClose }, ref) {
  const own = review.yourWords - review.readWords;
  const perMinute = own ? review.fillerCount / (own / 150) : 0;
  const coached = coaching.state === 'done' ? coaching.result : undefined;
  // Coaching covers the questions there were when it ran (matched by the question, since the list can change); later
  // ones can be coached again.
  const notesFor = (question: string) => { const index = coaching.questions?.indexOf(question) ?? -1; return index < 0 ? undefined : coached?.questions.get(index + 1); };
  const behind = coached && review.questions.some(item => !coaching.questions?.includes(item.question));
  return <section className="settings-modal review-modal" ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="review-title">
    <div className="modal-head"><h2 id="review-title">Review</h2><button className="icon-button" onClick={onClose} aria-label="Close review"><X size={18}/></button></div>
    {!review.questions.length ? <p className="context-intro">Nothing to review yet. Once the interviewer asks something and you answer, each question shows up here with what you said and what to work on.</p> : <>
      <div className="review-stats">
        <div><b>{review.questions.length}</b><span>{review.questions.length === 1 ? 'question' : 'questions'}{review.minutes ? ` in ${review.minutes} min` : ''}</span></div>
        <div><b>{percent(review.yourWords, review.yourWords + review.theirWords)}%</b><span>of the talking was you</span></div>
        <div><b>{percent(review.readWords, review.yourWords)}%</b><span>read from a suggested answer</span></div>
        <div><b>{perMinute < 10 ? perMinute.toFixed(1) : Math.round(perMinute)}</b><span>filler words a minute</span></div>
      </div>
      <div className="review-coach">
        {coached ? <><b>Work on</b><ol>{coached.overall.map(item => <li key={item}>{item}</li>)}</ol>{behind && <button className="text-button" onClick={onCoach}><RefreshCw size={12}/> Coach the newer questions too</button>}</>
          : coaching.state === 'loading' ? <span className="review-coaching"><i/>Coaching…</span>
            : <><button className="secondary" onClick={onCoach}><Sparkles size={13}/> Coach me</button><span>{coaching.state === 'error' ? coaching.message : coachNote}</span></>}
      </div>
      <ol className="review-list">{review.questions.map(item => {
        const words = item.ownWords + item.readWords; const notes = notesFor(item.question);
        return <li className="review-item" key={item.n}>
          <div className="review-q"><span className="review-n">{item.n}</span><p>{item.question}</p>{item.kind && <span className="tag">{item.kind}</span>}</div>
          <div className="review-facts">{words ? <>
            <span>{words} words, about {speakingSeconds(words)} s</span>
            {item.readWords > 0 && <span>{percent(item.readWords, words)}% read aloud</span>}
            <span>{item.fillerCount ? item.fillers.map(filler => `${filler.word} ×${filler.count}`).join(', ') : 'no filler words'}</span>
          </> : <span>You didn't answer this one out loud.</span>}</div>
          {item.checks.length > 0 && words > 0 && <ul className="review-checks">{item.checks.map(check => <li key={check.label} className={check.done ? 'done' : ''}>{check.done ? <Check size={13}/> : <Circle size={11}/>}{check.label}</li>)}</ul>}
          {notes && <div className="review-notes">{notes.good && <p><b>Good</b>{notes.good}</p>}{notes.improve && <p><b>Try</b>{notes.improve}</p>}</div>}
          {item.said.length > 0 && <details className="review-said"><summary>What you said</summary><p>{item.said.join(' ')}</p></details>}
        </li>;
      })}</ol>
    </>}
  </section>;
});
