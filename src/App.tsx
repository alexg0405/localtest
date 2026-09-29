import { useCallback, useEffect, useRef, useState } from 'react';
import { Activity, AudioLines, ChevronDown, Clipboard, Clock3, HelpCircle, Mic, MicOff, MoreHorizontal, Pin, Send, Settings2, Sparkles, Wifi, X, Volume2, Trash2 } from 'lucide-react';
import { LocalDemoProvider, OpenAICompatibleProvider, type LLMProvider, type Mode } from './providers';
import { BrowserSpeechToTextProvider, DeepgramSpeechToTextProvider, type SpeechToTextProvider } from './speech';

type Line = { text: string; time: string; at: number; confidence?: number };
type AudioInput = { deviceId: string; label: string };
const modes: Mode[] = ['SHORT', 'STANDARD', 'DETAILED', 'BULLETS'];
const initialQuestion = 'What is the difference between a process and a thread?';
const initialAnswer = 'A process is an executing program with its own memory space and resources. Threads are execution paths within a process; they share its memory but each has its own stack and registers.\n\nKEY CONCEPTS\n• Processes are isolated; threads share state\n• Sharing makes thread communication cheaper, but synchronization is needed\n• Switching between processes usually has more overhead\n\nEXAMPLE\nA browser can isolate tabs in processes while using threads for work within a tab.\n\nCOMMON FOLLOW-UP\nWhy are threads generally cheaper to create?';
const stamp = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
function kind(question: string) {
  if (/tell me about|time you|disagree|challenge|conflict|failure|leadership|strength|weakness/i.test(question)) return 'BEHAVIORAL';
  if (/code|implement|algorithm|function|array|tree|sort|reverse|complexity|write a/i.test(question)) return 'CODING';
  if (/what|how|why|when|where|which|explain|describe|difference|compare/i.test(question)) return 'TECHNICAL';
  return 'DISCUSSION';
}
function likelyQuestion(text: string) {
  const value = text.trim();
  if (value.length < 3) return false;
  return /\?\s*$/.test(value)
    || /^(what|why|when|where|which|who|whose|how|can|could|would|will|do|does|did|is|are|was|were|have|has)\b/i.test(value)
    || /^(tell me about|tell us about|share an example|describe|explain|walk me through|talk me through|compare|define)\b/i.test(value)
    || /^(given|implement|write|find|return|design|calculate|suppose|assume|you are given)\b/i.test(value);
}
function isFollowUp(question: string, recent: string) {
  return !!recent.trim() && /^(and\s+(what|how|why|its|their|those|that)|what about|how about|why is that|can you expand|what did you mean|same for|what happens if)\b/i.test(question.trim());
}

