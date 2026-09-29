import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Activity, AudioLines, BookUser, ChevronDown, Clipboard, Cpu, FileText, HelpCircle, Mic, MicOff, Pin, Send, Settings2, Smartphone, Sparkles, Square, Upload, Wifi, X, Volume2, Trash2 } from 'lucide-react';
import { claudeModelLabel, claudeModels, type ClaudeModel } from './claude';
import { ClaudeCodeProvider, LocalDemoProvider, OpenAICompatibleProvider, claudeCodeStatus, describeProviderError, followUpPrompt, type LLMProvider, type Mode } from './providers';
import { BrowserSpeechToTextProvider, DeepgramSpeechToTextProvider, installOnDevice, learnVoice, onDeviceStatus, type OnDeviceStatus, type SpeechToTextProvider } from './speech';
import { buildProfile, contextBudget, forgetSavedContext, loadSavedContext, saveContext, type ContextFile } from './context';
import { acceptedFiles, extractText } from './documents';
import { contextFilesFromEnv, deepgramKeyFromEnv } from './env';
import { keytermsFor } from './vocabulary';
import { conversationMemory, heardCharacters, memoryBudget } from './memory';
import { MirrorConnection, mirrorBlocks, mirrorStatus, startMirror, stopMirror, type MirrorCommand, type MirrorStatus } from './mirror';
import { awaitingCheck, guessSpeaker, isClarifyingQuestion, parseSpeakerLabels, speakerInstructions, speakerPrompt, voiceGuess, voiceRoles, voiceSamples, type Speaker, type SpeakerSource } from './speakers';
import type { VoicePrint } from './voice';
import { compactText, draftReady, endsMidPhrase, isFollowUp, likelyQuestion, parseAnswer, questionKind, startsLikeReply } from './text';
import { AnswerContent, PastAnswer, QuestionLabel, type AnswerKind, type Entry, type Snapshot } from './AnswerCard';
import { SessionMenu } from './SessionMenu';
import { deleteSession, lastIds, listSessions, loadSession, newSessionId, storeSession, type SavedSession, type SessionLine, type SessionSummary } from './sessions';

type Line = SessionLine;
type AudioInput = { deviceId: string; label: string };
/** `replace` updates the current card instead of starting a new one (a question that continued after a pause). */
type GenerateOptions = { mode?: Mode; uncertain?: boolean; partial?: boolean; followUp?: boolean; replace?: boolean };
type AnswerSource = 'claude' | 'openai' | 'demo';
const modes: Mode[] = ['SHORT', 'STANDARD', 'DETAILED', 'BULLETS'];
const initialQuestion = 'What is the difference between a process and a thread?';
const initialAnswer = 'A process is an executing program with its own memory space and resources. Threads are execution paths within a process; they share its memory but each has its own stack and registers.\n\nKEY CONCEPTS\n• Processes are isolated; threads share state\n• Sharing makes thread communication cheaper, but synchronization is needed\n• Switching between processes usually has more overhead\n\nEXAMPLE\nA browser can isolate tabs in processes while using threads for work within a tab.\n\nCOMMON FOLLOW-UP\nWhy are threads generally cheaper to create?';
const stamp = () => new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const mod = isMac ? '⌘' : 'Ctrl';
// ⌘ + Space opens Spotlight on macOS, so advertise ⌘ + Shift + Space there (both combinations work).
const listenKeys = isMac ? ['⌘', '⇧', 'space'] : ['Ctrl', 'space'];
const clearTimer = (timer: { current: number | null }) => { if (timer.current) window.clearTimeout(timer.current); timer.current = null; };


type TranscriptLinesProps = { lines: Line[]; speakers: boolean; filter: 'all' | Speaker; onFlip(id: number): void };
/** The heard lines; memoized, so a streaming answer or live interim words do not re-render every line. */
const TranscriptLines = memo(function TranscriptLines({ lines, speakers, filter, onFlip }: TranscriptLinesProps) {
  return <>{lines.map((line, index) => <div className={'transcript-line' + (speakers && line.speaker ? ` ${line.speaker}` : '')} key={line.id}><time>{line.time}</time><p>{speakers && <button className={'speaker-tag' + (filter === 'all' && index && lines[index - 1].speaker === line.speaker ? ' same' : '')} onClick={() => onFlip(line.id)} title="Wrong person? Click to switch">{line.speaker === 'interviewer' ? 'Interviewer' : line.speaker === 'candidate' ? 'You' : 'Who?'}</button>}{line.text}</p></div>)}
    {speakers && filter !== 'all' && !lines.length && <div className="filter-empty">No lines from {filter === 'interviewer' ? 'the interviewer' : 'you'} yet.</div>}</>;
});

