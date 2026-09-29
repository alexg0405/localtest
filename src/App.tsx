import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Activity, AudioLines, ChevronDown, Clipboard, Cpu, HelpCircle, Mic, MicOff, Pin, Send, Settings2, Sparkles, Square, Wifi, X, Volume2, Trash2 } from 'lucide-react';
import { LocalDemoProvider, OpenAICompatibleProvider, describeProviderError, followUpPrompt, type LLMProvider, type Mode } from './providers';
import { BrowserSpeechToTextProvider, DeepgramSpeechToTextProvider, type SpeechToTextProvider } from './speech';
import { compactText, draftReady, endsMidPhrase, inlineSegments, isFollowUp, likelyQuestion, parseAnswer, questionKind } from './text';

type Line = { text: string; time: string; at: number; confidence?: number };
type AudioInput = { deviceId: string; label: string };
type AnswerKind = 'answer' | 'followup';
type GenerateOptions = { mode?: Mode; uncertain?: boolean; partial?: boolean; followUp?: boolean };
const modes: Mode[] = ['SHORT', 'STANDARD', 'DETAILED', 'BULLETS'];
const initialQuestion = 'What is the difference between a process and a thread?';
const initialAnswer = 'A process is an executing program with its own memory space and resources. Threads are execution paths within a process; they share its memory but each has its own stack and registers.\n\nKEY CONCEPTS\n• Processes are isolated; threads share state\n• Sharing makes thread communication cheaper, but synchronization is needed\n• Switching between processes usually has more overhead\n\nEXAMPLE\nA browser can isolate tabs in processes while using threads for work within a tab.\n\nCOMMON FOLLOW-UP\nWhy are threads generally cheaper to create?';
const stamp = () => new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const mod = isMac ? '⌘' : 'Ctrl';
// ⌘ + Space opens Spotlight on macOS, so advertise ⌘ + Shift + Space there (both combinations work).
const listenKeys = isMac ? ['⌘', '⇧', 'space'] : ['Ctrl', 'space'];
const clearTimer = (timer: { current: number | null }) => { if (timer.current) window.clearTimeout(timer.current); timer.current = null; };
const inline = (text: string) => inlineSegments(text).map((segment, index) => segment.bold ? <b key={index}>{segment.text}</b> : segment.code ? <code key={index}>{segment.text}</code> : segment.text);

