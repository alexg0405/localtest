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
