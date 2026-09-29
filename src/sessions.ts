// Saved sessions: a copy of a session's transcript (the conversation memory answers use), answers, and pinned answer,
// kept in this browser's IndexedDB on this computer so a practice can be picked up later. Saving is opt-in per session;
// nothing is stored until you choose "Save this session".
import type { Entry } from './AnswerCard';
import type { SpokenLine } from './speakers';

export type SessionLine = SpokenLine & { time: string; at: number; confidence?: number };
export type SavedSession = {
  version: 1; id: string; name: string; createdAt: number; updatedAt: number;
  transcript: SessionLine[]; history: Entry[]; current: Entry | null; pinned: Entry | null;
};
export type SessionSummary = { id: string; name: string; createdAt: number; updatedAt: number; minutes: number; answers: number; lines: number };

export const newSessionId = () => typeof crypto?.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

const isEntry = (value: any): value is Entry => !!value && typeof value.id === 'number' && typeof value.question === 'string' && typeof value.answer === 'string';
const isLine = (value: any): value is SessionLine => !!value && typeof value.id === 'number' && typeof value.text === 'string' && typeof value.at === 'number';

/** Accepts only what this version saved, so a damaged or unknown record cannot break the page. */
export function readSession(value: any): SavedSession | null {
  if (!value || value.version !== 1 || typeof value.id !== 'string' || !Array.isArray(value.transcript) || !Array.isArray(value.history)) return null;
  return {
    version: 1, id: value.id, name: typeof value.name === 'string' && value.name.trim() ? value.name : 'Practice session',
    createdAt: Number(value.createdAt) || 0, updatedAt: Number(value.updatedAt) || 0,
    transcript: value.transcript.filter(isLine), history: value.history.filter(isEntry),
    current: isEntry(value.current) ? value.current : null, pinned: isEntry(value.pinned) ? value.pinned : null,
  };
}

export function summarize(session: SavedSession): SessionSummary {
  const { transcript } = session;
  const minutes = transcript.length ? Math.max(1, Math.round((transcript[transcript.length - 1].at - transcript[0].at) / 60_000)) : 0;
  return { id: session.id, name: session.name, createdAt: session.createdAt, updatedAt: session.updatedAt, minutes, answers: session.history.length + (session.current?.answer.trim() ? 1 : 0), lines: transcript.length };
}

/** The largest line, answer, and voice numbers in a session, so what is added after reopening it gets new ones. */
export function lastIds(session: Pick<SavedSession, 'transcript' | 'history' | 'current' | 'pinned'>) {
  const entries = [...session.history, session.current, session.pinned].filter(isEntry);
  return {
    line: Math.max(0, ...session.transcript.map(line => line.id)),
    entry: Math.max(0, ...entries.map(entry => entry.id)),
    voice: Math.max(-1, ...session.transcript.map(line => line.voice ?? -1)),
  };
}

let database: Promise<IDBDatabase> | null = null;
function openDatabase() {
  database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('roomside', 1);
    request.onupgradeneeded = () => { request.result.createObjectStore('sessions', { keyPath: 'id' }); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('This browser would not open its storage.'));
  });
  database.catch(() => { database = null; }); // Try again next time.
  return database;
}
/** Runs one request; writes resolve once their transaction has committed. */
async function run<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>) {
  const transaction = (await openDatabase()).transaction('sessions', mode);
  const request = work(transaction.objectStore('sessions'));
  return new Promise<T>((resolve, reject) => {
    transaction.oncomplete = () => resolve(request.result);
    transaction.onerror = transaction.onabort = () => reject(transaction.error ?? request.error ?? new Error('This browser would not save the session.'));
  });
}

export const canSaveSessions = () => typeof indexedDB !== 'undefined';
/** Newest first. */
export async function listSessions() {
  const records = await run<unknown[]>('readonly', store => store.getAll());
  return records.map(readSession).filter((session): session is SavedSession => !!session).map(summarize).sort((a, b) => b.updatedAt - a.updatedAt);
}
export const loadSession = async (id: string) => readSession(await run('readonly', store => store.get(id)));
export const storeSession = (session: SavedSession) => run('readwrite', store => store.put(session));
export const deleteSession = (id: string) => run('readwrite', store => store.delete(id));