export default function App() {
  const [active, setActive] = useState(false); const activeRef = useRef(false); const [micReady, setMicReady] = useState(false);
  const sessionId = useRef(0); const sessionLanguage = useRef('en-US');
  const [transcript, setTranscript] = useState<Line[]>([]); const transcriptRef = useRef<Line[]>([]);
  const [draft, setDraft] = useState(''); const [interim, setInterim] = useState(''); const interimRef = useRef(''); const [question, setQuestion] = useState(initialQuestion); const [lowConfidence, setLowConfidence] = useState(false);
  const [answer, setAnswer] = useState(initialAnswer); const [mode, setMode] = useState<Mode>('STANDARD'); const [shownMode, setShownMode] = useState<Mode>('STANDARD'); const [answerKind, setAnswerKind] = useState<AnswerKind>('answer');
  const [status, setStatus] = useState('Demo answer ready'); const [error, setError] = useState(''); const [answerError, setAnswerError] = useState(''); const [voiceDetected, setVoiceDetected] = useState(false);
  const [generating, setGenerating] = useState(false); const [speaking, setSpeaking] = useState(false); const utterance = useRef<SpeechSynthesisUtterance | null>(null);
  const [providerCheck, setProviderCheck] = useState(''); const [checkingProvider, setCheckingProvider] = useState(false);
  const [pinned, setPinned] = useState<{ question: string; answer: string; mode: Mode; kind: AnswerKind } | null>(null); const [settings, setSettings] = useState(false);
  const [remote, setRemote] = useState(false); const [endpoint, setEndpoint] = useState('https://api.openai.com/v1/chat/completions');
  const [apiKey, setApiKey] = useState(''); const [model, setModel] = useState('gpt-4o-mini');
  const [speechEngine, setSpeechEngine] = useState<'browser' | 'deepgram'>('browser'); const [deepgramKey, setDeepgramKey] = useState(''); const [language, setLanguage] = useState('en-US');
  const [checkingSpeech, setCheckingSpeech] = useState(false); const [speechCheckMessage, setSpeechCheckMessage] = useState('');
  const [audioInputs, setAudioInputs] = useState<AudioInput[]>([]); const [audioDeviceId, setAudioDeviceId] = useState(''); const [deviceMessage, setDeviceMessage] = useState('');
  const [background, setBackground] = useState(''); const [clearOnStop, setClearOnStop] = useState(false);
  const speech = useRef<SpeechToTextProvider | null>(null); const controller = useRef<AbortController | null>(null); const partialTimer = useRef<number | null>(null);
  const partialAnswer = useRef(false);
  const partialQuestion = useRef('');
  const browserFinal = useRef(''); const browserConfidence = useRef<number | undefined>(undefined); const browserFinalTimer = useRef<number | null>(null); const browserFinalSince = useRef(0);
  const lastQuestion = useRef<{ text: string; at: number } | null>(null);
  const transcriptBody = useRef<HTMLDivElement>(null); const followTranscript = useRef(true); const manualInput = useRef<HTMLInputElement>(null); const settingsPanel = useRef<HTMLElement>(null);
  const provider = useCallback((): LLMProvider => remote ? new OpenAICompatibleProvider(endpoint, apiKey, model) : new LocalDemoProvider(), [remote, endpoint, apiKey, model]);
  const detectAudioInputs = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia) { setDeviceMessage('This page cannot access microphones. Open Roomside on 127.0.0.1 or localhost in a supported browser.'); return; }
    setDeviceMessage('Requesting microphone permission…');
    try {
      const permissionStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      permissionStream.getTracks().forEach(track => track.stop());
      const inputs = (await navigator.mediaDevices.enumerateDevices()).filter(device => device.kind === 'audioinput').map((device, index) => ({ deviceId: device.deviceId, label: device.label || `Microphone ${index + 1}` }));
      setAudioInputs(inputs); setAudioDeviceId(current => inputs.some(input => input.deviceId === current) ? current : ''); setDeviceMessage(inputs.length ? `${inputs.length} microphone${inputs.length === 1 ? '' : 's'} found.` : 'No microphones found.');
    } catch (reason: any) { setDeviceMessage(reason?.name === 'NotAllowedError' ? 'Microphone permission was denied. Allow access in browser settings.' : reason?.message || 'Could not list microphones.'); }
  }, []);
  const context = useCallback((q: string) => {
    const cutoff = Date.now() - 10 * 60 * 1000;
    const lines = transcriptRef.current.filter(line => line.at > cutoff).slice(-45).map(line => line.text);
    if (lines.length && compactText(lines[lines.length - 1]) === compactText(q)) lines.pop(); // The question itself is sent separately.
    const recent = lines.join('\n').slice(-7500); const profile = background.trim().slice(0, 2500);
    return [profile && `Candidate background:\n${profile}`, recent && `Recent conversation transcript (oldest first; speech recognition may contain errors):\n${recent}`].filter(Boolean).join('\n\n');
  }, [background]);
  const stopReading = useCallback(() => { utterance.current = null; if ('speechSynthesis' in window) window.speechSynthesis.cancel(); setSpeaking(false); }, []);
  const abortAnswer = useCallback(() => { controller.current?.abort(); controller.current = null; setGenerating(false); }, []);

  const generate = useCallback(async (q: string, options: GenerateOptions = {}) => {
    const text = q.trim(); if (!text) return;
    const selectedMode = options.mode ?? mode; stopReading();
    partialAnswer.current = !!options.partial;
    partialQuestion.current = options.partial ? text : '';
    controller.current?.abort(); const current = new AbortController(); controller.current = current;
    setQuestion(text); setLowConfidence(!!options.uncertain); setAnswer(''); setAnswerError(''); setShownMode(selectedMode); setAnswerKind(options.followUp ? 'followup' : 'answer'); setGenerating(true); setStatus('Preparing response…');
    try {
      const result = await provider().answer(options.followUp ? followUpPrompt(text) : text, context(text), selectedMode, chunk => {
        if (!current.signal.aborted) { setAnswer(value => value + chunk); setStatus('Writing response…'); }
      }, current.signal);
      if (!current.signal.aborted) { setAnswer(result); setStatus(result.trim() ? 'Response ready' : 'The provider returned an empty response'); }
    } catch (reason: any) {
      if (!current.signal.aborted) { partialAnswer.current = false; setStatus('Could not get a response'); setAnswerError(describeProviderError(reason)); }
    } finally { if (controller.current === current) { controller.current = null; setGenerating(false); } }
  }, [mode, provider, context, stopReading]);

  const addLine = useCallback((line: Line) => {
    const cutoff = Date.now() - 10 * 60 * 1000;
    const next = [...transcriptRef.current.filter(item => item.at > cutoff), line].slice(-90);
    transcriptRef.current = next; setTranscript(next);
  }, []);

  const commitSpeech = useCallback((text: string, confidence?: number) => {
    const utterance = text.trim(); if (!utterance) return;
    addLine({ text: utterance, time: stamp(), at: Date.now(), confidence });
    const uncertain = !!confidence && confidence < 0.45; const previous = lastQuestion.current;
    if (likelyQuestion(utterance, sessionLanguage.current)) {
      lastQuestion.current = { text: utterance, at: Date.now() };
      // The draft answer started from interim words already matches the final wording, so keep it.
      if (partialAnswer.current && compactText(utterance) === compactText(partialQuestion.current)) { partialAnswer.current = false; partialQuestion.current = ''; setQuestion(utterance); setLowConfidence(uncertain); }
      else { void generate(utterance, { uncertain }); setStatus('Question detected'); }
    }
    else if (previous && question === previous.text && Date.now() - previous.at < 5000 && endsMidPhrase(previous.text)) {
      // A pause split the question ("Can you walk me through" … "your latest project"); answer the whole thing.
      const merged = `${previous.text} ${utterance}`; lastQuestion.current = { text: merged, at: Date.now() };
      void generate(merged, { uncertain }); setStatus('Question continued · updating…');
    }
    else if (partialQuestion.current) { partialAnswer.current = false; partialQuestion.current = ''; abortAnswer(); setAnswer(''); setQuestion(''); setLowConfidence(false); setStatus('No question detected'); }
  }, [addLine, generate, abortAnswer, question]);

  const clear = useCallback(() => {
    abortAnswer(); stopReading(); clearTimer(partialTimer); clearTimer(browserFinalTimer);
    browserFinal.current = ''; browserConfidence.current = undefined; interimRef.current = ''; partialAnswer.current = false; partialQuestion.current = ''; lastQuestion.current = null; followTranscript.current = true;
    speech.current?.reset?.(); // Listening continues; only words already heard are dropped.
    transcriptRef.current = []; setTranscript([]); setDraft(''); setInterim(''); setQuestion(''); setAnswer(''); setAnswerError(''); setPinned(null); setLowConfidence(false); setError(''); setStatus('Context cleared');
  }, [abortAnswer, stopReading]);

  // Ends the listening session. Words the recognizer has not finalized yet are committed unless `discard` is set.
  const endListening = useCallback((discard: boolean) => {
    activeRef.current = false; setActive(false); setMicReady(false); setVoiceDetected(false);
    speech.current?.stop(); clearTimer(partialTimer); clearTimer(browserFinalTimer);
    const pending = [browserFinal.current, interimRef.current].filter(Boolean).join(' '); const confidence = browserConfidence.current;
    browserFinal.current = ''; browserConfidence.current = undefined; interimRef.current = ''; setInterim('');
    if (discard) { clear(); setStatus('Session ended · context cleared'); } else commitSpeech(pending, confidence);
    partialAnswer.current = false; partialQuestion.current = '';
  }, [clear, commitSpeech]);
  const stop = useCallback(() => { sessionId.current++; endListening(clearOnStop); }, [clearOnStop, endListening]);

  // Speech callbacks outlive the render that started listening; read the latest mode, provider, and settings through this ref.
  const latest = useRef({ generate, commitSpeech, endListening });
  useLayoutEffect(() => { latest.current = { generate, commitSpeech, endListening }; });

  const start = useCallback(() => {
    if (activeRef.current) return;
    setError(''); stopReading();
    const thisSession = ++sessionId.current; const engine = speechEngine; const lang = language; sessionLanguage.current = lang;
    clearTimer(partialTimer); clearTimer(browserFinalTimer); browserFinal.current = ''; browserConfidence.current = undefined; interimRef.current = '';
    partialAnswer.current = false; partialQuestion.current = ''; lastQuestion.current = null; setVoiceDetected(false); setMicReady(false); activeRef.current = true; setActive(true);
    speech.current?.stop(); speech.current = engine === 'deepgram' ? new DeepgramSpeechToTextProvider(deepgramKey, lang, audioDeviceId) : new BrowserSpeechToTextProvider(lang);
    const current = () => sessionId.current === thisSession;
    const showInterim = (text: string) => { interimRef.current = text; setInterim([browserFinal.current, text].filter(Boolean).join(' ')); };
    const commitBrowserFinal = () => { const text = browserFinal.current; const confidence = browserConfidence.current; browserFinal.current = ''; browserConfidence.current = undefined; browserFinalTimer.current = null; showInterim(interimRef.current); latest.current.commitSpeech(text, confidence); };
    const scheduleBrowserCommit = () => { clearTimer(browserFinalTimer); browserFinalTimer.current = window.setTimeout(commitBrowserFinal, 450); };
    void speech.current.start({
      onListening: listening => { if (!current()) return; if (listening) setMicReady(true); else if (activeRef.current) latest.current.endListening(false); },
      onVoiceActivity: detected => { if (current()) setVoiceDetected(detected); },
      onInterim: text => {
        if (!current()) return;
        showInterim(text);
        const pending = browserFinal.current;
        // Still talking after a pause: keep merging into the pending final (up to 4 s) so the question is not split.
        if (pending && text.trim() && Date.now() - browserFinalSince.current < 4000) scheduleBrowserCommit();
        // While a browser final is pending, new interim words continue the utterance rather than replace the draft.
        if (!pending && text.trim() && partialQuestion.current && compactText(text) !== compactText(partialQuestion.current)) {
          partialAnswer.current = false; partialQuestion.current = text; abortAnswer(); setAnswer(''); setQuestion(text.trim()); setLowConfidence(true); setStatus('Question changed · updating…');
        }
        clearTimer(partialTimer);
        const spoken = [pending, text].filter(Boolean).join(' ');
        if (text.trim() && draftReady(spoken, lang) && likelyQuestion(spoken, lang)) partialTimer.current = window.setTimeout(() => { if (current() && activeRef.current) void latest.current.generate(spoken, { partial: true }); }, 650);
      },
      onFinal: result => {
        if (!current()) return;
        clearTimer(partialTimer);
        if (engine === 'browser') {
          // Chrome can split one question into several final segments; merge segments that arrive close together.
          if (!browserFinal.current) browserFinalSince.current = Date.now();
          browserFinal.current = [browserFinal.current, result.text].filter(Boolean).join(' ').trim(); browserConfidence.current = result.confidence ?? browserConfidence.current; showInterim('');
          scheduleBrowserCommit();
        } else { showInterim(''); latest.current.commitSpeech(result.text, result.confidence); }
      },
      onError: message => { if (current()) setError(message); },
    }).catch((reason: any) => {
      if (!current() || !activeRef.current) return;
      activeRef.current = false; setActive(false); setMicReady(false); setVoiceDetected(false);
      setError(reason?.name === 'NotAllowedError' ? 'Microphone permission was denied. Allow access in browser settings, then try again.' : reason?.name === 'NotFoundError' ? 'No microphone was found. Connect a microphone or enter a question manually.' : reason?.message || 'Could not start speech recognition.');
    });
  }, [speechEngine, deepgramKey, language, audioDeviceId, stopReading, abortAnswer]);

  const submitManual = useCallback(() => {
    const q = draft.trim(); if (!q) return;
    addLine({ text: q, time: stamp(), at: Date.now() }); setDraft(''); void generate(q);
  }, [draft, addLine, generate]);
  const currentPinned = !!pinned && pinned.question === question && pinned.answer === answer;
  const canPin = !!answer.trim() && !generating;
  const togglePin = useCallback(() => { if (currentPinned) setPinned(null); else if (canPin) setPinned({ question, answer, mode: shownMode, kind: answerKind }); }, [currentPinned, canPin, question, answer, shownMode, answerKind]);
  const restorePinned = useCallback(() => {
    if (!pinned) return;
    abortAnswer(); stopReading(); partialAnswer.current = false; partialQuestion.current = '';
    setQuestion(pinned.question); setAnswer(pinned.answer); setShownMode(pinned.mode); setAnswerKind(pinned.kind); setAnswerError(''); setLowConfidence(false); setStatus('Pinned answer restored');
  }, [pinned, abortAnswer, stopReading]);
  const checkProvider = useCallback(async () => {
    if (!remote) { setProviderCheck('The offline demo provider is ready.'); return; }
    if (!endpoint.trim() || !model.trim()) { setProviderCheck('Enter an endpoint and model name first.'); return; }
    setCheckingProvider(true); setProviderCheck('Checking endpoint…');
    const check = new AbortController(); const timeout = window.setTimeout(() => check.abort(), 30000);
    try {
      const result = await provider().answer('Reply with exactly: OK', '', 'SHORT', () => undefined, check.signal);
      setProviderCheck(result.trim() ? 'Connected. The provider returned a response.' : 'Connected, but the provider returned an empty response.');
    } catch (reason: any) {
      setProviderCheck(check.signal.aborted ? 'Connection failed: no response within 30 seconds.' : `Connection failed: ${describeProviderError(reason)}`);
    } finally { window.clearTimeout(timeout); setCheckingProvider(false); }
  }, [remote, endpoint, model, provider]);
  const checkSpeechProvider = useCallback(async () => {
    setCheckingSpeech(true); setSpeechCheckMessage('Checking Deepgram…');
    try { await DeepgramSpeechToTextProvider.checkConnection(deepgramKey, language); setSpeechCheckMessage('Connected. No microphone audio was sent.'); }
    catch (reason: any) { setSpeechCheckMessage(reason?.message || 'Could not connect to Deepgram.'); }
    finally { setCheckingSpeech(false); }
  }, [deepgramKey, language]);
  const chooseMode = useCallback((next: Mode) => { setMode(next); if (question) void generate(question, { mode: next, uncertain: lowConfidence }); }, [question, generate, lowConfidence]);
  // Quick actions are one-off requests; they do not change the selected mode.
  const shorter = useCallback(() => void generate(question, { mode: 'SHORT', uncertain: lowConfidence }), [question, generate, lowConfidence]);
  const detailed = useCallback(() => void generate(question, { mode: 'DETAILED', uncertain: lowConfidence }), [question, generate, lowConfidence]);
  const followUp = useCallback(() => void generate(question, { mode: 'SHORT', followUp: true, uncertain: lowConfidence }), [question, generate, lowConfidence]);
  const regenerate = useCallback(() => void generate(question, { mode: shownMode, followUp: answerKind === 'followup', uncertain: lowConfidence }), [question, generate, shownMode, answerKind, lowConfidence]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return; // 229: key pressed during IME composition.
      if (settings) { if (event.key === 'Escape') { event.preventDefault(); setSettings(false); } return; }
      const command = event.metaKey || event.ctrlKey; const once = !event.repeat;
      if (command && event.key === 'Enter') { event.preventDefault(); submitManual(); }
      else if (command && event.code === 'Space') { event.preventDefault(); if (once) { if (activeRef.current) stop(); else start(); } }
      else if (command && (event.key === '1' || event.code === 'Digit1')) { event.preventDefault(); if (once) shorter(); }
      else if (command && (event.key === '2' || event.code === 'Digit2')) { event.preventDefault(); if (once) detailed(); }
      else if (command && event.key.toLowerCase() === 'p') { event.preventDefault(); if (once) togglePin(); }
      else if (event.key === 'Escape' && activeRef.current) stop();
    };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, [settings, submitManual, start, stop, shorter, detailed, togglePin]);
  useEffect(() => {
    if (!settings) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    settingsPanel.current?.focus(); return () => opener?.focus();
  }, [settings]);
  useEffect(() => { const body = transcriptBody.current; if (body && followTranscript.current) body.scrollTop = body.scrollHeight; }, [transcript, interim]);
  useEffect(() => () => { sessionId.current++; activeRef.current = false; speech.current?.stop(); clearTimer(partialTimer); clearTimer(browserFinalTimer); controller.current?.abort(); if ('speechSynthesis' in window) window.speechSynthesis.cancel(); }, []);

  const blocks = parseAnswer(answer);
  const tag = isFollowUp(question, transcript.slice(0, -1).map(line => line.text).join(' ')) ? 'FOLLOW-UP' : questionKind(question);
  const providerLabel = remote ? `${model.trim() || 'No model set'} · ${(() => { try { return new URL(endpoint).host; } catch { return 'invalid endpoint URL'; } })()}` : 'Offline demo answers';
  const copyAnswer = async () => { try { await navigator.clipboard.writeText(answer); setStatus('Answer copied'); } catch { setAnswerError('Clipboard access is blocked. Select and copy the answer instead.'); } };
  const readAloud = () => {
    if (speaking) { stopReading(); return; }
    if (!('speechSynthesis' in window)) { setAnswerError('Read aloud is not supported in this browser.'); return; }
    const spoken = blocks.filter(block => block.type !== 'code').map(block => block.type === 'label' ? `${block.label}: ${block.text}` : block.text).join('\n').replace(/\*\*|`/g, '');
    if (!spoken.trim() || activeRef.current) return;
    window.speechSynthesis.cancel();
    const next = new SpeechSynthesisUtterance(spoken); next.lang = language; utterance.current = next;
    next.onend = next.onerror = () => { if (utterance.current === next) { utterance.current = null; setSpeaking(false); } };
    setSpeaking(true); window.speechSynthesis.speak(next);
  };

  return <main className="app">
    <aside className="rail"><div className="brand">r<span>.</span></div><div className="rail-sep"/><button className="rail-button selected" title="Session"><Activity/></button><button className="rail-button" onClick={() => setSettings(true)} title="Settings"><Settings2/></button><div className="rail-bottom"><button className="rail-button" title="Help" onClick={() => setSettings(true)}><HelpCircle/></button><div className="avatar">A</div></div></aside>
    <section className="workspace">
      <header className="topbar"><div><div className="eyebrow">PRACTICE SESSION <span className="dot"/></div><div className="session-title">Interview copilot <ChevronDown size={15}/></div></div><div className="top-actions"><div className="privacy"><span className="privacy-dot"/> Memory only · no saved transcript</div><button className="icon-button" onClick={() => setSettings(true)} aria-label="Settings" title="Settings"><Settings2 size={17}/></button><button className="icon-button" onClick={clear} aria-label="Clear context" title="Clear transcript and answer"><Trash2 size={17}/></button></div></header>
      <div className="content">
        <div className="left-col">
          <div className="section-head"><div><div className="eyebrow">YOUR ROOM AUDIO</div><h2>Live transcript</h2></div><div className={'mic-state ' + (active ? 'on' : '')}><i/>{active ? micReady ? voiceDetected ? 'Voice detected' : 'Listening' : 'Starting…' : 'Mic off'}</div></div>
          <div className="listen-card"><div className="listen-icon"><AudioLines size={22}/></div><div className="listen-copy"><strong>{active ? micReady ? 'Listening to conversation' : 'Starting microphone…' : 'Ready to listen'}</strong><span>{active ? 'This device’s microphone only' : 'Start only when everyone has agreed to the practice session'}</span></div><button onClick={() => active ? stop() : start()} className={'listen-button ' + (active ? 'stop' : '')}><span>{active ? <MicOff size={16}/> : <Mic size={16}/>}</span>{active ? 'Stop listening' : 'Start listening'}</button></div>
          {error && <div className="error" role="alert">{error}</div>}
          <div className="transcript-card"><div className="transcript-toolbar"><span><span className={'tiny-live ' + (active ? 'active' : '')}/> LIVE TRANSCRIPT</span><button onClick={clear} className="text-button"><Trash2 size={13}/> Clear context</button></div>
            <div className="transcript-body" ref={transcriptBody} onScroll={event => { const body = event.currentTarget; followTranscript.current = body.scrollHeight - body.scrollTop - body.clientHeight < 32; }}>{transcript.length === 0 && !interim ? <div className="empty-transcript"><div className="wave">〰</div><span>Your conversation will appear here.</span><small>Or enter a question below to try it out.</small></div> : <>{transcript.map((line, index) => <div className="transcript-line" key={`${line.at}-${index}`}><time>{line.time}</time><p>{line.text}</p></div>)}{interim && <div className="transcript-line interim"><time>live</time><p>{interim}<span className="cursor"/></p></div>}</>}</div>
            <div className="manual-input"><input ref={manualInput} value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); submitManual(); } }} placeholder="Type a question manually…" aria-label="Question"/><button onClick={submitManual} disabled={!draft.trim()} title="Send question" aria-label="Send question"><Send size={15}/></button></div>
          </div><div className="footnote"><Wifi size={13}/> Local voice activity meter · speech recognition may process audio according to its provider’s settings.</div>
        </div>
        <div className="right-col">
          <div className="answer-head"><div><div className="eyebrow">AI ASSIST <span className="sparkle"><Sparkles size={12}/></span></div><h2>Suggested response</h2></div><button className={'pin ' + (currentPinned ? 'pinned' : '')} onClick={togglePin} disabled={!currentPinned && !canPin} aria-pressed={currentPinned}><Pin size={15}/>{currentPinned ? 'Pinned' : 'Pin answer'}</button></div>
          {pinned && <div className="pinned-answer"><span><Pin size={13}/> PINNED · {pinned.question.length > 70 ? `${pinned.question.slice(0, 70)}…` : pinned.question}</span>{!currentPinned && <button onClick={restorePinned}>Restore</button>}<button className="unpin" onClick={() => setPinned(null)} aria-label="Unpin answer" title="Unpin answer"><X size={13}/></button></div>}
          <div className="mode-row" role="group" aria-label="Answer length">{modes.map(item => <button key={item} className={mode === item ? 'active' : ''} aria-pressed={mode === item} onClick={() => chooseMode(item)}>{item}</button>)}</div>
          <div className="question-card"><div className="question-label"><span className="question-mark">?</span>{lowConfidence ? 'POSSIBLE QUESTION' : 'DETECTED QUESTION'}{tag && <span className="tag">{tag}</span>}</div><div className="question-text">{question || 'Waiting for a question…'}</div><div className="question-actions"><button onClick={() => { setDraft(question); manualInput.current?.focus(); }} disabled={!question}><Clipboard size={13}/> Edit question</button><button onClick={regenerate} disabled={!question}><Sparkles size={13}/> Regenerate</button></div></div>
          <div className="response-card"><div className="response-top"><span><Sparkles size={14}/> {answerKind === 'followup' ? 'LIKELY FOLLOW-UP' : 'RESPONSE'} · {shownMode}</span><button className="icon-button small" onClick={copyAnswer} disabled={!answer.trim()} title="Copy answer" aria-label="Copy answer"><Clipboard size={14}/></button></div><div className="response-content" aria-live="polite" aria-busy={generating}>{blocks.map((block, index) => block.type === 'heading' ? <h4 key={index}>{inline(block.text)}</h4> : block.type === 'bullet' ? <div className="bullet" key={index}><i/><span>{inline(block.text)}</span></div> : block.type === 'code' ? <pre key={index}><code>{block.text}</code></pre> : block.type === 'label' ? <p key={index}><b>{block.label}:</b> {inline(block.text)}</p> : <p key={index}>{inline(block.text)}</p>)}{!blocks.length && !answerError && <p className="muted">{generating ? 'Preparing response…' : 'Your answer will appear here.'}</p>}{answerError && <div className="answer-error" role="alert">{answerError}</div>}</div><div className="response-foot"><span><span className={'green-dot ' + (answerError ? 'error-dot' : '')}/>{status}</span><button onClick={readAloud} disabled={!speaking && (!answer.trim() || active)} title={active ? 'Stop listening first so the microphone does not pick up the read-aloud audio' : undefined}>{speaking ? <Square size={12}/> : <Volume2 size={14}/>} {speaking ? 'Stop reading' : 'Read aloud'}</button></div></div>
          <div className="quick-actions"><button onClick={shorter} disabled={!question}><span className="qa-icon">↘</span><span><b>Shorter answer</b><small>Get to the point</small></span><kbd>{mod} 1</kbd></button><button onClick={detailed} disabled={!question}><span className="qa-icon">＋</span><span><b>Explain more</b><small>Add useful detail</small></span><kbd>{mod} 2</kbd></button><button onClick={followUp} disabled={!question}><span className="qa-icon">↗</span><span><b>Generate follow-up</b><small>Prepare for what’s next</small></span></button></div>
          <div className="answer-status"><Cpu size={13}/>{providerLabel}{pinned ? ' · Pinned for this session' : ''}</div>
        </div>
      </div>
      <footer className="bottom-bar"><div><span className="ready-led"/> {active ? micReady ? 'Listening' : 'Starting microphone…' : 'Session ready'} <span className="divider">/</span> <span className="memory"><span className="privacy-dot"/> Memory only</span></div><div className="shortcuts"><span><kbd>{mod}</kbd> + <kbd>↵</kbd> send question</span><span>{listenKeys.map((key, index) => <Fragment key={key}>{index ? ' + ' : ''}<kbd>{key}</kbd></Fragment>)} listen</span><span><kbd>esc</kbd> stop</span><button onClick={() => setSettings(true)}>Settings <Settings2 size={13}/></button></div></footer>
    </section>
    {settings && <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setSettings(false); }}><section className="settings-modal" ref={settingsPanel} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="settings-title"><div className="modal-head"><div><div className="eyebrow">PREFERENCES</div><h2 id="settings-title">Session settings</h2></div><button className="icon-button" onClick={() => setSettings(false)} aria-label="Close settings"><X size={18}/></button></div>
      <div className="settings-section-title">MICROPHONE & TRANSCRIPTION</div><label className="field-label">Speech recognition provider<select value={speechEngine} onChange={event => setSpeechEngine(event.target.value as 'browser' | 'deepgram')}><option value="browser">Browser built-in (easy setup)</option><option value="deepgram">Deepgram streaming (API key)</option></select></label><label className="field-label">Transcription language<select value={language} onChange={event => setLanguage(event.target.value)}><option value="en-US">English (US)</option><option value="es">Spanish</option><option value="fr">French</option><option value="de">German</option><option value="pt-BR">Portuguese (Brazil)</option><option value="ja">Japanese</option><option value="zh-CN">Chinese (Mandarin)</option></select></label><div className="settings-hint">Provider and language changes apply the next time you start listening.</div>
      {speechEngine === 'deepgram' && <><label className="field-label">Deepgram API key<input type="password" value={deepgramKey} onChange={event => { setDeepgramKey(event.target.value); setSpeechCheckMessage(''); }} placeholder="Held in memory for this session" autoComplete="off" spellCheck={false}/></label><button className="secondary speech-check" onClick={() => void checkSpeechProvider()} disabled={checkingSpeech || !deepgramKey.trim()}>{checkingSpeech ? 'Checking…' : 'Test transcription connection'}</button>{speechCheckMessage && <div className={'provider-result ' + (speechCheckMessage.startsWith('Connected') ? 'success' : '')}>{speechCheckMessage}</div>}<div className="settings-hint">This check validates the service connection only; it does not start the mic or send audio.</div></>}
      {speechEngine === 'deepgram' && <div className="device-settings"><div className="device-row"><label className="field-label">Input microphone<select value={audioDeviceId} onChange={event => setAudioDeviceId(event.target.value)}><option value="">System default</option>{audioInputs.map((device, index) => <option key={device.deviceId || index} value={device.deviceId}>{device.label}</option>)}</select></label><button className="secondary" onClick={() => void detectAudioInputs()}>Detect microphones</button></div>{deviceMessage && <div className="settings-hint">{deviceMessage}</div>}<div className="settings-hint">Device selection is available for Deepgram mode. The browser built-in provider uses the system default input.</div></div>}
      <div className="settings-note"><div className="privacy-dot"/><div><b>Memory only</b><p>Transcript and answers are not saved by this page and clear when it closes. Microphone access begins only after you press Start. {speechEngine === 'deepgram' ? 'Audio streams to Deepgram for transcription while listening.' : 'Browser speech recognition may process audio through its service provider.'}</p></div></div>
      <label className="toggle-row"><span><b>Clear transcript when stopping</b><small>End the session and discard its context on Stop listening</small></span><input type="checkbox" checked={clearOnStop} onChange={event => setClearOnStop(event.target.checked)}/></label>
      <label className="field-label">Your background for answer context<textarea value={background} onChange={event => setBackground(event.target.value)} placeholder="Role, experience, résumé highlights, technologies…" rows={3}/></label>
      <div className="settings-section-title provider-title">ANSWER PROVIDER</div><label className="toggle-row"><span><b>Use an AI provider</b><small>Stream answers from an OpenAI-compatible endpoint</small></span><input type="checkbox" checked={remote} onChange={event => setRemote(event.target.checked)}/></label>
      {remote && <div className="fields"><label>Chat completions endpoint<input type="url" value={endpoint} onChange={event => { setEndpoint(event.target.value); setProviderCheck(''); }} spellCheck={false}/></label><label>Model<input value={model} onChange={event => { setModel(event.target.value); setProviderCheck(''); }} spellCheck={false}/></label><label>API key<input type="password" value={apiKey} onChange={event => { setApiKey(event.target.value); setProviderCheck(''); }} placeholder="Held in memory for this session" autoComplete="off" spellCheck={false}/></label><small>Sent only to the endpoint above. The browser may block cross-origin requests unless the endpoint allows them.</small><button className="secondary full" onClick={() => void checkProvider()} disabled={checkingProvider}>{checkingProvider ? 'Checking…' : 'Test connection'}</button>{providerCheck && <div className={'provider-result ' + (providerCheck.startsWith('Connected') ? 'success' : '')}>{providerCheck}</div>}</div>}
      <button className="primary full" onClick={() => setSettings(false)}>Done</button>
    </section></div>}
  </main>;
}
