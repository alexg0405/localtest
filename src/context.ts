// Your own context (target role, notes, and files) that answers can draw on.

export type ContextFile = { id: string; name: string; size: number; text: string; status: 'reading' | 'ready' | 'error'; error?: string };
export type UserContext = { role: string; about: string; files: ContextFile[] };

/** About 10k tokens: enough for a résumé, a job description, and notes without slowing every answer down. */
export const contextBudget = 40_000;

/** Joins the role, notes, and file text in that order, cutting whatever does not fit the budget. */
export function buildProfile({ role, about, files }: UserContext, budget = contextBudget) {
  const parts = [
    { label: 'Interviewing for', text: role.trim() },
    { label: 'About the candidate', text: about.trim() },
    ...files.filter(file => file.status === 'ready' && file.text.trim()).map(file => ({ label: `From "${file.name}"`, text: file.text.trim() })),
  ].filter(part => part.text);
  const sections: string[] = []; const truncated: string[] = []; let used = 0;
  for (const { label, text } of parts) {
    const room = budget - used - label.length - 3;
    if (room < 200) { truncated.push(label); continue; }
    const kept = text.length > room ? `${text.slice(0, room - 1)}…` : text;
    if (kept !== text) truncated.push(label);
    sections.push(`${label}:\n${kept}`); used += label.length + 3 + kept.length;
  }
  return { text: sections.join('\n\n'), used, truncated };
}

const storageKey = 'roomside.context.v1';

/** Saved context, if the person chose "Keep on this computer". Never throws (storage can be blocked). */
export function loadSavedContext(): UserContext | null {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) ?? 'null');
    if (!saved || typeof saved !== 'object') return null;
    const files = Array.isArray(saved.files) ? saved.files.filter((file: any) => typeof file?.name === 'string' && typeof file?.text === 'string') : [];
    return { role: String(saved.role ?? ''), about: String(saved.about ?? ''), files: files.map((file: any, index: number) => ({ id: `saved-${index}`, name: file.name, size: Number(file.size) || 0, text: file.text, status: 'ready' as const })) };
  } catch { return null; }
}

/** Saves extracted text only (never the original files); returns false when the browser refuses. */
export function saveContext(context: UserContext) {
  try { localStorage.setItem(storageKey, JSON.stringify({ role: context.role, about: context.about, files: context.files.filter(file => file.status === 'ready').map(({ name, size, text }) => ({ name, size, text })) })); return true; }
  catch { return false; }
}

export function forgetSavedContext() { try { localStorage.removeItem(storageKey); } catch { /* Nothing saved. */ } }
