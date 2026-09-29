// Settings you keep in the project's .env file (see .env.example), which `npm start` hands to this page.

/** DEEPGRAM_API_KEY from .env, or '' when none is set or the page is not running on the dev server. */
export async function deepgramKeyFromEnv(): Promise<string> {
  try {
    const response = await fetch('/api/deepgram-key', { cache: 'no-store' });
    if (!response.ok) return '';
    const { key } = await response.json();
    return typeof key === 'string' ? key.trim() : '';
  } catch { return ''; }
}

/** Your default context files (CONTEXT_FILES in .env, or résumé files in the project folder) as Files to read like
 * uploads; none when the page is not running on the dev server. */
export async function contextFilesFromEnv(): Promise<File[]> {
  try {
    const response = await fetch('/api/context-files', { cache: 'no-store' });
    if (!response.ok) return [];
    const { files } = await response.json();
    if (!Array.isArray(files)) return [];
    const loaded = await Promise.all(files.map(async ({ name }: { name?: unknown }) => {
      if (typeof name !== 'string') return null;
      const file = await fetch(`/api/context-files?name=${encodeURIComponent(name)}`, { cache: 'no-store' });
      return file.ok ? new File([await file.blob()], name, { type: file.headers.get('content-type') ?? '' }) : null;
    }));
    return loaded.filter((file): file is File => !!file);
  } catch { return []; }
}