export default function App() {
  const [active, setActive] = useState(false); const activeRef = useRef(false);
  const sessionId = useRef(0);
  const [transcript, setTranscript] = useState<Line[]>([]); const transcriptRef = useRef<Line[]>([]);
  const [draft, setDraft] = useState(''); const [interim, setInterim] = useState(''); const [question, setQuestion] = useState(initialQuestion); const [lowConfidence, setLowConfidence] = useState(false);
  const [answer, setAnswer] = useState(initialAnswer); const [mode, setMode] = useState<Mode>('STANDARD');
  const [status, setStatus] = useState('Demo answer ready'); const [error, setError] = useState(''); const [voiceDetected, setVoiceDetected] = useState(false);
  const [providerCheck, setProviderCheck] = useState(''); const [checkingProvider, setCheckingProvider] = useState(false);
  const [pinned, setPinned] = useState<{ question: string; answer: string } | null>(null); const [settings, setSettings] = useState(false);
  const [remote, setRemote] = useState(false); const [endpoint, setEndpoint] = useState('https://api.openai.com/v1/chat/completions');
  const [apiKey, setApiKey] = useState(''); const [model, setModel] = useState('gpt-4o-mini');
  const [speechEngine, setSpeechEngine] = useState<'browser' | 'deepgram'>('browser'); const [deepgramKey, setDeepgramKey] = useState(''); const [language, setLanguage] = useState('en-US');
  const [checkingSpeech, setCheckingSpeech] = useState(false); const [speechCheckMessage, setSpeechCheckMessage] = useState('');
  const [audioInputs, setAudioInputs] = useState<AudioInput[]>([]); const [audioDeviceId, setAudioDeviceId] = useState(''); const [deviceMessage, setDeviceMessage] = useState('');
  const [background, setBackground] = useState(''); const [clearOnStop, setClearOnStop] = useState(false);
  const speech = useRef<SpeechToTextProvider>(new BrowserSpeechToTextProvider()); const controller = useRef<AbortController | null>(null); const partialTimer = useRef<number | null>(null);
  const partialAnswer = useRef(false);
  const partialQuestion = useRef('');
  const browserFinal = useRef(''); const browserConfidence = useRef<number | undefined>(undefined); const browserFinalTimer = useRef<number | null>(null);
  const provider = useCallback((): LLMProvider => remote ? new OpenAICompatibleProvider(endpoint, apiKey, model) : new LocalDemoProvider(), [remote, endpoint, apiKey, model]);
  const detectAudioInputs = useCallback(async () => {
    setDeviceMessage('Requesting microphone permission…');
    try {
      const permissionStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      permissionStream.getTracks().forEach(track => track.stop());
      const inputs = (await navigator.mediaDevices.enumerateDevices()).filter(device => device.kind === 'audioinput').map((device, index) => ({ deviceId: device.deviceId, label: device.label || `Microphone ${index + 1}` }));
      setAudioInputs(inputs); setDeviceMessage(inputs.length ? `${inputs.length} microphone${inputs.length === 1 ? '' : 's'} found.` : 'No microphones found.');
    } catch (reason: any) { setDeviceMessage(reason?.name === 'NotAllowedError' ? 'Microphone permission was denied. Allow access in browser settings.' : reason?.message || 'Could not list microphones.'); }
  }, []);
  const context = useCallback(() => {
    const cutoff = Date.now() - 10 * 60 * 1000;
    const recent = transcriptRef.current.filter(line => line.at > cutoff).slice(-45).map(line => line.text).join('\n').slice(-7500);
    const profile = background.trim().slice(0, 2500);
    return [profile ? `Candidate background: ${profile}` : '', recent].filter(Boolean).join('\n');
  }, [background]);

  const generate = useCallback(async (q: string, selectedMode: Mode = mode, uncertain = false, isPartial = false) => {
    if (!q.trim()) return;
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    partialAnswer.current = isPartial;
    partialQuestion.current = isPartial ? q : '';
    controller.current?.abort(); const current = new AbortController(); controller.current = current;
    setQuestion(q.trim()); setLowConfidence(uncertain); setAnswer(''); setError(''); setStatus('Preparing response…');
    try {
      const result = await provider().answer(q.trim(), context(), selectedMode, chunk => {
        if (!current.signal.aborted) { setAnswer(value => value + chunk); setStatus('Writing response…'); }
      }, current.signal);
      if (!current.signal.aborted) { setAnswer(result); setStatus('Response ready'); }
    } catch (reason: any) {
      if (reason?.name !== 'AbortError') { setStatus('Could not reach provider'); setError(reason?.message || 'Unexpected provider error.'); }
    }
  }, [mode, provider, context]);

  const addLine = useCallback((line: Line) => {
    const cutoff = Date.now() - 10 * 60 * 1000;
    const next = [...transcriptRef.current.filter(item => item.at > cutoff), line].slice(-90);
    transcriptRef.current = next; setTranscript(next);
  }, []);

  const commitSpeech = useCallback((text: string, confidence?: number) => {
    const utterance = text.trim(); if (!utterance) return;
    addLine({ text: utterance, time: stamp(), at: Date.now(), confidence });
    if (likelyQuestion(utterance)) { generate(utterance, mode, !!confidence && confidence < 0.45); setStatus('Question detected'); }
    else if (partialQuestion.current) { partialAnswer.current = false; partialQuestion.current = ''; controller.current?.abort(); setAnswer(''); setQuestion(''); setLowConfidence(false); setStatus('No question detected'); }
  }, [addLine, generate, mode]);

  const stop = useCallback(() => {
    sessionId.current++; activeRef.current = false; setActive(false);
    speech.current.stop(); if (partialTimer.current) window.clearTimeout(partialTimer.current);
    if (browserFinalTimer.current) { window.clearTimeout(browserFinalTimer.current); if (!clearOnStop) commitSpeech(browserFinal.current, browserConfidence.current); browserFinal.current = ''; browserConfidence.current = undefined; browserFinalTimer.current = null; }
    partialAnswer.current = false; partialQuestion.current = ''; setVoiceDetected(false); setInterim(''); setStatus('Listening stopped');
    if (clearOnStop) { controller.current?.abort(); partialAnswer.current = false; transcriptRef.current = []; setTranscript([]); setQuestion(''); setAnswer(''); setPinned(null); setLowConfidence(false); setStatus('Session ended · context cleared'); }
  }, [clearOnStop, commitSpeech]);

  const start = useCallback(() => {
    setError(''); if (activeRef.current) return;
    const thisSession = ++sessionId.current;
    if (partialTimer.current) window.clearTimeout(partialTimer.current);
    if (browserFinalTimer.current) window.clearTimeout(browserFinalTimer.current);
    browserFinalTimer.current = null; browserFinal.current = ''; browserConfidence.current = undefined;
    partialAnswer.current = false; partialQuestion.current = ''; setVoiceDetected(false); activeRef.current = true; setActive(true); setStatus('Requesting microphone…');
    speech.current.stop(); speech.current = speechEngine === 'deepgram' ? new DeepgramSpeechToTextProvider(deepgramKey, language, audioDeviceId) : new BrowserSpeechToTextProvider(language);
    try {
      void speech.current.start({
        onListening: listening => { if (sessionId.current !== thisSession) return; activeRef.current = listening; setActive(listening); setStatus(listening ? 'Listening to the room microphone' : 'Listening stopped'); },
        onVoiceActivity: detected => { if (sessionId.current === thisSession) setVoiceDetected(detected); },
        onInterim: text => {
          if (sessionId.current !== thisSession) return;
          setInterim(text);
          const compact = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();
          if (text.trim() && partialQuestion.current && compact(text) !== compact(partialQuestion.current)) {
            partialAnswer.current = false; controller.current?.abort(); setAnswer(''); setQuestion(text); setLowConfidence(true); setStatus('Question changed · updating…');
          }
          if (partialTimer.current) window.clearTimeout(partialTimer.current);
          if (text.length >= 24 && likelyQuestion(text)) partialTimer.current = window.setTimeout(() => { if (activeRef.current) void generate(text, mode, false, true); }, 650);
        },
        onFinal: result => {
          if (sessionId.current !== thisSession) return;
          if (partialTimer.current) window.clearTimeout(partialTimer.current); setInterim('');
          if (speechEngine === 'browser') {
            browserFinal.current = [browserFinal.current, result.text].filter(Boolean).join(' ').trim(); browserConfidence.current = result.confidence ?? browserConfidence.current;
            if (browserFinalTimer.current) window.clearTimeout(browserFinalTimer.current);
            browserFinalTimer.current = window.setTimeout(() => { commitSpeech(browserFinal.current, browserConfidence.current); browserFinal.current = ''; browserConfidence.current = undefined; browserFinalTimer.current = null; }, 450);
          } else commitSpeech(result.text, result.confidence);
        },
        onError: (message, denied) => { if (sessionId.current !== thisSession) return; setError(message); if (denied) { activeRef.current = false; setActive(false); } },
      }).catch((reason: any) => { if (sessionId.current === thisSession && activeRef.current) { activeRef.current = false; setActive(false); const message = reason?.name === 'NotAllowedError' ? 'Microphone permission was denied. Allow access in browser settings, then try again.' : reason?.name === 'NotFoundError' ? 'No microphone was found. Connect a microphone or enter a question manually.' : reason?.message || 'Could not start speech recognition.'; setError(message); } });
    } catch (reason: any) { if (sessionId.current === thisSession) { activeRef.current = false; setActive(false); setError(reason?.message || 'Could not start speech recognition.'); } }
  }, [commitSpeech, generate, mode, speechEngine, deepgramKey, language, audioDeviceId]);

  const clear = useCallback(() => {
    sessionId.current++; activeRef.current = false; setActive(false); setVoiceDetected(false); partialAnswer.current = false; partialQuestion.current = ''; speech.current.stop(); if ('speechSynthesis' in window) window.speechSynthesis.cancel(); if (partialTimer.current) window.clearTimeout(partialTimer.current); if (browserFinalTimer.current) window.clearTimeout(browserFinalTimer.current); browserFinalTimer.current = null; browserFinal.current = ''; browserConfidence.current = undefined; controller.current?.abort(); transcriptRef.current = []; setTranscript([]); setDraft(''); setInterim(''); setQuestion(''); setAnswer(''); setPinned(null); setLowConfidence(false); setStatus('Context cleared'); setError('');
  }, []);
  const submitManual = useCallback(() => {
    const q = draft.trim(); if (!q) return;
    addLine({ text: q, time: stamp(), at: Date.now() }); setDraft(''); generate(q, mode);
  }, [draft, addLine, generate, mode]);
  const togglePin = useCallback(() => setPinned(value => value ? null : { question, answer }), [question, answer]);
  const checkProvider = useCallback(async () => {
    if (!remote) { setProviderCheck('The offline demo provider is ready.'); return; }
    if (!endpoint.trim() || !model.trim()) { setProviderCheck('Enter an endpoint and model name first.'); return; }
    setCheckingProvider(true); setProviderCheck('Checking endpoint…');
    try {
      const result = await provider().answer('Reply with exactly: OK', 'Connection check', 'SHORT', () => undefined, new AbortController().signal);
      setProviderCheck(result.trim() ? 'Connected. The provider returned a response.' : 'Connected, but the provider returned an empty response.');
    } catch (reason: any) {
      const message = String(reason?.message || 'Connection failed.');
      setProviderCheck(message.includes('Failed to fetch') ? 'Connection failed. Check the URL and whether the endpoint allows browser CORS requests.' : `Connection failed: ${message}`);
    } finally { setCheckingProvider(false); }
  }, [remote, endpoint, model, provider]);
  const checkSpeechProvider = useCallback(async () => {
    setCheckingSpeech(true); setSpeechCheckMessage('Checking Deepgram…');
    try { await DeepgramSpeechToTextProvider.checkConnection(deepgramKey, language); setSpeechCheckMessage('Connected. No microphone audio was sent.'); }
    catch (reason: any) { setSpeechCheckMessage(reason?.message || 'Could not connect to Deepgram.'); }
    finally { setCheckingSpeech(false); }
  }, [deepgramKey, language]);
  const setAnswerMode = useCallback((next: Mode) => { setMode(next); if (question) void generate(question, next, lowConfidence); }, [question, generate, lowConfidence]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const command = event.metaKey || event.ctrlKey;
      if (command && event.key === 'Enter') { event.preventDefault(); submitManual(); }
      else if (command && event.code === 'Space') { event.preventDefault(); activeRef.current ? stop() : start(); }
      else if (command && event.key === '1') { event.preventDefault(); setAnswerMode('SHORT'); }
      else if (command && event.key === '2') { event.preventDefault(); setAnswerMode('DETAILED'); }
      else if (command && event.key.toLowerCase() === 'p') { event.preventDefault(); togglePin(); }
      else if (event.key === 'Escape' && activeRef.current) stop();
    };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, [submitManual, setAnswerMode, start, stop, togglePin]);
  useEffect(() => () => { sessionId.current++; activeRef.current = false; speech.current.stop(); if (partialTimer.current) window.clearTimeout(partialTimer.current); if (browserFinalTimer.current) window.clearTimeout(browserFinalTimer.current); controller.current?.abort(); }, []);

  const lines = answer.split('\n').filter(Boolean);
  const copyAnswer = async () => { try { await navigator.clipboard.writeText(answer); setStatus('Answer copied'); } catch { setError('Clipboard access is blocked. Select and copy the answer instead.'); } };
  const followUp = () => void generate(`Give one likely interviewer follow-up to this question: ${question}`, 'SHORT');

  return <main className="app">
    <aside className="rail"><div className="brand">r<span>.</span></div><div className="rail-sep"/><button className="rail-button selected" title="Session"><Activity/></button><button className="rail-button" onClick={() => setSettings(true)} title="Settings"><Settings2/></button><div className="rail-bottom"><button className="rail-button" title="Help" onClick={() => setSettings(true)}><HelpCircle/></button><div className="avatar">A</div></div></aside>
    <section className="workspace">
      <header className="topbar"><div><div className="eyebrow">PRACTICE SESSION <span className="dot"/></div><div className="session-title">Interview copilot <ChevronDown size={15}/></div></div><div className="top-actions"><div className="privacy"><span className="privacy-dot"/> Memory only · no saved transcript</div><button className="icon-button" onClick={() => setSettings(true)} aria-label="Settings"><Settings2 size={17}/></button><button className="icon-button" onClick={clear} aria-label="Clear session"><MoreHorizontal size={18}/></button></div></header>
      <div className="content">
        <div className="left-col">
          <div className="section-head"><div><div className="eyebrow">YOUR ROOM AUDIO</div><h2>Live transcript</h2></div><div className={'mic-state ' + (active ? 'on' : '')}><i/>{active ? voiceDetected ? 'Voice detected' : 'Listening' : 'Mic off'}</div></div>
          <div className="listen-card"><div className="listen-icon"><AudioLines size={22}/></div><div className="listen-copy"><strong>{active ? 'Listening to conversation' : 'Ready to listen'}</strong><span>{active ? 'This device’s microphone only' : 'Start only when everyone has agreed to the practice session'}</span></div><button onClick={active ? stop : start} className={'listen-button ' + (active ? 'stop' : '')}><span>{active ? <MicOff size={16}/> : <Mic size={16}/>}</span>{active ? 'Stop listening' : 'Start listening'}</button></div>
          {error && <div className="error">{error}</div>}
          <div className="transcript-card"><div className="transcript-toolbar"><span><span className={'tiny-live ' + (active ? 'active' : '')}/> LIVE TRANSCRIPT</span><button onClick={clear} className="text-button"><Trash2 size={13}/> Clear context</button></div>
            <div className="transcript-body">{transcript.length === 0 && !interim ? <div className="empty-transcript"><div className="wave">〰</div><span>Your conversation will appear here.</span><small>Or enter a question below to try it out.</small></div> : <>{transcript.map((line, index) => <div className="transcript-line" key={`${line.at}-${index}`}><time>{line.time}</time><p>{line.text}</p></div>)}{interim && <div className="transcript-line interim"><time>live</time><p>{interim}<span className="cursor"/></p></div>}</>}</div>
            <div className="manual-input"><input value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) submitManual(); }} placeholder="Type a question manually…"/><button onClick={submitManual} disabled={!draft.trim()} title="Send question"><Send size={15}/></button></div>
          </div><div className="footnote"><Wifi size={13}/> Local voice activity meter · speech recognition may process audio according to its provider’s settings.</div>
        </div>
        <div className="right-col">
          <div className="answer-head"><div><div className="eyebrow">AI ASSIST <span className="sparkle"><Sparkles size={12}/></span></div><h2>Suggested response</h2></div><button className={'pin ' + (pinned ? 'pinned' : '')} onClick={togglePin}><Pin size={15}/>{pinned ? 'Pinned' : 'Pin answer'}</button></div>
          {pinned && <div className="pinned-answer"><span><Pin size={13}/> PINNED · {pinned.question.length > 70 ? `${pinned.question.slice(0, 70)}…` : pinned.question}</span><button onClick={() => { controller.current?.abort(); if ('speechSynthesis' in window) window.speechSynthesis.cancel(); setQuestion(pinned.question); setAnswer(pinned.answer); setLowConfidence(false); setStatus('Pinned answer restored'); }}>Restore</button><button className="unpin" onClick={() => setPinned(null)} aria-label="Unpin answer"><X size={13}/></button></div>}
          <div className="mode-row">{modes.map(item => <button key={item} className={mode === item ? 'active' : ''} onClick={() => setAnswerMode(item)}>{item}</button>)}</div>
          <div className="question-card"><div className="question-label"><span className="question-mark">?</span>{lowConfidence ? 'POSSIBLE QUESTION' : 'DETECTED QUESTION'}<span className="tag">{isFollowUp(question, transcript.slice(0, -1).map(line => line.text).join(' ')) ? 'FOLLOW-UP' : kind(question)}</span></div><div className="question-text">{question || 'Waiting for a question…'}</div><div className="question-actions"><button onClick={() => setDraft(question)}><Clipboard size={13}/> Edit question</button><button onClick={() => question && void generate(question, mode, lowConfidence)}><Sparkles size={13}/> Regenerate</button></div></div>
          <div className="response-card"><div className="response-top"><span><Sparkles size={14}/> RESPONSE</span><button className="icon-button small" onClick={copyAnswer} title="Copy answer"><Clipboard size={14}/></button></div><div className="response-content">{lines.length ? lines.map((line, index) => /^(KEY CONCEPTS|APPROACH|COMPLEXITY|PSEUDOCODE|IMPLEMENTATION|EDGE CASES|SITUATION|TASK|ACTION|RESULT|DIRECT ANSWER|EXAMPLE|COMMON FOLLOW-UP)/i.test(line) ? <h4 key={index}>{line}</h4> : line.startsWith('•') ? <div className="bullet" key={index}><i/>{line.replace(/^•\s*/, '')}</div> : <p key={index}>{line}</p>) : <p className="muted">Your answer will appear here.</p>}</div><div className="response-foot"><span><span className="green-dot"/>{status}</span><button onClick={() => { if ('speechSynthesis' in window && answer) { window.speechSynthesis.cancel(); window.speechSynthesis.speak(new SpeechSynthesisUtterance(answer)); } }}><Volume2 size={14}/> Read aloud</button></div></div>
          <div className="quick-actions"><button onClick={() => void generate(question, 'SHORT', lowConfidence)}><span className="qa-icon">↘</span><span><b>Shorter answer</b><small>Get to the point</small></span><kbd>⌘ 1</kbd></button><button onClick={() => void generate(question, 'DETAILED', lowConfidence)}><span className="qa-icon">＋</span><span><b>Explain more</b><small>Add useful detail</small></span><kbd>⌘ 2</kbd></button><button onClick={followUp}><span className="qa-icon">↗</span><span><b>Generate follow-up</b><small>Prepare for what’s next</small></span></button></div>
          <div className="answer-status"><Clock3 size={13}/>{status}{pinned ? ' · Pinned for this session' : ''}</div>
        </div>
      </div>
      <footer className="bottom-bar"><div><span className="ready-led"/> Session ready <span className="divider">/</span> <span className="memory"><span className="privacy-dot"/> Memory only</span></div><div className="shortcuts"><span><kbd>⌘</kbd> + <kbd>↵</kbd> send question</span><span><kbd>⌘</kbd> + <kbd>space</kbd> listen</span><span><kbd>esc</kbd> stop</span><button onClick={() => setSettings(true)}>Settings <Settings2 size={13}/></button></div></footer>
    </section>
    {settings && <div className="modal-backdrop" onClick={() => setSettings(false)}><section className="settings-modal" onClick={event => event.stopPropagation()}><div className="modal-head"><div><div className="eyebrow">PREFERENCES</div><h2>Session settings</h2></div><button className="icon-button" onClick={() => setSettings(false)}><X size={18}/></button></div>
      <div className="settings-section-title">MICROPHONE & TRANSCRIPTION</div><label className="field-label">Speech recognition provider<select value={speechEngine} onChange={event => setSpeechEngine(event.target.value as 'browser' | 'deepgram')}><option value="browser">Browser built-in (easy setup)</option><option value="deepgram">Deepgram streaming (API key)</option></select></label><label className="field-label">Transcription language<select value={language} onChange={event => setLanguage(event.target.value)}><option value="en-US">English (US)</option><option value="es">Spanish</option><option value="fr">French</option><option value="de">German</option><option value="pt-BR">Portuguese (Brazil)</option><option value="ja">Japanese</option><option value="zh-CN">Chinese (Mandarin)</option></select></label><div className="settings-hint">Provider and language changes apply the next time you start listening.</div>
      {speechEngine === 'deepgram' && <><label className="field-label">Deepgram API key<input type="password" value={deepgramKey} onChange={event => { setDeepgramKey(event.target.value); setSpeechCheckMessage(''); }} placeholder="Held in memory for this session"/></label><button className="secondary speech-check" onClick={() => void checkSpeechProvider()} disabled={checkingSpeech || !deepgramKey.trim()}>{checkingSpeech ? 'Checking…' : 'Test transcription connection'}</button>{speechCheckMessage && <div className={'provider-result ' + (speechCheckMessage.startsWith('Connected') ? 'success' : '')}>{speechCheckMessage}</div>}<div className="settings-hint">This check validates the service connection only; it does not start the mic or send audio.</div></>}
      {speechEngine === 'deepgram' && <div className="device-settings"><div className="device-row"><label className="field-label">Input microphone<select value={audioDeviceId} onChange={event => setAudioDeviceId(event.target.value)}><option value="">System default</option>{audioInputs.map((device, index) => <option key={device.deviceId || index} value={device.deviceId}>{device.label}</option>)}</select></label><button className="secondary" onClick={() => void detectAudioInputs()}>Detect microphones</button></div>{deviceMessage && <div className="settings-hint">{deviceMessage}</div>}<div className="settings-hint">Device selection is available for Deepgram mode. The browser built-in provider uses the system default input.</div></div>}
      <div className="settings-note"><div className="privacy-dot"/><div><b>Memory only</b><p>Transcript and answers are not saved by this page and clear when it closes. Microphone access begins only after you press Start. {speechEngine === 'deepgram' ? 'Audio streams to Deepgram for transcription while listening.' : 'Browser speech recognition may process audio through its service provider.'}</p></div></div>
      <label className="toggle-row"><span><b>Clear transcript when stopping</b><small>End the session and discard its context on Stop listening</small></span><input type="checkbox" checked={clearOnStop} onChange={event => setClearOnStop(event.target.checked)}/></label>
      <label className="field-label">Your background for answer context<textarea value={background} onChange={event => setBackground(event.target.value)} placeholder="Role, experience, résumé highlights, technologies…" rows={3}/></label>
      <div className="settings-section-title provider-title">ANSWER PROVIDER</div><label className="toggle-row"><span><b>Use an AI provider</b><small>Stream answers from an OpenAI-compatible endpoint</small></span><input type="checkbox" checked={remote} onChange={event => setRemote(event.target.checked)}/></label>
      {remote && <div className="fields"><label>Chat completions endpoint<input value={endpoint} onChange={event => { setEndpoint(event.target.value); setProviderCheck(''); }}/></label><label>Model<input value={model} onChange={event => { setModel(event.target.value); setProviderCheck(''); }}/></label><label>API key<input type="password" value={apiKey} onChange={event => { setApiKey(event.target.value); setProviderCheck(''); }} placeholder="Held in memory for this session"/></label><small>Sent only to the endpoint above. The browser may block cross-origin requests unless the endpoint allows them.</small><button className="secondary full" onClick={() => void checkProvider()} disabled={checkingProvider}>{checkingProvider ? 'Checking…' : 'Test connection'}</button>{providerCheck && <div className={'provider-result ' + (providerCheck.startsWith('Connected') ? 'success' : '')}>{providerCheck}</div>}</div>}
      <button className="primary full" onClick={() => setSettings(false)}>Done</button>
    </section></div>}
  </main>;
}
