// The session dropdown under the title: name and save this session, start a new one, and reopen or delete saved ones.
import { X } from 'lucide-react';
import type { SessionSummary } from './sessions';

type Props = {
  name: string; placeholder: string; saved: boolean; currentId: string; listening: boolean; sessions: SessionSummary[] | null; notice: string;
  onRename(name: string): void; onSave(): void; onNew(): void; onOpen(id: string): void; onDelete(session: SessionSummary): void;
};
const when = (time: number) => new Date(time).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

export function SessionMenu({ name, placeholder, saved, currentId, listening, sessions, notice, onRename, onSave, onNew, onOpen, onDelete }: Props) {
  return <div className="session-menu" role="dialog" aria-label="Sessions">
    <label className="field-label">Session name<input className="text-input" value={name} placeholder={placeholder} onChange={event => onRename(event.target.value)} autoFocus/></label>
    <div className="session-state"><span className={'privacy-dot ' + (saved ? '' : 'off')}/>{saved ? 'Saved on this computer · changes save as you go' : 'Not saved · cleared when you close the page'}</div>
    <div className="session-actions">{!saved && <button className="primary" onClick={onSave}>Save this session</button>}<button className="secondary" onClick={onNew} title="Starts a fresh session; a saved one stays as it is">New session</button></div>
    {notice && <div className="settings-hint">{notice}</div>}
    <div className="eyebrow session-list-title">SAVED SESSIONS</div>
    {sessions === null ? <p className="session-empty">Loading…</p> : !sessions.length ? <p className="session-empty">None yet. Saved sessions keep their transcript and answers, so you can pick them up later.</p>
      : <ul className="session-list">{sessions.map(item => <li key={item.id} className={item.id === currentId ? 'current' : ''}>
        <button className="session-open" onClick={() => onOpen(item.id)} disabled={item.id === currentId || listening} title={item.id === currentId ? 'Open now' : listening ? 'Stop listening to open another session' : `Open ${item.name}`}><b>{item.name}</b><small>{when(item.updatedAt)} · {item.minutes} min · {item.answers} {item.answers === 1 ? 'answer' : 'answers'}{item.id === currentId ? ' · open now' : ''}</small></button>
        <button className="session-delete" onClick={() => onDelete(item)} aria-label={`Delete ${item.name}`} title="Delete"><X size={13}/></button>
      </li>)}</ul>}
    {listening && sessions && sessions.length > 0 && <div className="settings-hint">Stop listening to open another session.</div>}
  </div>;
}