export default function App() {
  const [active, setActive] = useState(false); const activeRef = useRef(false); const [micReady, setMicReady] = useState(false);
  const sessionId = useRef(0); const sessionLanguage = useRef('en-US');
  const [transcript, setTranscript] = useState<Line[]>([]); const transcriptRef = useRef<Line[]>([]);
  const [draft, setDraft] = useState(''); const [interim, setInterim] = useState(''); const interimRef = useRef(''); const [question, setQuestion] = useState(initialQuestion); const [lowConfidence, setLowConfidence] = useState(false);
  const [answer, setAnswer] = useState(initialAnswer); const [mode, setMode] = useState<Mode>('STANDARD'); const [shownMode, setShownMode] = useState<Mode>('STANDARD'); const [answerKind, setAnswerKind] = useState<AnswerKind>('answer');
  const [status, setStatus] = useState('Demo answer ready'); const [error, setError] = useState(''); const [answerError, setAnswerError] = useState(''); const [voiceDetected, setVoiceDetected] = useState(false);
  const [generating, setGenerating] = useState(false); const [speaking, setSpeaking] = useState(false); const utterance = useRef<SpeechSynthesisUtterance | null>(null);
  const [providerCheck, setProviderCheck] = useState(''); const [checkingProvider, setCheckingProvider] = useState(false);
  const [pinned, setPinned] = useState<Entry | null>(null); const [history, setHistory] = useState<Entry[]>([]); const [panel, setPanel] = useState<'settings' | 'context' | 'phone' | null>(null); const settings = panel === 'settings';
  const [source, setSource] = useState<AnswerSource>('demo'); const sourceChosen = useRef(false); const [claudeModel, setClaudeModel] = useState<ClaudeModel>('claude-haiku-4-5'); const [endpoint, setEndpoint] = useState('https://api.openai.com/v1/chat/completions');
  const [apiKey, setApiKey] = useState(''); const [model, setModel] = useState('gpt-4o-mini');
  const [keyFromEnv, setKeyFromEnv] = useState(false);
  const [speechEngine, setSpeechEngine] = useState<'browser' | 'deepgram'>('browser'); const [deepgramKey, setDeepgramKey] = useState(''); const [language, setLanguage] = useState('en-US');
  const [checkingSpeech, setCheckingSpeech] = useState(false); const [speechCheckMessage, setSpeechCheckMessage] = useState('');
  const [audioInputs, setAudioInputs] = useState<AudioInput[]>([]); const [audioDeviceId, setAudioDeviceId] = useState(''); const [deviceMessage, setDeviceMessage] = useState('');
  const [clearOnStop, setClearOnStop] = useState(false); const [extraTerms, setExtraTerms] = useState('');
  const [speakers, setSpeakers] = useState(true); const [transcriptFilter, setTranscriptFilter] = useState<'all' | Speaker>('all'); const [speakerTick, setSpeakerTick] = useState(0);
  const lineId = useRef(0); const speakerCheck = useRef<AbortController | null>(null); const speakerPauseUntil = useRef(0);
  // Your voice sample from "Learn my voice": a few numbers per stretch of speech, kept in memory for this tab only.
  const voiceIds = useRef(new Map<string, number>()); const nextVoice = useRef(0); // Deepgram numbers voices afresh on every connection; these are unique per session.
  // The session in view. A saved one saves itself as it changes; any other stays in memory only.
  const [session, setSession] = useState(() => ({ id: newSessionId(), name: '', createdAt: Date.now(), saved: false }));
  const [sessionMenu, setSessionMenu] = useState(false); const [savedSessions, setSavedSessions] = useState<SessionSummary[] | null>(null); const [sessionNotice, setSessionNotice] = useState('');
  const picker = useRef<HTMLDivElement>(null); const sessionNow = useRef(session); const sessionSnapshot = useRef<() => SavedSession>(null!);
  const myVoice = useRef<VoicePrint[]>([]); const [voiceSetup, setVoiceSetup] = useState<{ state: 'idle' | 'recording' | 'done' | 'error'; seconds?: number; message?: string }>({ state: 'idle' });
  const [boostVocabulary, setBoostVocabulary] = useState(false); const [onDevice, setOnDevice] = useState<OnDeviceStatus | 'checking' | 'installing' | null>(null); const [micNotice, setMicNotice] = useState('');
  const [savedContext] = useState(loadSavedContext); const [keepContext, setKeepContext] = useState(!!savedContext);
  const [role, setRole] = useState(savedContext?.role ?? ''); const [about, setAbout] = useState(savedContext?.about ?? ''); const [files, setFiles] = useState<ContextFile[]>(savedContext?.files ?? []);
  const [defaultFiles, setDefaultFiles] = useState<string[]>([]); const defaultsRequested = useRef(false);
  const [dragging, setDragging] = useState(false); const [preview, setPreview] = useState<string | null>(null); const [contextNotice, setContextNotice] = useState('');
  const [mirror, setMirror] = useState<MirrorStatus | null>(null); const [mirrorBusy, setMirrorBusy] = useState(false); const [mirrorMessage, setMirrorMessage] = useState(''); const [mirrorLink, setMirrorLink] = useState(0);
  const mirrorConnection = useRef<MirrorConnection | null>(null); const mirrorCommand = useRef<(command: MirrorCommand) => void>(() => undefined);
  const profile = useMemo(() => buildProfile({ role, about, files }), [role, about, files]);
  const speech = useRef<SpeechToTextProvider | null>(null); const controller = useRef<AbortController | null>(null); const partialTimer = useRef<number | null>(null);
  const partialAnswer = useRef(false); const samplePending = useRef(true); // The sample question and answer shown until something is asked.
  const partialQuestion = useRef('');
  const browserFinal = useRef(''); const browserConfidence = useRef<number | undefined>(undefined); const browserFinalTimer = useRef<number | null>(null); const browserFinalSince = useRef(0);
  const lastQuestion = useRef<{ text: string; at: number } | null>(null);
  const transcriptBody = useRef<HTMLDivElement>(null); const followTranscript = useRef(true); const manualInput = useRef<HTMLInputElement>(null); const settingsPanel = useRef<HTMLElement>(null); const rail = useRef<HTMLElement>(null); const workspace = useRef<HTMLElement>(null);
  // The answer on screen as of the last render, so it can be kept in Recent when something replaces it.
  const display = useRef<Entry & { complete: boolean }>({ id: 0, time: '', tag: '', possible: false, question: '', answer: '', mode: 'STANDARD', kind: 'answer', complete: false });
  // The card at the bottom of the running list (0 while the sample answer is shown), and whether you are reading it.
  const [entryId, setEntryId] = useState(0); const [entryTime, setEntryTime] = useState(''); const entryCounter = useRef(0);
  const feed = useRef<HTMLDivElement>(null); const followFeed = useRef(true); const [newBelow, setNewBelow] = useState(false);
  const provider = useCallback((): LLMProvider => source === 'claude' ? new ClaudeCodeProvider(claudeModel) : source === 'openai' ? new OpenAICompatibleProvider(endpoint, apiKey, model) : new LocalDemoProvider(), [source, claudeModel, endpoint, apiKey, model]);
  // Start Claude Code now so the first answer skips its startup (the bridge then keeps one ready after every answer).
  useEffect(() => { if (source === 'claude') ClaudeCodeProvider.warm(claudeModel); }, [source, claudeModel]);
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
  // Every answer sees the whole conversation (within memoryBudget), so later questions can refer back to anything said earlier.
  const context = useCallback((q: string) => {
    const lines = transcriptRef.current.slice();
    if (lines.length && compactText(lines[lines.length - 1].text) === compactText(q)) lines.pop(); // The question itself is sent separately.
    const named = (line: Line) => speakers && line.speaker ? `${line.speaker === 'interviewer' ? 'Interviewer' : 'Candidate'}: ${line.text}` : line.text;
    const memory = conversationMemory(lines.map(line => ({ at: line.at, text: named(line) }))).text;
    return [profile.text && `Candidate background (their own notes and files):\n${profile.text}`, memory && `Conversation so far (oldest first; from live speech recognition, so words may be misheard${speakers ? ', and the Interviewer and Candidate labels are automatic guesses' : ''}):\n${memory}`].filter(Boolean).join('\n\n');
  }, [profile, speakers]);
  const addFiles = useCallback((list: FileList | File[]) => {
    for (const file of Array.from(list)) {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      if (file.size > 15 * 1024 * 1024) { setFiles(current => [...current, { id, name: file.name, size: file.size, text: '', status: 'error', error: 'Too large (over 15 MB).' }]); continue; }
      setFiles(current => [...current, { id, name: file.name, size: file.size, text: '', status: 'reading' }]);
      extractText(file).then(
        text => setFiles(current => current.map(item => item.id === id ? { ...item, text, status: 'ready' } : item)),
        (reason: any) => setFiles(current => current.map(item => item.id === id ? { ...item, status: 'error', error: reason?.message || 'Could not read this file.' } : item)));
    }
  }, []);
  const stopReading = useCallback(() => { utterance.current = null; if ('speechSynthesis' in window) window.speechSynthesis.cancel(); setSpeaking(false); }, []);
  const abortAnswer = useCallback(() => { controller.current?.abort(); controller.current = null; setGenerating(false); }, []);
  // A finished answer stays in the running list when the next one starts; drafts and unfinished answers are replaced in place.
  const archiveCurrent = useCallback(() => {
    const { complete, ...shown } = display.current;
    if (!complete || partialAnswer.current || !shown.id) return false;
    setHistory(list => [...list.filter(entry => entry.id !== shown.id), shown].slice(-60));
    return true;
  }, []);

  const generate = useCallback(async (q: string, options: GenerateOptions = {}) => {
    const text = q.trim(); if (!text) return;
    samplePending.current = false;
    const selectedMode = options.mode ?? mode; stopReading();
    if ((!options.replace && archiveCurrent()) || !display.current.id) { setEntryId(++entryCounter.current); setEntryTime(stamp()); }
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
  }, [mode, provider, context, stopReading, archiveCurrent]);

  const addLine = useCallback((line: Omit<Line, 'id'>) => {
    const next = [...transcriptRef.current, { ...line, id: ++lineId.current }].slice(-3000); // Hours of conversation; Clear conversation empties it.
    transcriptRef.current = next; setTranscript(next);
  }, []);

  const commitSpeech = useCallback((text: string, confidence?: number, deepgramVoice?: number) => {
    const utterance = text.trim(); if (!utterance) return;
    const voiceKey = `${sessionId.current}:${deepgramVoice}`;
    if (deepgramVoice !== undefined && !voiceIds.current.has(voiceKey)) voiceIds.current.set(voiceKey, nextVoice.current++);
    const voice = deepgramVoice === undefined ? undefined : voiceIds.current.get(voiceKey);
    // A Deepgram voice keeps the label it has had. Otherwise compare how the line sounded with each person's voice so far:
    // the words decide unless they say nothing or the voice clearly disagrees, and the background check has the last word.
    const known = voice === undefined ? undefined : voiceRoles(transcriptRef.current).get(voice);
    const print = voice === undefined ? speech.current?.takePrint?.() : undefined;
    const sounds = known ? undefined : voiceGuess(voiceSamples(transcriptRef.current, myVoice.current), print);
    const worded = guessSpeaker(utterance, sessionLanguage.current);
    const speaker = known ?? (sounds && (!worded || sounds.strength >= 5) ? sounds.speaker : worded);
    addLine({ text: utterance, time: stamp(), at: Date.now(), confidence, voice, print, heard: sounds?.speaker, speaker, by: known || (sounds && speaker === sounds.speaker && speaker !== worded) ? 'voice' : 'guess' });
    const uncertain = !!confidence && confidence < 0.45; const previous = lastQuestion.current;
    // Your own questions need no suggested answer: clarifying ones ("can I assume…"), and anything from a Deepgram voice known to be yours.
    const own = isClarifyingQuestion(utterance) || known === 'candidate';
    if (likelyQuestion(utterance, sessionLanguage.current) && !own) {
      lastQuestion.current = { text: utterance, at: Date.now() };
      // The draft answer started from interim words already matches the final wording, so keep it.
      if (partialAnswer.current && compactText(utterance) === compactText(partialQuestion.current)) { partialAnswer.current = false; partialQuestion.current = ''; setQuestion(utterance); setLowConfidence(uncertain); }
      else { void generate(utterance, { uncertain }); setStatus('Question detected'); }
    }
    // Not when the next words are a reply ("Sure…") or come from your voice.
    else if (!own && speaker !== 'candidate' && !startsLikeReply(utterance) && previous && question === previous.text && Date.now() - previous.at < 5000 && endsMidPhrase(previous.text)) {
      // A pause split the question ("Can you walk me through" … "your latest project"); answer the whole thing.
      const merged = `${previous.text} ${utterance}`; lastQuestion.current = { text: merged, at: Date.now() };
      void generate(merged, { uncertain, replace: true }); setStatus('Question continued · updating…');
    }
    // The end of a question whose draft already includes it ("…a URL shortener" after "How would you design"): keep that answer.
    else if (!own && partialQuestion.current && compactText(partialQuestion.current).endsWith(compactText(utterance))) {
      lastQuestion.current = { text: partialQuestion.current, at: Date.now() }; partialAnswer.current = false; partialQuestion.current = ''; setLowConfidence(uncertain);
    }
    else if (partialQuestion.current) { partialAnswer.current = false; partialQuestion.current = ''; abortAnswer(); setAnswer(''); setQuestion(''); setLowConfidence(false); setStatus('No question detected'); }
  }, [addLine, generate, abortAnswer, question]);

  const resetConversation = useCallback(() => {
    abortAnswer(); stopReading(); clearTimer(partialTimer); clearTimer(browserFinalTimer); const check = speakerCheck.current; speakerCheck.current = null; check?.abort(); voiceIds.current.clear(); nextVoice.current = 0;
    browserFinal.current = ''; browserConfidence.current = undefined; interimRef.current = ''; partialAnswer.current = false; partialQuestion.current = ''; lastQuestion.current = null; followTranscript.current = true;
    speech.current?.reset?.(); // Listening continues; only words already heard are dropped.
    transcriptRef.current = []; setTranscript([]); setDraft(''); setInterim(''); setQuestion(''); setAnswer(''); setAnswerError(''); setPinned(null); setHistory([]); setNewBelow(false); followFeed.current = true; setLowConfidence(false); setError(''); setStatus('Conversation cleared');
  }, [abortAnswer, stopReading]);
  // Clearing starts a new session. A saved one keeps what it had: its latest changes are saved first.
  const clear = useCallback(() => {
    if (sessionNow.current.saved) void storeSession(sessionSnapshot.current()).catch(() => undefined);
    resetConversation(); setSession({ id: newSessionId(), name: '', createdAt: Date.now(), saved: false }); setSessionNotice('');
  }, [resetConversation]);

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
  const tag = isFollowUp(question, transcript.length > 1 ? transcript[transcript.length - 2].text : '') ? 'FOLLOW-UP' : questionKind(question);
  useLayoutEffect(() => { latest.current = { generate, commitSpeech, endListening }; display.current = { id: entryId, time: entryTime, tag, possible: lowConfidence, question, answer, mode: shownMode, kind: answerKind, complete: !!answer.trim() && !generating && !answerError }; });

  const start = useCallback(() => {
    if (activeRef.current) return;
    setError(''); setMicNotice(''); stopReading();
    const thisSession = ++sessionId.current; const engine = speechEngine; const lang = language; sessionLanguage.current = lang;
    clearTimer(partialTimer); clearTimer(browserFinalTimer); browserFinal.current = ''; browserConfidence.current = undefined; interimRef.current = '';
    partialAnswer.current = false; partialQuestion.current = ''; lastQuestion.current = null; setVoiceDetected(false); setMicReady(false); activeRef.current = true; setActive(true);
    speech.current?.stop(); speech.current = engine === 'deepgram' ? new DeepgramSpeechToTextProvider(deepgramKey, lang, audioDeviceId, keytermsFor(extraTerms)) : new BrowserSpeechToTextProvider(lang, boostVocabulary ? keytermsFor(extraTerms) : []);
    const current = () => sessionId.current === thisSession;
    const showInterim = (text: string) => { interimRef.current = text; setInterim([browserFinal.current, text].filter(Boolean).join(' ')); };
    let draftText = ''; // The question-like words a draft answer is waiting to start from.
    let lastFinalAt = 0; let silent = false; // Whether the voice detector hears silence now.
    // Waits while words are still being recognized (for up to 4 s), or briefly after an unfinished-sounding final ("How would
    // you design…", up to 1.5 s), so a question split by a pause is committed whole. The commit answers it, so a draft still
    // waiting for the same words is dropped.
    const commitBrowserFinal = () => {
      clearTimer(browserFinalTimer); if (!browserFinal.current) return; // Silence and the timer can both call this.
      const continuing = interimRef.current.trim() && Date.now() - browserFinalSince.current < 4000;
      if (continuing || (endsMidPhrase(browserFinal.current) && Date.now() - lastFinalAt < 1500)) { scheduleBrowserCommit(); return; }
      const text = browserFinal.current; const confidence = browserConfidence.current; browserFinal.current = ''; browserConfidence.current = undefined;
      clearTimer(partialTimer); draftText = ''; showInterim(interimRef.current); latest.current.commitSpeech(text, confidence);
    };
    const scheduleBrowserCommit = () => { clearTimer(browserFinalTimer); browserFinalTimer.current = window.setTimeout(commitBrowserFinal, 450); };
    const startDraft = () => { clearTimer(partialTimer); const text = draftText; draftText = ''; if (text && current() && activeRef.current) void latest.current.generate(text, { partial: true }); };
    if (source === 'claude') ClaudeCodeProvider.warm(claudeModel); // Ready before the first question, however long the page has been open.
    void speech.current.start({
      onListening: listening => { if (!current()) return; if (listening) setMicReady(true); else if (activeRef.current) latest.current.endListening(false); },
      // When the voice stops, commit a finished-sounding final now, or start the draft for a complete-sounding question, rather
      // than waiting out timers (which Chrome slows to once a second while the tab is in the background).
      onVoiceActivity: detected => {
        if (!current()) return; setVoiceDetected(detected); silent = !detected; if (detected) return;
        if (browserFinal.current) commitBrowserFinal(); else if (draftText && !endsMidPhrase(draftText)) startDraft();
      },
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
        clearTimer(partialTimer); draftText = '';
        const spoken = [pending, text].filter(Boolean).join(' ');
        if (text.trim() && draftReady(spoken, lang) && likelyQuestion(spoken, lang) && !isClarifyingQuestion(spoken)) { draftText = spoken; partialTimer.current = window.setTimeout(startDraft, 650); }
      },
      onFinal: result => {
        if (!current()) return;
        clearTimer(partialTimer); draftText = '';
        if (engine === 'browser') {
          // Chrome can split one question into several final segments; merge segments that arrive close together.
          if (!browserFinal.current) browserFinalSince.current = Date.now();
          lastFinalAt = Date.now();
          browserFinal.current = [browserFinal.current, result.text].filter(Boolean).join(' ').trim(); browserConfidence.current = result.confidence ?? browserConfidence.current; showInterim('');
          if (silent) { clearTimer(browserFinalTimer); commitBrowserFinal(); } else scheduleBrowserCommit(); // Already quiet: no need to wait.
        } else { showInterim(''); latest.current.commitSpeech(result.text, result.confidence, result.speaker); }
      },
      onError: message => { if (current()) setError(message); },
      onNotice: message => { if (current()) setMicNotice(message); },
    }).catch((reason: any) => {
      if (!current() || !activeRef.current) return;
      activeRef.current = false; setActive(false); setMicReady(false); setVoiceDetected(false);
      setError(reason?.name === 'NotAllowedError' ? 'Microphone permission was denied. Allow access in browser settings, then try again.' : reason?.name === 'NotFoundError' ? 'No microphone was found. Connect a microphone or enter a question manually.' : reason?.message || 'Could not start speech recognition.');
    });
  }, [speechEngine, deepgramKey, language, audioDeviceId, extraTerms, boostVocabulary, source, claudeModel, stopReading, abortAnswer]);

  // A typed question joins the transcript like a spoken one, so later answers remember it.
  const ask = useCallback((text: string) => {
    const q = text.trim(); if (!q) return;
    addLine({ text: q, time: stamp(), at: Date.now(), speaker: 'interviewer', by: 'typed' }); void generate(q);
  }, [addLine, generate]);
  const submitManual = useCallback(() => { const q = draft.trim(); if (!q) return; setDraft(''); ask(q); }, [draft, ask]);
  const currentPinned = !!pinned && pinned.id === entryId && pinned.answer === answer;
  const canPin = !!answer.trim() && !generating;
  const togglePin = useCallback(() => { if (currentPinned) setPinned(null); else if (canPin) setPinned({ id: entryId, time: entryTime, tag, possible: lowConfidence, question, answer, mode: shownMode, kind: answerKind }); }, [currentPinned, canPin, entryId, entryTime, tag, lowConfidence, question, answer, shownMode, answerKind]);
  const pinEntry = useCallback((entry: Entry) => setPinned(current => current?.id === entry.id ? null : entry), []);
  const showSnapshot = useCallback((item: Snapshot, message: string) => {
    archiveCurrent(); abortAnswer(); stopReading(); partialAnswer.current = false; partialQuestion.current = ''; setEntryId(++entryCounter.current); setEntryTime(stamp());
    setQuestion(item.question); setAnswer(item.answer); setShownMode(item.mode); setAnswerKind(item.kind); setAnswerError(''); setLowConfidence(false); setStatus(message);
  }, [archiveCurrent, abortAnswer, stopReading]);
  // The pinned answer is usually still in the running list, so this scrolls to it; one that is not comes back at the end.
  const showPinned = useCallback(() => {
    if (!pinned) return;
    const card = feed.current?.querySelector<HTMLElement>(`[data-entry="${pinned.id}"]`);
    if (card) feed.current!.scrollTo({ top: card.offsetTop - 6, behavior: 'smooth' }); else showSnapshot(pinned, 'Pinned answer restored');
  }, [pinned, showSnapshot]);
  const copyText = useCallback(async (text: string) => { try { await navigator.clipboard.writeText(text); setStatus('Answer copied'); } catch { setStatus('Clipboard access is blocked. Select and copy the answer instead.'); } }, []);
  // Follow the newest card while you are reading it; if you scrolled up to an earlier answer, offer a jump instead.
  const latestInView = () => {
    const body = feed.current; if (!body) return true;
    const card = body.querySelector<HTMLElement>('[data-current]'); if (!card) return body.scrollHeight - body.scrollTop - body.clientHeight < 40;
    return card.offsetTop + card.offsetHeight > body.scrollTop + 8 && card.offsetTop < body.scrollTop + body.clientHeight - 8;
  };
  // Following scrolls instantly: a background tab may not run the smooth animation.
  const jumpToLatest = useCallback((smooth = true) => {
    const body = feed.current; const card = body?.querySelector<HTMLElement>('[data-current]');
    if (body && card) body.scrollTo({ top: card.offsetTop - 6, behavior: smooth ? 'smooth' : 'auto' });
    followFeed.current = true; setNewBelow(false);
  }, []);
  useLayoutEffect(() => { if (!entryId) return; if (followFeed.current) jumpToLatest(false); else setNewBelow(true); }, [entryId, jumpToLatest]);
  const checkProvider = useCallback(async () => {
    if (source === 'demo') { setProviderCheck('The offline demo provider is ready.'); return; }
    if (source === 'claude') {
      setCheckingProvider(true); setProviderCheck('Checking Claude Code…');
      const status = await claudeCodeStatus(); setCheckingProvider(false);
      setProviderCheck(!status ? 'Connection failed: answers from your Claude subscription need the local dev server. Start Roomside with npm start.' : !status.available ? 'Connection failed: Claude Code was not found on this computer.' : status.loggedIn ? 'Connected. Claude Code is signed in, so answers use your Claude subscription.' : 'Connection failed: Claude Code is not signed in yet. Run `claude auth login` in Terminal, then test again.');
      return;
    }
    if (!endpoint.trim() || !model.trim()) { setProviderCheck('Enter an endpoint and model name first.'); return; }
    setCheckingProvider(true); setProviderCheck('Checking endpoint…');
    const check = new AbortController(); const timeout = window.setTimeout(() => check.abort(), 30000);
    try {
      const result = await provider().answer('Reply with exactly: OK', '', 'SHORT', () => undefined, check.signal);
      setProviderCheck(result.trim() ? 'Connected. The provider returned a response.' : 'Connected, but the provider returned an empty response.');
    } catch (reason: any) {
      setProviderCheck(check.signal.aborted ? 'Connection failed: no response within 30 seconds.' : `Connection failed: ${describeProviderError(reason)}`);
    } finally { window.clearTimeout(timeout); setCheckingProvider(false); }
  }, [source, endpoint, model, provider]);
  const downloadOnDevice = useCallback(async () => { setOnDevice('installing'); setOnDevice(await installOnDevice(language) ? 'available' : await onDeviceStatus(language)); }, [language]);
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
  // Taps and typed questions from the phone mirror do exactly what the matching controls here do.
  useLayoutEffect(() => {
    mirrorCommand.current = command => {
      if (command.type === 'listen') { if (!activeRef.current) start(); }
      else if (command.type === 'stop') { if (activeRef.current) stop(); }
      else if (command.type === 'ask') ask(command.text);
      else if (command.type === 'mode') chooseMode(command.mode);
      else ({ shorter, detailed, followup: followUp, regenerate })[command.type]();
    };
  });
  const toggleMirror = useCallback(async (on: boolean) => {
    setMirrorBusy(true); setMirrorMessage('');
    try { setMirror(await (on ? startMirror() : stopMirror())); setMirrorLink(0); }
    catch (reason: any) { setMirrorMessage(reason?.message || 'Could not change the phone mirror.'); }
    finally { setMirrorBusy(false); }
  }, []);
  const mirrorHere = useCallback(async () => { setMirrorMessage(''); try { await mirrorConnection.current?.claim(); } catch (reason: any) { setMirrorMessage(reason?.message || 'Could not mirror this tab.'); } }, []);
  const refreshSessions = useCallback(() => {
    setSavedSessions(null);
    listSessions().then(setSavedSessions, () => { setSavedSessions([]); setSessionNotice('This browser would not open its saved sessions.'); });
  }, []);
  const saveThisSession = useCallback(async () => {
    const snapshot = sessionSnapshot.current();
    try { await storeSession(snapshot); setSession(current => ({ ...current, name: snapshot.name, saved: true })); setSessionNotice('Saved. From now on, changes save automatically.'); refreshSessions(); }
    catch { setSessionNotice('This browser would not save the session.'); }
  }, [refreshSessions]);
  const hasContent = () => { const now = sessionSnapshot.current(); return now.transcript.length > 0 || now.history.length > 0 || !!now.current?.answer.trim(); };
  const newSession = useCallback(() => {
    if (!sessionNow.current.saved && hasContent() && !window.confirm('Start a new session? This one is not saved, so its transcript and answers will be cleared.')) return;
    clear(); setSessionMenu(false);
  }, [clear]);
  // Picks a saved session back up: its transcript is the memory later answers use, and new speech adds to it.
  const restoreSession = useCallback((saved: SavedSession) => {
    resetConversation();
    const ids = lastIds(saved); lineId.current = ids.line; entryCounter.current = ids.entry; nextVoice.current = ids.voice + 1; samplePending.current = false;
    transcriptRef.current = saved.transcript; setTranscript(saved.transcript); setHistory(saved.history); setPinned(saved.pinned);
    const current = saved.current;
    setEntryId(current?.id ?? 0); setEntryTime(current?.time ?? ''); setQuestion(current?.question ?? ''); setAnswer(current?.answer ?? ''); setShownMode(current?.mode ?? 'STANDARD'); setAnswerKind(current?.kind ?? 'answer'); setLowConfidence(!!current?.possible);
    setSession({ id: saved.id, name: saved.name, createdAt: saved.createdAt, saved: true }); setSessionNotice(''); setStatus(`Opened “${saved.name}”`);
  }, [resetConversation]);
  const openSession = useCallback(async (id: string) => {
    if (activeRef.current) return;
    if (!sessionNow.current.saved && hasContent() && !window.confirm('This session is not saved. Open the other one and clear this one?')) return;
    if (sessionNow.current.saved) await storeSession(sessionSnapshot.current()).catch(() => undefined);
    const saved = await loadSession(id).catch(() => null);
    if (!saved) { setSessionNotice('That session could not be opened.'); refreshSessions(); return; }
    restoreSession(saved); setSessionMenu(false);
  }, [restoreSession, refreshSessions]);
  const deleteSaved = useCallback(async (item: SessionSummary) => {
    if (!window.confirm(`Delete “${item.name}”? Its transcript and answers cannot be recovered.`)) return;
    if (item.id === sessionNow.current.id) setSession(current => ({ ...current, saved: false })); // Stays on screen, in memory only.
    try { await deleteSession(item.id); } catch { setSessionNotice('This browser would not delete the session.'); }
    refreshSessions();
  }, [refreshSessions]);
  // Eight seconds of you reading aloud, so lines in your voice are labeled You from the start (the same microphone as listening).
  const teachVoice = useCallback(async () => {
    setVoiceSetup({ state: 'recording' });
    try {
      const prints = await learnVoice(8, speechEngine === 'deepgram' ? audioDeviceId : '');
      const seconds = Math.round(prints.reduce((sum, print) => sum + print.seconds, 0));
      if (prints.filter(print => print.pitch !== undefined).length < 2 || seconds < 3) throw new Error('Roomside did not hear enough of your voice. Try again a little closer to the microphone.');
      myVoice.current = prints; setVoiceSetup({ state: 'done', seconds });
    } catch (reason: any) { setVoiceSetup({ state: 'error', message: reason?.name === 'NotAllowedError' ? 'Microphone permission was denied. Allow it in the browser, then try again.' : reason?.message || 'Could not record your voice.' }); }
  }, [speechEngine, audioDeviceId]);
  // Your correction wins over guesses and checks, and later lines from the same Deepgram voice follow it.
  const flipSpeaker = useCallback((id: number) => {
    const next = transcriptRef.current.map(line => line.id === id ? { ...line, speaker: line.speaker === 'interviewer' ? 'candidate' as const : 'interviewer' as const, by: 'you' as const } : line);
    transcriptRef.current = next; setTranscript(next);
  }, []);
  const copyMirrorLink = useCallback(async (url: string) => { try { await navigator.clipboard.writeText(url); setMirrorMessage('Link copied.'); } catch { setMirrorMessage('Clipboard access is blocked. Select the link and copy it instead.'); } }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return; // 229: key pressed during IME composition.
      if (sessionMenu) { if (event.key === 'Escape') { event.preventDefault(); setSessionMenu(false); } return; }
      if (panel) { if (event.key === 'Escape') { event.preventDefault(); setPanel(null); } return; }
      const command = event.metaKey || event.ctrlKey; const once = !event.repeat;
      if (command && event.key === 'Enter') { event.preventDefault(); submitManual(); }
      else if (command && event.code === 'Space') { event.preventDefault(); if (once) { if (activeRef.current) stop(); else start(); } }
      else if (command && (event.key === '1' || event.code === 'Digit1')) { event.preventDefault(); if (once) shorter(); }
      else if (command && (event.key === '2' || event.code === 'Digit2')) { event.preventDefault(); if (once) detailed(); }
      else if (command && event.key.toLowerCase() === 'p') { event.preventDefault(); if (once) togglePin(); }
      else if (event.key === 'Escape' && activeRef.current) stop();
    };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, [panel, sessionMenu, submitManual, start, stop, shorter, detailed, togglePin]);
  useEffect(() => { if (sessionMenu) refreshSessions(); }, [sessionMenu, refreshSessions]);
  useEffect(() => {
    if (!sessionMenu) return;
    const away = (event: MouseEvent) => { if (!picker.current?.contains(event.target as Node)) setSessionMenu(false); };
    document.addEventListener('mousedown', away); return () => document.removeEventListener('mousedown', away);
  }, [sessionMenu]);
  useEffect(() => {
    if (!panel) return;
    // Keep keyboard focus and screen readers inside the dialog, then return focus to where it was.
    const behind = [rail.current, workspace.current]; const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    for (const element of behind) if (element) element.inert = true;
    settingsPanel.current?.focus();
    return () => { for (const element of behind) if (element) element.inert = false; opener?.focus(); };
  }, [panel]);
  // Only kept in this browser when the person opts in; turning it off deletes the saved copy.
  useEffect(() => {
    if (!keepContext) { forgetSavedContext(); setContextNotice(''); return; }
    const timer = window.setTimeout(() => setContextNotice(saveContext({ role, about, files }) ? '' : 'This browser would not save your context, so it stays in memory for this session.'), 400);
    return () => window.clearTimeout(timer);
  }, [keepContext, role, about, files]);
  useEffect(() => { const body = transcriptBody.current; if (body && followTranscript.current) body.scrollTop = body.scrollHeight; }, [transcript, interim, transcriptFilter]);
  // Vocabulary boosting needs Chrome's on-device model; show whether it is ready while Settings is open.
  useEffect(() => {
    if (panel !== 'settings' || speechEngine !== 'browser' || !boostVocabulary) return;
    let cancelled = false; setOnDevice('checking');
    void onDeviceStatus(language).then(status => { if (!cancelled) setOnDevice(status); });
    return () => { cancelled = true; };
  }, [panel, speechEngine, boostVocabulary, language]);
  // The sample answer only illustrates the offline demo; with a real provider, start from an empty panel.
  useEffect(() => { if (source !== 'demo' && samplePending.current) { samplePending.current = false; setQuestion(''); setAnswer(''); setStatus('Waiting for a question'); } }, [source]);
  // With Claude or an OpenAI-compatible provider, a fast background check corrects the first guesses a few lines at a time.
  const speakerModel = useMemo((): LLMProvider | null => source === 'claude' ? new ClaudeCodeProvider('claude-haiku-4-5') : source === 'openai' ? new OpenAICompatibleProvider(endpoint, apiKey, model) : null, [source, endpoint, apiKey, model]);
  useEffect(() => {
    const complete = speakerModel?.complete?.bind(speakerModel);
    if (!speakers || !complete || speakerCheck.current) return;
    const waiting = awaitingCheck(transcript); if (!waiting.length) return;
    // After a pause in the conversation, or about 4 s after the oldest unchecked line if people keep talking.
    const wait = Math.max(speakerPauseUntil.current - Date.now(), Math.min(1200, waiting[0].at + 4000 - Date.now()), 0);
    const timer = window.setTimeout(() => {
      const lines = transcriptRef.current; const pending = awaitingCheck(lines).slice(0, 12); if (!pending.length) return;
      const first = lines.indexOf(pending[0]); const check = new AbortController(); speakerCheck.current = check; const limit = window.setTimeout(() => check.abort(), 20_000);
      void complete(speakerInstructions, speakerPrompt(lines.slice(Math.max(0, first - 12), first), pending, role), check.signal).then(output => {
        if (check.signal.aborted) return;
        const labels = new Map(parseSpeakerLabels(output, pending.length).map((speaker, index) => [pending[index].id, speaker]));
        const next = transcriptRef.current.map(line => labels.has(line.id) && (line.by === 'guess' || line.by === 'voice') ? { ...line, speaker: labels.get(line.id) ?? line.speaker, by: 'ai' as const } : line);
        transcriptRef.current = next; setTranscript(next);
      }, () => { if (speakerCheck.current === check) speakerPauseUntil.current = Date.now() + 20_000; }) // Failed or took over 20 s: keep the guesses and try again a little later (Clear conversation is not a failure).
        .finally(() => { window.clearTimeout(limit); if (speakerCheck.current === check) { speakerCheck.current = null; setSpeakerTick(tick => tick + 1); } });
    }, wait);
    return () => window.clearTimeout(timer);
  }, [transcript, speakers, speakerModel, role, speakerTick]);
  // Phone mirroring needs the dev server, so its button appears only when the server answers.
  useEffect(() => { void mirrorStatus().then(setMirror); }, []);
  useEffect(() => { if (panel === 'phone' && !mirrorConnection.current) void mirrorStatus().then(status => { if (status) setMirror(status); }); }, [panel]);
  const mirrorRunning = !!mirror?.running;
  useEffect(() => {
    if (!mirrorRunning) return;
    const connection = new MirrorConnection({
      status: setMirror,
      command: command => mirrorCommand.current(command),
      stopped: () => setMirror(current => current && { ...current, running: false, owner: 'none', phones: 0, links: [] }),
    });
    mirrorConnection.current = connection;
    return () => { connection.close(); if (mirrorConnection.current === connection) mirrorConnection.current = null; };
  }, [mirrorRunning]);
  // Answer with the Claude subscription by default when Claude Code is signed in on this computer.
  useEffect(() => { void claudeCodeStatus().then(status => { if (status?.loggedIn && !sourceChosen.current) setSource('claude'); }); }, []);
  // Your default context files (résumé files in the project folder, or CONTEXT_FILES in .env) are added when Roomside
  // opens, unless your saved context already has them. The ref keeps React's double-run in development from adding them twice.
  useEffect(() => {
    if (defaultsRequested.current) return; defaultsRequested.current = true;
    void contextFilesFromEnv().then(list => {
      const have = new Set((savedContext?.files ?? []).map(file => file.name));
      setDefaultFiles(list.map(file => file.name)); const fresh = list.filter(file => !have.has(file.name)); if (fresh.length) addFiles(fresh);
    });
  }, [savedContext, addFiles]);
  // A DEEPGRAM_API_KEY in .env (see .env.example) fills in the key and switches transcription to Deepgram.
  useEffect(() => { void deepgramKeyFromEnv().then(key => { if (!key) return; setDeepgramKey(current => current || key); setKeyFromEnv(true); setSpeechEngine('deepgram'); }); }, []);
  useEffect(() => () => { sessionId.current++; activeRef.current = false; speech.current?.stop(); clearTimer(partialTimer); clearTimer(browserFinalTimer); controller.current?.abort(); if ('speechSynthesis' in window) window.speechSynthesis.cancel(); }, []);

  const blocks = parseAnswer(answer);
  const heardMinutes = transcript.length ? Math.max(1, Math.round((transcript[transcript.length - 1].at - transcript[0].at) / 60_000)) : 0;
  const overBudget = useMemo(() => heardCharacters(transcript) > memoryBudget, [transcript]);
  const memoryLabel = !transcript.length || source === 'demo' ? '' : overBudget ? ` · remembers the opening and latest part of the conversation (${heardMinutes} min)` : ` · remembers the conversation (${heardMinutes} min)`;
  const providerLabel = source === 'claude' ? `${claudeModelLabel(claudeModel)} · your Claude subscription` : source === 'openai' ? `${model.trim() || 'No model set'} · ${(() => { try { return new URL(endpoint).host; } catch { return 'invalid endpoint URL'; } })()}` : 'Offline demo answers';
  // The current card is shown once something is asked (or, before anything is, as the empty placeholder).
  const showCurrent = !!(question || answer || generating || answerError);
  const sessionPlaceholder = role.trim() || 'Practice session';
  useLayoutEffect(() => {
    sessionNow.current = session;
    sessionSnapshot.current = () => ({ version: 1, id: session.id, name: session.name.trim() || sessionPlaceholder, createdAt: session.createdAt, updatedAt: Date.now(), transcript: transcriptRef.current, history, current: showCurrent ? { id: entryId, time: entryTime, tag, possible: lowConfidence, question, answer, mode: shownMode, kind: answerKind } : null, pinned });
  });
  // A saved session saves itself a moment after it changes (not on every streamed word), and when the page closes.
  useEffect(() => {
    if (!session.saved) return;
    const timer = window.setTimeout(() => { void storeSession(sessionSnapshot.current()).catch(() => setSessionNotice('This browser would not save the latest changes.')); }, 800);
    return () => window.clearTimeout(timer);
  }, [session, transcript, history, question, answer, shownMode, answerKind, lowConfidence, pinned, entryId]);
  useEffect(() => {
    const flush = () => { if (sessionNow.current.saved) void storeSession(sessionSnapshot.current()).catch(() => undefined); };
    window.addEventListener('pagehide', flush); return () => window.removeEventListener('pagehide', flush);
  }, []);
  // Earlier answers for the phone, converted when the list changes rather than on every streamed word.
  const pastForPhone = useMemo(() => history.slice(-11).map(entry => ({ id: entry.id, question: entry.question, tag: entry.tag, possible: entry.possible, kind: entry.kind, mode: entry.mode, time: entry.time, blocks: mirrorBlocks(parseAnswer(entry.answer)) })), [history]);
  // Sends what the phone shows after every render; the connection skips renders that changed nothing it shows.
  useEffect(() => {
    mirrorConnection.current?.publish({
      listening: active ? micReady ? voiceDetected ? 'voice' : 'on' : 'starting' : 'off', micError: error, notice: micNotice,
      entries: showCurrent ? [...pastForPhone, { id: entryId, question, tag, possible: lowConfidence, kind: answerKind, mode: shownMode, time: entryTime, blocks: mirrorBlocks(blocks) }] : pastForPhone,
      live: showCurrent, generating, status, answerError, mode,
      heard: transcript.slice(-8).map(({ time, text, speaker }) => ({ time, text, ...(speakers && speaker ? { speaker } : {}) })), interim, provider: providerLabel,
    });
  });
  const link = mirror?.links[Math.min(mirrorLink, mirror.links.length - 1)];
  const shownLines = useMemo(() => speakers && transcriptFilter !== 'all' ? transcript.filter(line => line.speaker === transcriptFilter) : transcript, [speakers, transcriptFilter, transcript]);
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
    <aside className="rail" ref={rail}><div className="brand">r<span>.</span></div><div className="rail-sep"/><button className="rail-button selected" title="Session"><Activity/></button><button className="rail-button" onClick={() => setPanel('context')} title="Your context" aria-label="Your context"><BookUser/></button>{mirror && <button className="rail-button" onClick={() => setPanel('phone')} title="Phone mirror" aria-label="Phone mirror"><Smartphone/>{mirror.running && mirror.owner === 'this' && <i className={'rail-badge ' + (mirror.phones ? 'live' : '')}/>}</button>}<button className="rail-button" onClick={() => setPanel('settings')} title="Settings" aria-label="Settings"><Settings2/></button><div className="rail-bottom"><button className="rail-button" title="Help" onClick={() => setPanel('settings')}><HelpCircle/></button><div className="avatar">A</div></div></aside>
    <section className="workspace" ref={workspace}>
      <header className="topbar"><div><div className="eyebrow">PRACTICE SESSION <span className="dot"/></div><div className="session-picker" ref={picker}><button className="session-title" onClick={() => setSessionMenu(open => !open)} aria-expanded={sessionMenu} aria-haspopup="dialog" title="Save this session, or open a saved one">{session.name.trim() || (session.saved ? sessionPlaceholder : 'Interview copilot')} <ChevronDown size={15}/></button>{sessionMenu && <SessionMenu name={session.name} placeholder={sessionPlaceholder} saved={session.saved} currentId={session.id} listening={active} sessions={savedSessions} notice={sessionNotice} onRename={name => setSession(current => ({ ...current, name }))} onSave={() => void saveThisSession()} onNew={newSession} onOpen={id => void openSession(id)} onDelete={item => void deleteSaved(item)}/>}</div></div><div className="top-actions">{mirror?.running && mirror.owner === 'this' && <button className={'phone-chip ' + (mirror.phones ? 'live' : '')} onClick={() => setPanel('phone')} title="Phone mirror"><Smartphone size={13}/>{mirror.phones ? 'Phone connected' : 'Waiting for phone'}</button>}<div className="privacy"><span className="privacy-dot"/> {session.saved ? 'Saved on this computer' : 'Memory only · no saved transcript'}</div><button className="icon-button" onClick={() => setPanel('settings')} aria-label="Settings" title="Settings"><Settings2 size={17}/></button><button className="icon-button" onClick={clear} aria-label="Clear conversation" title="Clear transcript and answers"><Trash2 size={17}/></button></div></header>
      <div className="content">
        <div className="left-col">
          <div className="section-head"><div><div className="eyebrow">YOUR ROOM AUDIO</div><h2>Live transcript</h2></div><div className={'mic-state ' + (active ? 'on' : '')}><i/>{active ? micReady ? voiceDetected ? 'Voice detected' : 'Listening' : 'Starting…' : 'Mic off'}</div></div>
          <div className="listen-card"><div className="listen-icon"><AudioLines size={22}/></div><div className="listen-copy"><strong>{active ? micReady ? 'Listening to conversation' : 'Starting microphone…' : 'Ready to listen'}</strong><span>{active ? 'This device’s microphone only' : 'Start only when everyone has agreed to the practice session'}</span></div><button onClick={() => active ? stop() : start()} className={'listen-button ' + (active ? 'stop' : '')}><span>{active ? <MicOff size={16}/> : <Mic size={16}/>}</span>{active ? 'Stop listening' : 'Start listening'}</button></div>
          {error && <div className="error" role="alert">{error}</div>}{micNotice && <div className="mic-notice">{micNotice}</div>}
          <div className="transcript-card"><div className="transcript-toolbar"><span><span className={'tiny-live ' + (active ? 'active' : '')}/> LIVE TRANSCRIPT</span>{speakers && <div className="speaker-filter" role="group" aria-label="Show lines from">{(['all', 'interviewer', 'candidate'] as const).map(value => <button key={value} className={transcriptFilter === value ? 'active' : ''} aria-pressed={transcriptFilter === value} onClick={() => setTranscriptFilter(value)}>{value === 'all' ? 'All' : value === 'interviewer' ? 'Interviewer' : 'You'}</button>)}</div>}<button onClick={clear} className="text-button" title="Clear conversation"><Trash2 size={13}/> Clear</button></div>
            <div className="transcript-body" ref={transcriptBody} onScroll={event => { const body = event.currentTarget; followTranscript.current = body.scrollHeight - body.scrollTop - body.clientHeight < 32; }}>{transcript.length === 0 && !interim ? <div className="empty-transcript"><div className="wave">〰</div><span>Your conversation will appear here.</span><small>Or enter a question below to try it out.</small></div> : <><TranscriptLines lines={shownLines} speakers={speakers} filter={transcriptFilter} onFlip={flipSpeaker}/>{interim && <div className="transcript-line interim"><time>live</time><p>{interim}<span className="cursor"/></p></div>}</>}</div>
            <div className="manual-input"><input ref={manualInput} value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); submitManual(); } }} placeholder="Type a question manually…" aria-label="Question"/><button onClick={submitManual} disabled={!draft.trim()} title="Send question" aria-label="Send question"><Send size={15}/></button></div>
          </div><div className="footnote"><Wifi size={13}/> Local voice activity meter · speech recognition may process audio according to its provider’s settings.</div>
        </div>
        <div className="right-col">
          <div className="answer-head"><div><div className="eyebrow">AI ASSIST <span className="sparkle"><Sparkles size={12}/></span></div><h2>Suggested responses</h2></div>{history.length > 0 && <span className="answer-count">{history.length} earlier {history.length === 1 ? 'answer' : 'answers'} above</span>}</div>
          {pinned && <div className="pinned-answer"><span><Pin size={13}/> PINNED · {pinned.question.length > 70 ? `${pinned.question.slice(0, 70)}…` : pinned.question}</span><button onClick={showPinned}>Show</button><button className="unpin" onClick={() => setPinned(null)} aria-label="Unpin answer" title="Unpin answer"><X size={13}/></button></div>}
          <div className="mode-row" role="group" aria-label="Answer length">{modes.map(item => <button key={item} className={mode === item ? 'active' : ''} aria-pressed={mode === item} onClick={() => chooseMode(item)}>{item}</button>)}</div>
          <div className="answer-feed" ref={feed} onScroll={() => { followFeed.current = latestInView(); if (followFeed.current) setNewBelow(false); }}>
            {history.map(entry => <PastAnswer key={entry.id} entry={entry} pinned={pinned?.id === entry.id} onPin={pinEntry} onCopy={copyText}/>)}
            {(showCurrent || !history.length) && <article className="qa-entry current" data-entry={entryId} data-current="">
              <div className="question-card"><QuestionLabel possible={lowConfidence} time={entryTime} tag={tag}/><div className="question-text">{question || 'Waiting for a question…'}</div><div className="question-actions"><button onClick={() => { setDraft(question); manualInput.current?.focus(); }} disabled={!question}><Clipboard size={13}/> Edit question</button><button onClick={regenerate} disabled={!question}><Sparkles size={13}/> Regenerate</button></div></div>
              <div className="response-card"><div className="response-top"><span><Sparkles size={14}/> {answerKind === 'followup' ? 'LIKELY FOLLOW-UP' : 'RESPONSE'} · {shownMode}</span><span className="entry-tools"><button className={'icon-button small' + (currentPinned ? ' pinned' : '')} onClick={togglePin} disabled={!currentPinned && !canPin} title={currentPinned ? 'Unpin answer' : `Pin answer (${mod} P)`} aria-label={currentPinned ? 'Unpin answer' : 'Pin answer'} aria-pressed={currentPinned}><Pin size={14}/></button><button className="icon-button small" onClick={() => void copyText(answer)} disabled={!answer.trim()} title="Copy answer" aria-label="Copy answer"><Clipboard size={14}/></button></span></div><div className="response-content" aria-live="polite" aria-busy={generating}><AnswerContent blocks={blocks}/>{!blocks.length && !answerError && <p className="muted">{generating ? 'Preparing response…' : 'Your answer will appear here.'}</p>}{answerError && <div className="answer-error" role="alert">{answerError}</div>}</div><div className="response-foot"><span><span className={'green-dot ' + (answerError ? 'error-dot' : '')}/>{status}</span><button onClick={readAloud} disabled={!speaking && (!answer.trim() || active)} title={active ? 'Stop listening first so the microphone does not pick up the read-aloud audio' : undefined}>{speaking ? <Square size={12}/> : <Volume2 size={14}/>} {speaking ? 'Stop reading' : 'Read aloud'}</button></div></div>
            </article>}
            {newBelow && <button className="jump-latest" onClick={() => jumpToLatest()}>New answer ↓</button>}
          </div>
          <div className="quick-actions"><button onClick={shorter} disabled={!question}><span className="qa-icon">↘</span><span><b>Shorter answer</b><small>Get to the point</small></span><kbd>{mod} 1</kbd></button><button onClick={detailed} disabled={!question}><span className="qa-icon">＋</span><span><b>Explain more</b><small>Add useful detail</small></span><kbd>{mod} 2</kbd></button><button onClick={followUp} disabled={!question}><span className="qa-icon">↗</span><span><b>Generate follow-up</b><small>Prepare for what’s next</small></span></button></div>
          <div className="answer-status"><Cpu size={13}/>{providerLabel}{profile.used && source !== 'demo' ? ' · using your context' : ''}{memoryLabel}{pinned ? ' · Pinned for this session' : ''}</div>
        </div>
      </div>
      <footer className="bottom-bar"><div><span className="ready-led"/> {active ? micReady ? 'Listening' : 'Starting microphone…' : 'Session ready'} <span className="divider">/</span> <span className="memory"><span className="privacy-dot"/> {session.saved ? 'Session saved' : 'Memory only'}</span></div><div className="shortcuts"><span><kbd>{mod}</kbd> + <kbd>↵</kbd> send question</span><span>{listenKeys.map((key, index) => <Fragment key={key}>{index ? ' + ' : ''}<kbd>{key}</kbd></Fragment>)} listen</span><span><kbd>esc</kbd> stop</span><button onClick={() => setPanel('settings')}>Settings <Settings2 size={13}/></button></div></footer>
    </section>
    {settings && <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setPanel(null); }}><section className="settings-modal" ref={settingsPanel} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="settings-title"><div className="modal-head"><div><div className="eyebrow">PREFERENCES</div><h2 id="settings-title">Session settings</h2></div><button className="icon-button" onClick={() => setPanel(null)} aria-label="Close settings"><X size={18}/></button></div>
      <div className="settings-section-title">MICROPHONE & TRANSCRIPTION</div><label className="field-label">Speech recognition provider<select value={speechEngine} onChange={event => setSpeechEngine(event.target.value as 'browser' | 'deepgram')}><option value="browser">Browser built-in (easy setup)</option><option value="deepgram">Deepgram streaming (API key)</option></select></label><label className="field-label">Transcription language<select value={language} onChange={event => setLanguage(event.target.value)}><option value="en-US">English (US)</option><option value="es">Spanish</option><option value="fr">French</option><option value="de">German</option><option value="pt-BR">Portuguese (Brazil)</option><option value="ja">Japanese</option><option value="zh-CN">Chinese (Mandarin)</option></select></label><div className="settings-hint">Provider and language changes apply the next time you start listening.</div>
      {speechEngine === 'browser' && <><label className="toggle-row vocabulary-toggle"><span><b>Boost interview vocabulary</b><small>Uses Chrome's on-device speech model (Chrome 140 or newer) so terms like LeetCode and Two Sum, plus your extra words, are recognized more reliably. On-device recognition can be less accurate for everyday speech.</small></span><input type="checkbox" checked={boostVocabulary} onChange={event => setBoostVocabulary(event.target.checked)}/></label>
        {boostVocabulary && <div className="on-device-row"><span className="settings-hint">{onDevice === 'available' ? 'On-device model ready. Boosting applies the next time you start listening.' : onDevice === 'downloadable' ? "Chrome needs to download its on-device speech model once." : onDevice === 'downloading' || onDevice === 'installing' ? 'Downloading the on-device model…' : onDevice === 'unavailable' ? "On-device recognition is not available for this language in this browser. Google Chrome can download it for English (US)." : onDevice === 'unsupported' ? 'This browser cannot boost vocabulary; it needs Chrome 140 or newer.' : "Checking Chrome's on-device model…"}</span>{onDevice === 'downloadable' && <button className="secondary" onClick={() => void downloadOnDevice()}>Download model</button>}</div>}</>}
      {speechEngine === 'deepgram' && <><label className="field-label">Deepgram API key<input type="password" value={deepgramKey} onChange={event => { setDeepgramKey(event.target.value); setKeyFromEnv(false); setSpeechCheckMessage(''); }} placeholder="Held in memory, or set DEEPGRAM_API_KEY in .env" autoComplete="off" spellCheck={false}/></label>{keyFromEnv && <div className="settings-hint">Loaded from DEEPGRAM_API_KEY in your .env file.</div>}<button className="secondary speech-check" onClick={() => void checkSpeechProvider()} disabled={checkingSpeech || !deepgramKey.trim()}>{checkingSpeech ? 'Checking…' : 'Test transcription connection'}</button>{speechCheckMessage && <div className={'provider-result ' + (speechCheckMessage.startsWith('Connected') ? 'success' : '')}>{speechCheckMessage}</div>}<div className="settings-hint">This check validates the service connection only; it does not start the mic or send audio.</div></>}
      {speechEngine === 'deepgram' && <div className="device-settings"><div className="device-row"><label className="field-label">Input microphone<select value={audioDeviceId} onChange={event => setAudioDeviceId(event.target.value)}><option value="">System default</option>{audioInputs.map((device, index) => <option key={device.deviceId || index} value={device.deviceId}>{device.label}</option>)}</select></label><button className="secondary" onClick={() => void detectAudioInputs()}>Detect microphones</button></div>{deviceMessage && <div className="settings-hint">{deviceMessage}</div>}<div className="settings-hint">Device selection is available for Deepgram mode. The browser built-in provider uses the system default input.</div></div>}
      {(speechEngine === 'deepgram' || boostVocabulary) && <><label className="field-label">Extra words to recognize<textarea value={extraTerms} onChange={event => setExtraTerms(event.target.value)} placeholder="Company, product, and project names, one per line" rows={2}/></label><div className="settings-hint">Common interview terms such as LeetCode, Two Sum, and Big O are boosted too.</div></>}
      <div className="settings-note"><div className="privacy-dot"/><div><b>Memory only unless you save</b><p>Transcript and answers are not saved and clear when the page closes, unless you choose Save this session in the session menu (the title at the top left). Saved sessions stay in this browser on this computer until you delete them. Microphone access begins only after you press Start. {speechEngine === 'deepgram' ? 'Audio streams to Deepgram for transcription while listening.' : 'Browser speech recognition may process audio through its service provider.'}</p></div></div>
      <label className="toggle-row"><span><b>Clear transcript when stopping</b><small>End the session and discard its context on Stop listening</small></span><input type="checkbox" checked={clearOnStop} onChange={event => setClearOnStop(event.target.checked)}/></label>
      <label className="toggle-row"><span><b>Tell speakers apart</b><small>Labels each transcript line Interviewer or You, so answers know who said what. {source === 'demo' ? 'Guesses from the wording only; with Claude or an OpenAI-compatible provider, a quick background check also reads the conversation.' : `A quick background check by ${source === 'claude' ? 'Claude Haiku (a little of your Claude usage)' : 'your answer provider'} fixes wrong guesses.`}{speechEngine === 'deepgram' ? ' Deepgram also separates voices.' : ''} Click a label to correct it.</small></span><input type="checkbox" checked={speakers} onChange={event => setSpeakers(event.target.checked)}/></label>
      {speakers && <div className="voice-row"><span className="settings-hint">{voiceSetup.state === 'recording' ? 'Read this aloud, as you would in the interview: "I am practicing for an interview today. I enjoy building reliable software and explaining how it works."' : voiceSetup.state === 'done' ? `Learned your voice from ${voiceSetup.seconds} s of speech. Lines that sound like you are labeled You right away.` : voiceSetup.state === 'error' ? voiceSetup.message : active ? 'Stop listening to teach Roomside your voice.' : 'Optional: read a sentence aloud for 8 seconds so lines in your voice are labeled You from the start. Only a few numbers about your voice are kept, in this tab.'}</span>{voiceSetup.state === 'done' && <button className="text-button" onClick={() => { myVoice.current = []; setVoiceSetup({ state: 'idle' }); }}>Forget</button>}<button className="secondary" onClick={() => void teachVoice()} disabled={voiceSetup.state === 'recording' || active}>{voiceSetup.state === 'recording' ? 'Listening…' : voiceSetup.state === 'done' ? 'Learn again' : 'Learn my voice'}</button></div>}
      <div className="context-link"><span><b>Your context</b><small>{profile.used ? `${files.filter(file => file.status === 'ready').length} file(s) and notes · ${profile.used.toLocaleString()} characters` : 'Role, notes about you, résumé, and other files'}</small></span><button className="secondary" onClick={() => setPanel('context')}>Edit context</button></div>
      <div className="settings-section-title provider-title">ANSWER PROVIDER</div><label className="field-label">Answers from<select value={source} onChange={event => { sourceChosen.current = true; setSource(event.target.value as AnswerSource); setProviderCheck(''); }}><option value="claude">Claude, with your Claude subscription</option><option value="openai">OpenAI-compatible endpoint (API key)</option><option value="demo">Offline demo answers</option></select></label>
      {source === 'claude' && <div className="fields"><label>Model<select value={claudeModel} onChange={event => { setClaudeModel(event.target.value as ClaudeModel); setProviderCheck(''); }}>{claudeModels.map(item => <option key={item.id} value={item.id}>{item.label} ({item.note})</option>)}</select></label><small>Runs through Claude Code on this computer, signed in with your Claude account: no API key, and usage counts toward your plan. Works while Roomside runs from <code>npm start</code>.</small><button className="secondary full" onClick={() => void checkProvider()} disabled={checkingProvider}>{checkingProvider ? 'Checking…' : 'Test connection'}</button>{providerCheck && <div className={'provider-result ' + (providerCheck.startsWith('Connected') ? 'success' : '')}>{providerCheck}</div>}</div>}
      {source === 'openai' && <div className="fields"><label>Chat completions endpoint<input type="url" value={endpoint} onChange={event => { setEndpoint(event.target.value); setProviderCheck(''); }} spellCheck={false}/></label><label>Model<input value={model} onChange={event => { setModel(event.target.value); setProviderCheck(''); }} spellCheck={false}/></label><label>API key<input type="password" value={apiKey} onChange={event => { setApiKey(event.target.value); setProviderCheck(''); }} placeholder="Held in memory for this session" autoComplete="off" spellCheck={false}/></label><small>Sent only to the endpoint above. The browser may block cross-origin requests unless the endpoint allows them.</small><button className="secondary full" onClick={() => void checkProvider()} disabled={checkingProvider}>{checkingProvider ? 'Checking…' : 'Test connection'}</button>{providerCheck && <div className={'provider-result ' + (providerCheck.startsWith('Connected') ? 'success' : '')}>{providerCheck}</div>}</div>}
      <button className="primary full" onClick={() => setPanel(null)}>Done</button>
    </section></div>}
    {panel === 'context' && <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setPanel(null); }}><section className="settings-modal" ref={settingsPanel} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="context-title"><div className="modal-head"><div><div className="eyebrow">ANSWER CONTEXT</div><h2 id="context-title">Your context</h2></div><button className="icon-button" onClick={() => setPanel(null)} aria-label="Close context"><X size={18}/></button></div>
      <p className="context-intro">Add what your answers should know about you. Claude answers as you and tells STAR stories from your real projects; it may fill in believable details of a moment, but never new jobs, titles, or metrics.</p>
      <label className="field-label">Interviewing for<input className="text-input" value={role} onChange={event => setRole(event.target.value)} placeholder="e.g. Software Engineer Intern at Stripe"/></label>
      <label className="field-label">About you<textarea value={about} onChange={event => setAbout(event.target.value)} placeholder="Experience, projects, skills, stories you want to use, things to emphasize…" rows={5}/></label>
      <div className="field-label">Files
        <div className={'drop-zone ' + (dragging ? 'dragging' : '')} onDragOver={event => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={event => { event.preventDefault(); setDragging(false); addFiles(event.dataTransfer.files); }}>
          <Upload size={16}/><span>Drop your résumé, the job description, or notes here</span><label className="secondary file-picker">Choose files<input type="file" multiple accept={acceptedFiles} onChange={event => { if (event.target.files) addFiles(event.target.files); event.target.value = ''; }}/></label><small>PDF, Word (.docx), text, or Markdown · read on this computer, not uploaded</small>
        </div>
        {files.length > 0 && <ul className="file-list">{files.map(file => <li key={file.id}><div className="file-row"><FileText size={14}/><span className="file-name" title={file.name}>{file.name}</span><span className={'file-meta ' + (file.status === 'error' ? 'failed' : '')}>{file.status === 'reading' ? 'Reading…' : file.status === 'error' ? file.error : `${file.text.length.toLocaleString()} characters`}</span>{file.status === 'ready' && <button className="text-button" onClick={() => setPreview(current => current === file.id ? null : file.id)}>{preview === file.id ? 'Hide text' : 'View text'}</button>}<button className="text-button" onClick={() => setFiles(list => list.filter(item => item.id !== file.id))} aria-label={`Remove ${file.name}`} title="Remove"><X size={12}/></button></div>{preview === file.id && <pre className="file-preview">{file.text.length > 6000 ? `${file.text.slice(0, 6000)}…` : file.text}</pre>}</li>)}</ul>}{defaultFiles.length > 0 && <div className="settings-hint default-files">Added automatically whenever Roomside opens: {defaultFiles.join(', ')}. They come from the project folder; set CONTEXT_FILES in .env to choose other files.</div>}
      </div>
      <div className="context-meter" aria-hidden="true"><span style={{ width: `${Math.min(100, (profile.used / contextBudget) * 100)}%` }}/></div>
      <div className="settings-hint">{profile.used.toLocaleString()} of {contextBudget.toLocaleString()} characters are sent with each question{profile.truncated.length ? `; shortened to fit: ${profile.truncated.join(', ')}` : ''}.</div>
      <label className="toggle-row"><span><b>Keep on this computer</b><small>Saves this text in this browser only (never transcripts or keys). Turn it off to delete the saved copy.</small></span><input type="checkbox" checked={keepContext} onChange={event => setKeepContext(event.target.checked)}/></label>
      {contextNotice && <div className="provider-result">{contextNotice}</div>}
      <div className="settings-note"><div className="privacy-dot"/><div><b>Where it goes</b><p>Files are read in this browser. Their text is sent with each question to your answer provider{source === 'claude' ? ' (Claude, through your subscription)' : ''} and nowhere else.{source === 'demo' ? ' The offline demo answers do not use it.' : ''}</p></div></div>
      <button className="primary full" onClick={() => setPanel(null)}>Done</button>
    </section></div>}
    {panel === 'phone' && <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setPanel(null); }}><section className="settings-modal" ref={settingsPanel} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="phone-title"><div className="modal-head"><div><div className="eyebrow">PHONE MIRROR</div><h2 id="phone-title">Use your phone</h2></div><button className="icon-button" onClick={() => setPanel(null)} aria-label="Close phone mirror"><X size={18}/></button></div>
      <p className="context-intro">See each question and suggested answer on your phone, type questions there, and start or stop listening. Audio still comes only from this computer's microphone, so keep this page open; it can stay in the background.</p>
      {!mirror?.running ? <><button className="primary full" onClick={() => void toggleMirror(true)} disabled={mirrorBusy}>{mirrorBusy ? 'Starting…' : 'Start phone mirror'}</button><div className="settings-hint phone-hint">Your phone needs to be on the same Wi-Fi network as this computer.</div></>
        : mirror.owner === 'other' ? <div className="phone-other"><span>Another Roomside tab is mirrored to your phone right now.</span><button className="secondary" onClick={() => void mirrorHere()}>Mirror this tab</button></div>
          : link && <><div className="phone-pair"><img className="qr" src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(link.qr)}`} alt="QR code that opens Roomside on your phone" width={168} height={168}/><div className="phone-pair-copy"><b>Scan with your phone's camera</b><code className="phone-url">{link.url}</code><button className="text-button" onClick={() => void copyMirrorLink(link.url)}><Clipboard size={12}/> Copy link</button><span className={'phone-count ' + (mirror.phones ? 'live' : '')}><i/>{mirror.phones ? `${mirror.phones} phone${mirror.phones === 1 ? '' : 's'} connected` : 'Waiting for your phone…'}</span></div></div>
            {mirror.links.length > 1 && <label className="field-label">Network address<select value={mirrorLink} onChange={event => setMirrorLink(Number(event.target.value))}>{mirror.links.map((item, index) => <option key={item.url} value={index}>{new URL(item.url).hostname}{index === 0 ? ' (most likely)' : ''}</option>)}</select></label>}
            <div className="settings-hint phone-hint">Phone can't open it? Both devices must be on the same network, and campus or office Wi-Fi often blocks connections between devices; your phone's hotspot works instead. If macOS asks whether "node" may accept incoming connections, choose Allow.</div></>}
      {mirrorMessage && <div className={'provider-result phone-message ' + (mirrorMessage === 'Link copied.' ? 'success' : '')}>{mirrorMessage}</div>}
      <div className="settings-note"><div className="privacy-dot"/><div><b>Who can see it</b><p>Anyone with the link on your network can see this session's transcript and answers, and start or stop listening, until you stop mirroring. The link changes every time you start. Your context files are never sent to the phone.</p></div></div>
      {mirror?.running && <button className="secondary full phone-stop" onClick={() => void toggleMirror(false)} disabled={mirrorBusy}>Stop phone mirror</button>}
      <button className="primary full" onClick={() => setPanel(null)}>Done</button>
    </section></div>}
  </main>;
}
