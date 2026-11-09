import { useEffect, useRef, useState } from 'react';
import { Copy, Languages, Mic, MicOff, Trash2, Volume2 } from 'lucide-react';
import { claudeCodeStatus, streamClaudeCode } from './providers';
import { deepgramKeyFromEnv } from './env';
import { BrowserSpeechToTextProvider, DeepgramSpeechToTextProvider, type SpeechToTextProvider } from './speech';
import { TRANSLATE_MODEL, hearInstructions, hearPrompt, mandarinVoice, parseReply, quickPhrases, replyInstructions, replyPrompt, tidyChinese, type Reply } from './translate';

type Line = { id: number; zh: string; en: string; pending: boolean; error?: string };

// While a reply plays aloud the microphone hears it too, so what it transcribes then (and just after) isn't theirs.
const ECHO_MS = 1500;

export default function TranslateApp() {
  const [lines, setLines] = useState<Line[]>([]);
  const [interim, setInterim] = useState('');
  const [listening, setListening] = useState(false);
  const [starting, setStarting] = useState(false);
  const [engine, setEngine] = useState<'deepgram' | 'browser' | null>(null);
  const [claude, setClaude] = useState<'checking' | 'ready' | 'missing'>('checking');
  const [notice, setNotice] = useState('');
  const [draft, setDraft] = useState('');
  const [replying, setReplying] = useState(false);
  const [replies, setReplies] = useState<Reply[]>([]);
  const speech = useRef<SpeechToTextProvider | null>(null);
  const key = useRef('');
  const linesRef = useRef<Line[]>([]);
  const nextId = useRef(1);
  const speakingUntil = useRef(0);
  const feed = useRef<HTMLDivElement>(null);
  linesRef.current = lines;

  useEffect(() => {
    document.title = 'Roomside — Translate';
    void deepgramKeyFromEnv().then(found => { key.current = found; setEngine(found ? 'deepgram' : 'browser'); });
    void claudeCodeStatus().then(status => setClaude(status?.available && status.loggedIn ? 'ready' : 'missing'));
    // Start Claude Code now, so the first translation doesn't wait for it to boot.
    void fetch('/api/claude-code/warm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: TRANSLATE_MODEL, system: hearInstructions }) }).catch(() => undefined);
    speechSynthesis.getVoices();
    return () => speech.current?.stop();
  }, []);

  useEffect(() => {
    const box = feed.current;
    if (box && box.scrollHeight - box.scrollTop - box.clientHeight < 160) box.scrollTop = box.scrollHeight;
  }, [lines, interim]);

  const update = (id: number, change: (line: Line) => Line) => setLines(current => current.map(line => (line.id === id ? change(line) : line)));

  async function translate(zh: string) {
    const id = nextId.current++;
    const earlier = linesRef.current.map(({ zh, en }) => ({ zh, en }));
    setLines(current => [...current, { id, zh, en: '', pending: true }]);
    try {
      await streamClaudeCode({ model: TRANSLATE_MODEL, system: hearInstructions, prompt: hearPrompt(earlier, zh) }, chunk => update(id, line => ({ ...line, en: line.en + chunk })));
      update(id, line => ({ ...line, pending: false }));
    } catch (reason) {
      update(id, line => ({ ...line, pending: false, error: reason instanceof Error ? reason.message : String(reason) }));
    }
  }

  async function start() {
    if (listening || starting || !engine) return;
    setStarting(true); setNotice('');
    const provider = engine === 'deepgram' ? new DeepgramSpeechToTextProvider(key.current, 'zh-CN') : new BrowserSpeechToTextProvider('zh-CN');
    speech.current = provider;
    try {
      await provider.start({
        onFinal: result => {
          setInterim('');
          const zh = tidyChinese(result.text);
          if (!zh || Date.now() < speakingUntil.current) return;
          void translate(zh);
        },
        onInterim: text => { if (Date.now() >= speakingUntil.current) setInterim(tidyChinese(text)); },
        onError: message => setNotice(message),
        onListening: setListening,
        onVoiceActivity: () => undefined,
        onNotice: setNotice,
      });
      setListening(true);
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : String(reason));
      speech.current = null;
    } finally { setStarting(false); }
  }

  function stop() { speech.current?.stop(); speech.current = null; setListening(false); setInterim(''); }

  function play(text: string) {
    speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    const voice = mandarinVoice(speechSynthesis.getVoices());
    if (voice) utterance.voice = voice;
    utterance.lang = voice?.lang ?? 'zh-CN';
    utterance.rate = 0.9;
    speakingUntil.current = Date.now() + 60_000;
    utterance.onend = utterance.onerror = () => { speakingUntil.current = Date.now() + ECHO_MS; };
    speechSynthesis.speak(utterance);
  }

  async function reply() {
    const english = draft.trim();
    if (!english || replying) return;
    setReplying(true);
    try {
      const text = await streamClaudeCode({ model: TRANSLATE_MODEL, system: replyInstructions, prompt: replyPrompt(english, linesRef.current), warm: false });
      setReplies(current => [parseReply(english, text), ...current].slice(0, 12));
      setDraft('');
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : String(reason));
    } finally { setReplying(false); }
  }

  const status = claude === 'missing' ? 'Claude Code isn\'t signed in or Roomside isn\'t running with npm start, so nothing can be translated.'
    : engine === 'browser' ? 'Listening with the browser\'s own recognition (use Edge or Chrome). Add DEEPGRAM_API_KEY to .env for better Mandarin.'
    : engine === 'deepgram' ? 'Listening with Deepgram (Mandarin).' : 'Getting ready…';

  return (
    <div className="tr">
      <header className="tr-bar">
        <div className="tr-title"><Languages size={18}/><b>Roomside</b><span>Translate · Mandarin → English</span></div>
        <div className="tr-actions">
          <button className="tr-ghost" onClick={() => setLines([])} title="Clear the transcript"><Trash2 size={15}/><span>Clear</span></button>
          {listening
            ? <button className="tr-stop" onClick={stop}><MicOff size={16}/><span>Stop listening</span></button>
            : <button className="tr-go" onClick={start} disabled={starting || !engine}><Mic size={16}/><span>{starting ? 'Starting…' : 'Start listening'}</span></button>}
        </div>
      </header>
      <p className="tr-status">{status}{notice && <span className="tr-notice"> {notice}</span>}</p>

      <main className="tr-main">
        <section className="tr-feed" ref={feed} aria-live="polite">
          {!lines.length && !interim && (
            <div className="tr-empty">
              <p><b>Press Start listening</b>, then put the call on speaker near your laptop (headphones stop the mic from hearing them).</p>
              <p>Each thing they say shows here in Chinese, with the English under it. Stop listening while you talk, so your own words aren't translated.</p>
            </div>
          )}
          {lines.map(line => (
            <div className="tr-line" key={line.id}>
              <div className="tr-en">{line.error ? <span className="tr-error">{line.error}</span> : line.en || (line.pending ? <span className="tr-dots">Translating…</span> : '')}</div>
              <div className="tr-zh">{line.zh}</div>
            </div>
          ))}
          {interim && <div className="tr-line tr-interim"><div className="tr-zh">{interim}</div></div>}
        </section>

        <aside className="tr-side">
          <h2>Your reply</h2>
          <textarea value={draft} onChange={event => setDraft(event.target.value)} placeholder="Type what you want to say in English, then press Enter"
            onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void reply(); } }} rows={3}/>
          <button className="tr-go tr-wide" onClick={reply} disabled={replying || !draft.trim()}>{replying ? 'Translating…' : 'Say it in Mandarin'}</button>
          {replies.map((item, i) => <Phrase key={`${i}-${item.zh}`} phrase={item} onPlay={play} big={i === 0}/>)}
          <h2>Quick phrases</h2>
          {quickPhrases.map(item => <Phrase key={item.zh} phrase={item} onPlay={play}/>)}
        </aside>
      </main>
    </div>
  );
}

function Phrase({ phrase, onPlay, big = false }: { phrase: Reply; onPlay: (text: string) => void; big?: boolean }) {
  return (
    <div className={`tr-phrase${big ? ' tr-big' : ''}`}>
      <div className="tr-phrase-zh">{phrase.zh}</div>
      {phrase.pinyin && <div className="tr-pinyin">{phrase.pinyin}</div>}
      <div className="tr-phrase-foot">
        <span>{phrase.english}</span>
        <button className="tr-icon" onClick={() => onPlay(phrase.zh)} title="Play it aloud"><Volume2 size={15}/></button>
        <button className="tr-icon" onClick={() => void navigator.clipboard?.writeText(phrase.zh)} title="Copy the Chinese"><Copy size={15}/></button>
      </div>
    </div>
  );
}
