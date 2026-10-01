import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { BookUser, ChevronDown, Copy, CornerDownLeft, FileText, ListChecks, Mic, Pencil, Pin, RefreshCw, Send, Settings2, Smartphone, Square, Upload, X, Volume2, Trash2 } from 'lucide-react';
import { claudeModelLabel, claudeModels, type ClaudeModel } from './claude';
import { ClaudeCodeProvider, LocalDemoProvider, OpenAICompatibleProvider, claudeCodeStatus, describeProviderError, followUpPrompt, liveCoachInstructions, reviewInstructions, topicsInstructions, type LLMProvider, type Mode } from './providers';
import { BrowserSpeechToTextProvider, DeepgramSpeechToTextProvider, installOnDevice, learnVoice, onDeviceStatus, type OnDeviceStatus, type SpeechToTextProvider } from './speech';
import { buildProfile, contextBudget, forgetSavedContext, loadSavedContext, saveContext, type ContextFile } from './context';
import { acceptedFiles, extractText } from './documents';
import { contextFilesFromEnv, deepgramKeyFromEnv } from './env';
import { keytermsFor } from './vocabulary';
import { conversationMemory, heardCharacters, memoryBudget } from './memory';
import { MirrorConnection, mirrorBlocks, mirrorStatus, startMirror, stopMirror, type MirrorCommand, type MirrorStatus } from './mirror';
import { LineVoice, awaitingCheck, cutsIn, guessSpeaker, isClarifyingQuestion, lastAsk, nearestVoice, parseSpeakerLabels, readsAnswer, speakerInstructions, speakerPrompt, splitInterruption, voiceGuess, voiceMatch, voiceRoles, voiceSamples, voicesDistinct, type ReadableAnswer, type Speaker, type SpeakerSource } from './speakers';
import type { VoicePrint } from './voice';
import { compactText, draftReady, endsMidPhrase, isFollowUp, likelyQuestion, opensProblem, parseAnswer, questionKind, startsLikeReply } from './text';
import { AnswerContent, EntryMeta, PastAnswer, type AnswerKind, type Entry, type Snapshot } from './AnswerCard';
import { SessionMenu } from './SessionMenu';
import { deleteSession, lastIds, listSessions, loadSession, newSessionId, storeSession, type SavedSession, type SessionLine, type SessionSummary } from './sessions';
import { acknowledges, closes, liveCoachPrompt, liveSteps, parseLiveCoach, type LiveCoach, type LiveHeard, type LiveStep, type LiveTurn } from './live';
import { coachPrompt, countFillers, parseCoaching, reviewSession } from './review';
import { noTopics, parseTopics, topicsPrompt, type Topics } from './topics';
import { ReviewPanel, type CoachingState } from './ReviewPanel';

type Line = SessionLine;
type AudioInput = { deviceId: string; label: string };
/** `replace` updates the current card instead of starting a new one (a question that continued after a pause), `keep`
 * leaves the old answer up until the new one starts arriving, and `before` is what the candidate said to the question
 * before, for a follow-up to go on from. */
type Before = { asked: string; said: string };
type GenerateOptions = { mode?: Mode; uncertain?: boolean; partial?: boolean; followUp?: boolean; replace?: boolean; keep?: boolean; before?: Before };
/** `words` are what a preview heard (the open line and the words still coming). */
type LiveUpdate = { step: Exclude<LiveStep, { action: 'hold' }>; partial: boolean; uncertain?: boolean; words?: string; before?: Before };
const wordCount = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;
// A follow-up that asks for another version of the solution ("Could you also do it recursively?"), which needs code.
const rewrite = /(?<![\p{L}\p{N}'])(?:(?:do|write|implement|code|solve|make|redo|rewrite)(?![\p{L}\p{N}'])[^?.!]*(?:recursive(?:ly)?|iterative(?:ly)?|in place|without|faster|better|constant space|less (?:space|memory)|another way|differently|in (?:java|python|c\+\+|c#|javascript|typescript|go|rust|kotlin|swift))|optimi[sz]e|code (?:it|that|this) up)(?![\p{L}\p{N}'])/iu;
/** What you said to the last question, when a new one comes: enough of your own account for a follow-up to go on from. */
const saidBefore = (step: LiveStep, prior: LiveTurn | null, extra = ''): Before | undefined => {
  const said = [...(prior?.said ?? []), extra].filter(Boolean).join(' ');
  return step.action === 'new' && prior && wordCount(said) >= 8 ? { asked: prior.asked, said } : undefined;
};
type AnswerSource = 'claude' | 'openai' | 'demo';
const modes: Mode[] = ['SHORT', 'STANDARD', 'DETAILED', 'BULLETS'];
const initialQuestion = 'What is the difference between a process and a thread?';
const initialAnswer = 'A process is an executing program with its own memory space and resources. Threads are execution paths within a process; they share its memory but each has its own stack and registers.\n\nKEY CONCEPTS\n• Processes are isolated; threads share state\n• Sharing makes thread communication cheaper, but synchronization is needed\n• Switching between processes usually has more overhead\n\nEXAMPLE\nA browser can isolate tabs in processes while using threads for work within a tab.\n\nCOMMON FOLLOW-UP\nWhy are threads generally cheaper to create?';
const stamp = () => new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const mod = isMac ? '⌘' : 'Ctrl';
// ⌘ + Space opens Spotlight on macOS, so advertise ⌘ + Shift + Space there (both combinations work).
const listenKeys = isMac ? ['⌘', '⇧', 'space'] : ['Ctrl', 'space'];
const shortcuts: [string[], string][] = [[listenKeys, 'Start or stop listening'], [['esc'], 'Stop listening'], [[mod, '↵'], 'Send the typed question'], [[mod, '1'], 'Shorter answer'], [[mod, '2'], 'More detail'], [[mod, 'P'], 'Pin or unpin the latest answer']];
// The role Roomside starts with when none is set, as an example to practice against (change it in Context).
const defaultRole = 'Capital One Intern';
const clearTimer = (timer: { current: number | null }) => { if (timer.current) window.clearTimeout(timer.current); timer.current = null; };
const lastWords = (text: string, count = 8) => { const words = text.trim().split(/\s+/); return words.length > count ? `…${words.slice(-count).join(' ')}` : words.join(' '); };


type TranscriptLinesProps = { lines: Line[]; speakers: boolean; filter: 'all' | Speaker; onFlip(id: number): void; onAnswer(text: string): void };
/** The heard lines; memoized, so a streaming answer or live interim words do not re-render every line. ↵ answers a line
 * that was missed as a question, or run together with other words. */
const TranscriptLines = memo(function TranscriptLines({ lines, speakers, filter, onFlip, onAnswer }: TranscriptLinesProps) {
  return <>{lines.map((line, index) => <div className={'transcript-line' + (speakers && line.speaker ? ` ${line.speaker}` : '')} key={line.id} data-line={line.id}><time>{line.time}</time><p>{speakers && <button className={'speaker-tag' + (filter === 'all' && index && lines[index - 1].speaker === line.speaker ? ' same' : '')} onClick={() => onFlip(line.id)} title={line.by === 'answer' ? 'You, reading a suggested answer. Wrong person? Click to switch' : 'Wrong person? Click to switch'}>{line.speaker === 'interviewer' ? 'Interviewer' : line.speaker === 'candidate' ? 'You' : 'Who?'}</button>}{line.text}</p><button className="answer-line" onClick={() => onAnswer(line.text)} title="Answer this line" aria-label="Answer this line"><CornerDownLeft size={14}/></button></div>)}
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
  const [pinned, setPinned] = useState<Entry | null>(null); const [history, setHistory] = useState<Entry[]>([]); const [panel, setPanel] = useState<'settings' | 'context' | 'phone' | 'review' | null>(null); const settings = panel === 'settings';
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
  const [role, setRole] = useState(savedContext?.role.trim() || defaultRole); const [about, setAbout] = useState(savedContext?.about ?? ''); const [files, setFiles] = useState<ContextFile[]>(savedContext?.files ?? []);
  const [defaultFiles, setDefaultFiles] = useState<string[]>([]); const defaultsRequested = useRef(false);
  const [dragging, setDragging] = useState(false); const [preview, setPreview] = useState<string | null>(null); const [contextNotice, setContextNotice] = useState('');
  const [mirror, setMirror] = useState<MirrorStatus | null>(null); const [mirrorBusy, setMirrorBusy] = useState(false); const [mirrorMessage, setMirrorMessage] = useState(''); const [mirrorLink, setMirrorLink] = useState(0);
  const mirrorConnection = useRef<MirrorConnection | null>(null); const mirrorCommand = useRef<(command: MirrorCommand) => void>(() => undefined);
  const profile = useMemo(() => buildProfile({ role, about, files }), [role, about, files]);
  const speech = useRef<SpeechToTextProvider | null>(null); const controller = useRef<AbortController | null>(null); const partialTimer = useRef<number | null>(null);
  const partialAnswer = useRef(false); const samplePending = useRef(true); // The sample question and answer shown until something is asked.
  const partialQuestion = useRef('');
  const browserFinal = useRef(''); const browserConfidence = useRef<number | undefined>(undefined); const browserFinalTimer = useRef<number | null>(null); const browserFinalSince = useRef(0);
  const pendingVoice = useRef<number | undefined>(undefined); // With Deepgram, who said the words waiting in browserFinal.
  const lineVoice = useRef(new LineVoice()); // What those words' stretches of speech sounded like.
  const lastQuestion = useRef<{ text: string; at: number } | null>(null);
  const transcriptBody = useRef<HTMLDivElement>(null); const followTranscript = useRef(true); const manualInput = useRef<HTMLInputElement>(null); const settingsPanel = useRef<HTMLElement>(null); const workspace = useRef<HTMLElement>(null);
  // The answer on screen as of the last render, so it can be kept in Recent when something replaces it.
  const display = useRef<Entry & { complete: boolean }>({ id: 0, time: '', tag: '', possible: false, question: '', answer: '', mode: 'STANDARD', kind: 'answer', complete: false });
  // Suggested answers you might be reading aloud (the last several and the pinned one), with the question each answers.
  const readable = useRef<ReadableAnswer[]>([]);
  // The latest answer at the top of the list (0 while the sample answer is shown), and whether you are reading it.
  const [entryId, setEntryId] = useState(0); const [entryTime, setEntryTime] = useState(''); const entryCounter = useRef(0);
  // The question being corrected on the latest card, if it is.
  const [editing, setEditing] = useState<{ id: number; text: string } | null>(null);
  const feed = useRef<HTMLDivElement>(null); const followFeed = useRef(true); const [newAnswer, setNewAnswer] = useState(false); const [earlierOpen, setEarlierOpen] = useState(false);
  // While you read an earlier answer: the card at the reading line, how far down the list it is, and where the list sits.
  // `feedAdjusted` is the scroll position the list was last moved to for it, and `feedJump` when a smooth jump to the live
  // answer ends, so neither is taken for your scrolling.
  const feedAnchor = useRef<{ id: string; top: number; feedTop: number; pageY: number } | null>(null); const feedAdjusted = useRef(-1); const feedJump = useRef(0);
  // The live answer (see live.ts): the turn it responds to, the prompt a preview from words still coming used, and the next
  // update waiting its turn, so updates stay at least 2 s apart while people talk.
  const [liveAnswers, setLiveAnswers] = useState(true); const liveOn = useRef(true);
  // The live coach, pinned above the answers: a request separate from the answer that reads each question and what is said
  // about it, for the key idea to land, the next points to make, and a tip on how you are coming across.
  const [liveCoach, setLiveCoach] = useState(true); const coachOn = useRef(true);
  const [coach, setCoach] = useState<(LiveCoach & { busy: boolean; after: string; asked: string }) | null>(null);
  const coachRun = useRef<AbortController | null>(null); const coachAt = useRef(0); const coachWords = useRef(0); const coachTimer = useRef<number | null>(null); const turnAt = useRef(0);
  const coachNow = useRef<typeof coach>(null); // The notes on screen, for fresh ones to differ from.
  // The interview's main questions (see topics.ts): reviewed from the transcript soon after a new question comes up, and
  // otherwise at most every 30 s while people talk; pinned above the answers, and given to answers and the coach.
  const [trackTopics, setTrackTopics] = useState(true); const topicsOn = useRef(true);
  const [topics, setTopics] = useState<Topics>(noTopics); const topicsNow = useRef<Topics>(noTopics); const [topicsOpen, setTopicsOpen] = useState(false); const [topicsBusy, setTopicsBusy] = useState(false);
  const topicsRun = useRef<AbortController | null>(null); const topicsAt = useRef(0); const topicsTimer = useRef<number | null>(null); const topicsSeen = useRef(0); const topicsWords = useRef(0); const topicsDue = useRef(false);
  // Coaching on the review of this session afterwards (see review.ts), from the last time you asked for it.
  const [coaching, setCoaching] = useState<CoachingState>({ state: 'idle' }); const reviewRun = useRef<AbortController | null>(null);
  const liveTurn = useRef<LiveTurn | null>(null); const livePartial = useRef(''); const liveHeard = useRef(''); const liveQueue = useRef<LiveUpdate | null>(null); const liveStarted = useRef(0); const liveTimer = useRef<number | null>(null);
  // Live answers rewritten in place, which you may still be reading aloud; with `readable`, what reading is checked against.
  const rewritten = useRef<ReadableAnswer[]>([]); const reading = useRef<ReadableAnswer[]>([]);
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
  const context = useCallback((q: string, before?: Before) => {
    const lines = transcriptRef.current.slice();
    if (lines.length && compactText(lines[lines.length - 1].text) === compactText(q)) lines.pop(); // The question itself is sent separately.
    const named = (line: Line) => speakers && line.speaker ? `${line.speaker === 'interviewer' ? 'Interviewer' : 'Candidate'}: ${line.text}` : line.text;
    const memory = conversationMemory(lines.map(line => ({ at: line.at, text: named(line) }))).text;
    // The last few suggested answers, so the next one does not repeat their stories or wording, each marked with whether
    // you read it aloud (a follow-up goes on from what you actually said). Answers to this same question are left out,
    // since Shorter, More detail, and Regenerate rework them.
    const earlier = [...new Map(readable.current.filter(entry => entry.answer.trim() && compactText(entry.question) !== compactText(q)).map(entry => [entry.answer, entry])).values()].slice(-3);
    const readAloud = transcriptRef.current.filter(line => line.by === 'answer');
    const used = (entry: ReadableAnswer) => readAloud.some(line => readsAnswer(line.text, [entry], sessionLanguage.current));
    const suggested = earlier.map(entry => `Q: ${entry.question}\nA (${used(entry) ? 'the candidate read this aloud' : 'not used'}): ${entry.answer.length > 600 ? `${entry.answer.slice(0, 600)}…` : entry.answer}`).join('\n\n');
    // A coding answer always opens with the same headings, so it is only asked for a different example.
    const openings = questionKind(q) === 'CODING' ? '' : `They began ${earlier.map(entry => `"${entry.answer.trim().split(/\s+/).slice(0, 4).join(' ')}…"`).join(', ')}. Begin a new answer differently, and use`;
    // The interviewer inviting your questions, or going on with the coding problem on the card before.
    const previous = display.current.question; const mainQuestion = topicsNow.current.list.find(topic => topic.id === topicsNow.current.current);
    const notes = [
      /\bquestions? for (?:me|us)\b|\bany (?:other |more )?questions\b|anything you(?:'d| would) like to (?:ask|know)/i.test(q) && "The interviewer is inviting the candidate's questions: suggest two short questions they could ask about the team, the role, or the work, phrased to the interviewer, without describing the candidate's own past work as the interviewer's.",
      previous && questionKind(previous) === 'CODING' && questionKind(q) !== 'BEHAVIORAL' && compactText(previous) !== compactText(q) && (rewrite.test(q)
        ? `This asks for a new version of the solution to the coding problem just discussed ("${previous.length > 300 ? `${previous.slice(0, 300)}…` : previous}"): even though it is a follow-up, use the CODING shape, with the complete new code under CODE.`
        : `This may go on from the coding problem just discussed ("${previous.length > 300 ? `${previous.slice(0, 300)}…` : previous}").`),
    ].filter(Boolean).join(' ');
    return [profile.text && `Candidate background (their own notes and files):\n${profile.text}`, memory && `Conversation so far (oldest first; from live speech recognition, so words may be misheard${speakers ? ', and the Interviewer and Candidate labels are automatic guesses' : ''}):\n${memory}`,
      suggested && `Answers already suggested in this interview, oldest first, with whether the candidate used each:\n${suggested}\n\n${openings || 'Use'} a different story, example, or detail from their background than they did (a new side of something already mentioned is fine; something made up is not). A follow-up on what was just discussed is different: continue the candidate's own account from the conversation, keeping to what they actually said, since a suggested answer they did not use is not part of it.`,
      notes,
      mainQuestion && compactText(mainQuestion.question) !== compactText(q) && `The main question being worked on now (the overarching case or problem this part of the interview is about; the question above may be a part of it): ${mainQuestion.question}`,
      // Right above the question, so a follow-up ("And how did it end up?") goes on from your story, not a suggested one.
      before && `What the candidate said just before this question, answering "${before.asked.length > 200 ? `${before.asked.slice(0, 200)}…` : before.asked}": "${before.said.length > 1500 ? `…${before.said.slice(-1500)}` : before.said}"\nIf this question follows up on that, continue their account from exactly there, keeping to what they said.`].filter(Boolean).join('\n\n');
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
    if (!options.keep) setAnswer('');
    setQuestion(text); setLowConfidence(!!options.uncertain); setAnswerError(''); setShownMode(selectedMode); setAnswerKind(options.followUp ? 'followup' : 'answer'); setGenerating(true); setStatus(options.keep ? 'Updating…' : 'Preparing response…');
    let fresh = !!options.keep; // The first words replace the answer kept up meanwhile.
    try {
      const result = await provider().answer(options.followUp ? followUpPrompt(text) : text, context(text, options.before), selectedMode, chunk => {
        if (!current.signal.aborted) { const first = fresh; fresh = false; setAnswer(value => first ? chunk : value + chunk); setStatus('Writing response…'); }
      }, current.signal);
      if (!current.signal.aborted) { setAnswer(result); setStatus(result.trim() ? 'Response ready' : 'The provider returned an empty response'); }
    } catch (reason: any) {
      if (!current.signal.aborted) { partialAnswer.current = false; setStatus('Could not get a response'); setAnswerError(describeProviderError(reason)); }
    } finally { if (controller.current === current) { controller.current = null; setGenerating(false); } }
  }, [mode, provider, context, stopReading, archiveCurrent]);

  // Starts a live answer update now, cutting off one still running (it was about older words). An update, or a preview
  // being replaced, rewrites the card in place and keeps the old answer up until the new one starts arriving.
  const runLive = useCallback(({ step, partial, uncertain, words, before }: LiveUpdate) => {
    clearTimer(liveTimer); liveQueue.current = null;
    const inPlace = step.action === 'update' || partialAnswer.current; const shown = display.current;
    // Words still coming start a new card or refine a preview, but never rewrite a finished answer in place: their line
    // could still turn out to be something else, and the answer would be lost.
    if (partial && inPlace && !partialAnswer.current && shown.complete) return;
    liveStarted.current = Date.now();
    if (inPlace && shown.answer.trim()) rewritten.current = [...rewritten.current.filter(item => item.answer !== shown.answer), { question: shown.question, answer: shown.answer }].slice(-3);
    livePartial.current = partial ? step.turn.asked : ''; liveHeard.current = partial ? compactText(words ?? '') : '';
    void generate(step.turn.asked, { replace: step.action === 'update', keep: inPlace, partial, uncertain, before });
  }, [generate]);
  // Words still coming update the live answer at most every 2 s, and never cut off the update that is running; a finished
  // line updates it at once.
  const pumpLive = useCallback(() => {
    clearTimer(liveTimer); const next = liveQueue.current; if (!next) return;
    const wait = 2000 - (Date.now() - liveStarted.current);
    if (wait > 0 || controller.current) liveTimer.current = window.setTimeout(() => latest.current.pumpLive(), Math.max(wait, 300));
    else runLive(next);
  }, [runLive]);
  const requestLive = useCallback((update: LiveUpdate) => { if (update.partial) { liveQueue.current = update; pumpLive(); } else runLive(update); }, [runLive, pumpLive]);
  // A question answered by hand (typed, ↵ on a line, or corrected) is the turn later lines relate to; updates waiting
  // for older words are dropped.
  // The live coach (see live.ts): starts on each new question with the key idea to land, then follows what is said about
  // it (your answer, their hints) at most every 8 s, once a dozen more words have been said. It never waits for the answer.
  const dropCoach = useCallback(() => { coachRun.current?.abort(); coachRun.current = null; clearTimer(coachTimer); coachWords.current = 0; setCoach(null); }, []);
  const runCoach = useCallback((turn: LiveTurn, fresh = false) => {
    const model = provider(); if (!model.complete) return;
    // Fresh tips on request: different from the ones on screen for this question.
    const shown = coachNow.current; const seen = fresh && shown?.asked === turn.asked && shown.key ? shown : undefined;
    coachRun.current?.abort(); clearTimer(coachTimer); const run = new AbortController(); coachRun.current = run; coachAt.current = Date.now(); coachWords.current = 0;
    // The words still coming in count too, so the coach (and a refresh mid-sentence) works from the conversation as it is now.
    const said = turn.said.join(' '); const speaking = [browserFinal.current, interimRef.current].filter(Boolean).join(' ').trim();
    const latestWords = [said, speaking].filter(Boolean).join(' '); const after = latestWords ? lastWords(latestWords, 6) : ''; const fillers = countFillers(said).reduce((sum, item) => sum + item.count, 0);
    setCoach(value => value?.asked === turn.asked ? { ...value, busy: true } : { key: '', points: [], tip: '', busy: true, after: '', asked: turn.asked });
    model.complete(liveCoachInstructions, `${context(turn.asked)}\n\n${liveCoachPrompt(turn, (Date.now() - turnAt.current) / 1000, fillers, role, seen, speaking)}`, run.signal).then(
      output => { if (run.signal.aborted || liveTurn.current?.asked !== turn.asked) return; const next = parseLiveCoach(output); setCoach(value => next ? { ...next, busy: false, after, asked: turn.asked } : value && { ...value, busy: false }); },
      () => { if (!run.signal.aborted) setCoach(value => value && { ...value, busy: false }); })
      .finally(() => { if (coachRun.current === run) coachRun.current = null; });
  }, [provider, context, role]);
  const runTopics = useCallback(() => {
    const model = provider(); clearTimer(topicsTimer); if (!model.complete || !topicsOn.current || !transcriptRef.current.length) return;
    topicsRun.current?.abort(); const run = new AbortController(); topicsRun.current = run;
    topicsAt.current = Date.now(); topicsWords.current = 0; topicsDue.current = false; setTopicsBusy(true);
    const lines = transcriptRef.current.map(line => ({ id: line.id, text: line.text, speaker: speakers ? line.speaker : undefined }));
    model.complete(topicsInstructions, topicsPrompt(lines, topicsNow.current), run.signal).then(
      output => { if (run.signal.aborted) return; const next = parseTopics(output, topicsNow.current); topicsNow.current = next; setTopics(next); },
      () => undefined)
      .finally(() => { if (topicsRun.current === run) { topicsRun.current = null; setTopicsBusy(false); latest.current.scheduleTopics(); } });
  }, [provider, speakers]);
  // Soon after a new question comes up (once its line has settled), and otherwise once 80 more words have been said, at
  // most every 15 s for a new question and every 30 s otherwise.
  const scheduleTopics = useCallback(() => {
    if (!topicsOn.current || topicsTimer.current || topicsRun.current || (!topicsDue.current && topicsWords.current < 80)) return;
    const wait = Math.max(2500, (topicsDue.current ? 15_000 : 30_000) - (Date.now() - topicsAt.current));
    topicsTimer.current = window.setTimeout(() => { topicsTimer.current = null; latest.current.runTopics(); }, wait);
  }, []);
  const startCoach = useCallback((turn: LiveTurn) => { if (!coachOn.current) return; turnAt.current = Date.now(); runCoach(turn); }, [runCoach]);
  // The refresh button: fresh tips for the question now, without waiting out the 8 s.
  const refreshCoach = useCallback(() => { const turn = liveTurn.current; if (turn && coachOn.current) runCoach(turn, true); }, [runCoach]);
  const requestCoach = useCallback(() => {
    clearTimer(coachTimer); const turn = liveTurn.current;
    if (!turn || !coachOn.current || coachWords.current < 12) return;
    const wait = 8000 - (Date.now() - coachAt.current);
    if (wait > 0 || coachRun.current) { coachTimer.current = window.setTimeout(() => latest.current.requestCoach(), Math.max(wait, 1000)); return; }
    runCoach(turn);
  }, [runCoach]);
  // A question answered by hand (typed, ↵ on a line, or corrected) is the turn later lines relate to, and gets coached;
  // updates waiting for older words are dropped.
  const resetLive = useCallback((turn: LiveTurn | null) => {
    liveTurn.current = turn; liveQueue.current = null; livePartial.current = ''; liveHeard.current = ''; clearTimer(liveTimer);
    if (turn) startCoach(turn); else dropCoach();
  }, [startCoach, dropCoach]);

  const addLine = useCallback((line: Omit<Line, 'id'>) => {
    const next = [...transcriptRef.current, { ...line, id: ++lineId.current }].slice(-3000); // Hours of conversation; Clear conversation empties it.
    transcriptRef.current = next; setTranscript(next);
  }, []);

  // `linePrint` is what the line's own stretches of speech sounded like (see LineVoice), with either engine.
  const commitSpeech = useCallback((text: string, confidence?: number, deepgramVoice?: number, linePrint?: VoicePrint) => {
    const said = text.trim(); if (!said) return;
    const language = sessionLanguage.current; const earlier = transcriptRef.current;
    const voiceKey = `${sessionId.current}:${deepgramVoice}`;
    if (deepgramVoice !== undefined && !voiceIds.current.has(voiceKey)) voiceIds.current.set(voiceKey, nextVoice.current++);
    const heardVoice = deepgramVoice === undefined ? undefined : voiceIds.current.get(voiceKey);
    const heardPrint = linePrint;
    const heardRole = heardVoice === undefined ? undefined : voiceRoles(transcriptRef.current).get(heardVoice);
    // The interviewer cut in while you were talking or reading a suggested answer aloud ("…and before that I was at oh so how
    // was that"): your words get their own line, and theirs are handled below like any utterance. Neither line keeps the
    // voice heard for the whole utterance, since it mixes both people.
    const cut = splitInterruption(said, reading.current, language, heardRole === 'interviewer');
    if (cut) addLine({ text: cut.yours, time: stamp(), at: Date.now(), confidence, speaker: 'candidate', by: cut.read ? 'answer' : 'guess' });
    const utterance = cut ? cut.theirs : said;
    const voice = cut ? undefined : heardVoice; const print = cut ? undefined : heardPrint;
    // You reading a suggested answer aloud: yours, whatever the voice or the wording suggests, and it needs no answer.
    const read = !cut && readsAnswer(utterance, reading.current, language);
    // Compare how the line sounded with each person's voice so far. A Deepgram voice keeps the label it has had unless the
    // sound clearly disagrees; otherwise the words decide unless they say nothing or the sound clearly disagrees, and the
    // background check has the last word.
    const sounds = read ? undefined : voiceGuess(voiceSamples(transcriptRef.current, myVoice.current), print);
    const role = cut ? undefined : heardRole;
    const known = role && !(sounds && sounds.speaker !== role && sounds.strength >= 5) ? role : undefined;
    const worded = guessSpeaker(utterance, language);
    const speaker = read ? 'candidate' : known ?? (sounds && (!worded || sounds.strength >= 5) ? sounds.speaker : worded);
    addLine({ text: utterance, time: stamp(), at: Date.now(), confidence, voice, print, heard: sounds?.speaker, speaker, by: read ? 'answer' : known || (sounds && speaker === sounds.speaker && speaker !== worded) ? 'voice' : 'guess' });
    const uncertain = !!confidence && confidence < 0.45; const previous = lastQuestion.current;
    // Your own questions need no suggested answer: clarifying ones ("can I assume…"), reading an answer aloud, and anything
    // from a Deepgram voice known to be yours.
    const own = read || isClarifyingQuestion(utterance) || known === 'candidate';
    // With Deepgram, your reading can arrive just before the question that cut into it, whose draft is already running.
    const draftStart = compactText(partialQuestion.current).split(' ').slice(0, 3).join(' ');
    if (liveOn.current) {
      // The live answer responds to every line, not only questions (see live.ts): your words before the interviewer cut
      // in, theirs, and your reply, as one step.
      const heard = (words: string, who: Speaker | undefined, isRead: boolean, yours = false): LiveHeard => ({ text: words, speaker: who, read: isRead, clarifying: isClarifyingQuestion(words), question: likelyQuestion(words, language), ask: yours ? undefined : lastAsk(words, language) });
      // A line neither the words nor the voices learned so far could place goes by who it sounds like lately.
      const who = speaker ?? nearestVoice(earlier, print, voiceSamples(earlier, myVoice.current));
      // A question in the line counts as theirs unless its words or its sound say it is yours; a Deepgram voice number alone
      // does not, since one number can end up covering both people.
      const mine = worded === 'candidate' || (!!sounds && sounds.speaker === 'candidate' && sounds.strength >= 5);
      const prior = liveTurn.current;
      const step = liveSteps(prior, [...(cut ? [heard(cut.yours, 'candidate', cut.read, true)] : []), heard(utterance, who, read, mine), ...(cut?.reply ? [heard(cut.reply, 'candidate', false, true)] : [])]);
      const preview = partialAnswer.current ? livePartial.current : ''; const line = compactText(said); const ahead = liveHeard.current;
      liveTurn.current = step.turn; liveQueue.current = null; clearTimer(liveTimer);
      // The preview already heard past this line (with Deepgram, your words before someone cut in become a line just
      // before theirs), so the line only joins the turn and the preview waits for the rest.
      if (preview && ahead.startsWith(`${line} `)) liveHeard.current = ahead.slice(line.length + 1);
      else {
        livePartial.current = ''; liveHeard.current = '';
        // The answer started from these words while they were still coming already matches the line, so it stays. (One
        // for words that came to nothing stays until the next update replaces it in place.)
        if (step.action !== 'hold' && preview && compactText(step.turn.asked) === compactText(preview)) { partialAnswer.current = false; partialQuestion.current = ''; setQuestion(step.turn.asked); setLowConfidence(uncertain); }
        else if (step.action !== 'hold') runLive({ step, partial: false, uncertain, before: saidBefore(step, prior, cut?.yours) });
        else if (read) setStatus('Holding still while you read');
        else setStatus(value => value === 'Holding still while you read' ? 'Response ready' : value);
      }
      if (step.action !== 'hold') startCoach(step.turn);
      else if (!read && !acknowledges(said) && !closes(said)) { coachWords.current += wordCount(said); requestCoach(); }
    }
    else if (likelyQuestion(utterance, language) && !own) {
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
    else if (partialQuestion.current && (!read || compactText(utterance).includes(draftStart))) { partialAnswer.current = false; partialQuestion.current = ''; abortAnswer(); setAnswer(''); setQuestion(''); setLowConfidence(false); setStatus('No question detected'); }
    // You answering right away, when the recognizer ran it into their question.
    if (cut?.reply) addLine({ text: cut.reply, time: stamp(), at: Date.now(), confidence, speaker: 'candidate', by: 'guess' });
  }, [addLine, generate, runLive, startCoach, requestCoach, abortAnswer, question]);

  const resetConversation = useCallback(() => {
    abortAnswer(); stopReading(); clearTimer(partialTimer); clearTimer(browserFinalTimer); const check = speakerCheck.current; speakerCheck.current = null; check?.abort(); voiceIds.current.clear(); nextVoice.current = 0;
    browserFinal.current = ''; browserConfidence.current = undefined; pendingVoice.current = undefined; lineVoice.current.reset(); interimRef.current = ''; partialAnswer.current = false; partialQuestion.current = ''; lastQuestion.current = null; followTranscript.current = true;
    resetLive(null); rewritten.current = []; reviewRun.current?.abort(); reviewRun.current = null; setCoaching({ state: 'idle' });
    topicsRun.current?.abort(); topicsRun.current = null; clearTimer(topicsTimer); topicsNow.current = noTopics; setTopics(noTopics); setTopicsOpen(false); setTopicsBusy(false); topicsSeen.current = 0; topicsWords.current = 0; topicsDue.current = false; speech.current?.reset?.(); // Listening continues; only words already heard are dropped.
    transcriptRef.current = []; setTranscript([]); setDraft(''); setInterim(''); setQuestion(''); setAnswer(''); setAnswerError(''); setPinned(null); setHistory([]); setEarlierOpen(false); setNewAnswer(false); followFeed.current = true; feedAnchor.current = null; setLowConfidence(false); setError(''); setStatus('Conversation cleared');
  }, [abortAnswer, stopReading, resetLive]);
  // Clearing starts a new session. A saved one keeps what it had: its latest changes are saved first.
  const clear = useCallback(() => {
    if (sessionNow.current.saved) void storeSession(sessionSnapshot.current()).catch(() => undefined);
    resetConversation(); setSession({ id: newSessionId(), name: '', createdAt: Date.now(), saved: false }); setSessionNotice('');
  }, [resetConversation]);

  // Ends the listening session. Words the recognizer has not finalized yet are committed unless `discard` is set.
  const endListening = useCallback((discard: boolean) => {
    activeRef.current = false; setActive(false); setMicReady(false); setVoiceDetected(false);
    speech.current?.stop(); clearTimer(partialTimer); clearTimer(browserFinalTimer);
    const pending = [browserFinal.current, interimRef.current].filter(Boolean).join(' '); const confidence = browserConfidence.current; const voice = pendingVoice.current;
    const print = lineVoice.current.take(true); // The committed words include the unfinished ones, so all of what was heard.
    browserFinal.current = ''; browserConfidence.current = undefined; pendingVoice.current = undefined; interimRef.current = ''; setInterim('');
    if (discard) { clear(); setStatus('Session ended · context cleared'); } else commitSpeech(pending, confidence, voice, print);
    partialAnswer.current = false; partialQuestion.current = ''; livePartial.current = ''; liveHeard.current = ''; liveQueue.current = null; clearTimer(liveTimer);
  }, [clear, commitSpeech]);
  const stop = useCallback(() => { sessionId.current++; endListening(clearOnStop); }, [clearOnStop, endListening]);

  // Speech callbacks outlive the render that started listening; read the latest mode, provider, and settings through this ref.
  const latest = useRef({ generate, commitSpeech, endListening, requestLive, pumpLive, requestCoach, runCoach, runTopics, scheduleTopics }); const coachShown = useRef(false);
  const tag = isFollowUp(question, transcript.length > 1 ? transcript[transcript.length - 2].text : '') ? 'FOLLOW-UP' : questionKind(question);
  useLayoutEffect(() => {
    latest.current = { generate, commitSpeech, endListening, requestLive, pumpLive, requestCoach, runCoach, runTopics, scheduleTopics }; liveOn.current = liveAnswers; topicsOn.current = trackTopics; coachOn.current = liveAnswers && liveCoach; coachShown.current = !!coach; coachNow.current = coach; display.current = { id: entryId, time: entryTime, tag, possible: lowConfidence, question, answer, mode: shownMode, kind: answerKind, complete: !!answer.trim() && !generating && !answerError };
    readable.current = [...(pinned ? [pinned] : []), ...history.slice(-6), { question, answer }]; reading.current = [...rewritten.current, ...readable.current, ...(coach?.key ? [{ question, answer: [coach.key, ...coach.points].join('\n') }] : [])]; // Oldest first. You might read the coach's notes aloud too.
  });

  const start = useCallback(() => {
    if (activeRef.current) return;
    setError(''); setMicNotice(''); stopReading();
    const thisSession = ++sessionId.current; const engine = speechEngine; const lang = language; sessionLanguage.current = lang;
    clearTimer(partialTimer); clearTimer(browserFinalTimer); browserFinal.current = ''; browserConfidence.current = undefined; pendingVoice.current = undefined; lineVoice.current.reset(); interimRef.current = '';
    partialAnswer.current = false; partialQuestion.current = ''; livePartial.current = ''; liveHeard.current = ''; liveQueue.current = null; clearTimer(liveTimer); lastQuestion.current = null; setVoiceDetected(false); setMicReady(false); activeRef.current = true; setActive(true);
    speech.current?.stop(); speech.current = engine === 'deepgram' ? new DeepgramSpeechToTextProvider(deepgramKey, lang, audioDeviceId, keytermsFor(extraTerms)) : new BrowserSpeechToTextProvider(lang, boostVocabulary ? keytermsFor(extraTerms) : []);
    const current = () => sessionId.current === thisSession;
    const showInterim = (text: string) => { interimRef.current = text; setInterim([browserFinal.current, text].filter(Boolean).join(' ')); };
    let draftText = ''; // The question-like words a draft answer is waiting to start from.
    let silent = false; let quietSince = 0; let lastWordsAt = 0; // Whether the voice detector hears silence now, and since when.
    // How each stretch of speech sounds decides lines too: someone who sounds clearly different from the open line ends it
    // with their first words, and the same voice going on after a pause keeps it open. Deepgram numbers voices as well, so
    // with it the sound has to be clearer to overrule those numbers.
    const voices = lineVoice.current; const strict = engine === 'deepgram';
    const samples = () => voiceSamples(transcriptRef.current, myVoice.current);
    const apart = () => voices.seen && voicesDistinct(samples()); // Only then does sounding the same say much.
    let resumed = false; // The open line's speaker went on after a pause, by the sound of it.
    let switchTo = 0; // A stretch of speech that sounds like someone new; their first words end the open line.
    let doubted = false; // The open line's Deepgram voice number went with a voice that sounded like someone else.
    let switchedFrom: number | undefined; // The voice number of a line ended by someone new, whose words may come in under it.
    // How long someone stays quiet before what they said becomes a line: a finished question goes at once, so its answer is
    // not held up; a sentence cut off mid-phrase ("…and before that I") waits longest; anything else waits out a breath. The
    // browser's recognizer cannot tell voices apart, so unless their sound can, it waits less, or the next person's words
    // would join the line.
    const settleTime = (text: string) => endsMidPhrase(text) ? 1800 : likelyQuestion(text, lang) ? 0 : apart() && resumed ? 1800 : engine === 'deepgram' || apart() ? 1200 : 600;
    // Commits the words waiting to become a line (and answers them, if they are a question), with what they sounded like.
    const flushFinal = () => {
      clearTimer(browserFinalTimer); const text = browserFinal.current; if (!text) return;
      const confidence = browserConfidence.current; const voice = doubted ? undefined : pendingVoice.current; const print = voices.take();
      browserFinal.current = ''; browserConfidence.current = undefined; pendingVoice.current = undefined; resumed = false; switchTo = 0; doubted = false;
      clearTimer(partialTimer); draftText = ''; showInterim(interimRef.current); latest.current.commitSpeech(text, confidence, voice, print);
    };
    // A line stays open while its speaker keeps talking (up to 4 s for a question, so talk that follows does not hold up its
    // answer, and 15 s otherwise) and until they have been quiet for settleTime, so a pause mid-sentence does not split it.
    const commitBrowserFinal = () => {
      clearTimer(browserFinalTimer); const text = browserFinal.current; if (!text) return; // Silence and the timer can both call this.
      const now = Date.now(); const continuing = interimRef.current.trim() && now - browserFinalSince.current < (likelyQuestion(text, lang) ? 4000 : 15_000);
      // Quiet by the voice detector, though never longer than since words last arrived (a soft voice can slip past it); if
      // noise keeps it from reporting silence, the words having stopped for a while counts instead.
      const quiet = silent ? Math.min(now - quietSince, now - lastWordsAt + 300) : now - lastWordsAt - 1500;
      if (continuing || quiet < settleTime(text)) scheduleBrowserCommit(); else flushFinal();
    };
    const scheduleBrowserCommit = () => { clearTimer(browserFinalTimer); browserFinalTimer.current = window.setTimeout(commitBrowserFinal, 300); };
    const startDraft = () => { clearTimer(partialTimer); const text = draftText; draftText = ''; if (text && current() && activeRef.current) void latest.current.generate(text, { partial: true }); };
    // The live answer starts on the interviewer's question before their line is final, including when they cut in on you,
    // once the question sounds finished: with Deepgram, when it ends in a question mark; with the browser's recognizer,
    // which adds no punctuation, when they pause on a question that does not trail off. Anything less (and a problem to
    // solve, which runs on) waits for the line, so the answer is written once rather than rewritten while they talk, and
    // never from half a question. Words that may be yours wait too, so reading an answer aloud never changes it early.
    const preview = (words: string, paused = false) => {
      const cut = splitInterruption(words, reading.current, lang); const spoken = cut?.theirs ?? words;
      if (!draftReady(spoken, lang) || readsAnswer(spoken, reading.current, lang)) return;
      const ask = lastAsk(spoken, lang); if (!ask || ask.split(/(?<=[.?!…])\s+/).some(sentence => opensProblem(sentence))) return;
      if (engine === 'deepgram' ? !/[?？]["'”)\]]*$/.test(ask) : !paused || endsMidPhrase(ask) || ask.split(/\s+/).length < 5) return;
      const sounds = cut ? undefined : voiceGuess(samples(), voices.words()); const worded = guessSpeaker(spoken, lang);
      if ((sounds && (!worded || sounds.strength >= 5) ? sounds.speaker : worded) === 'candidate') return;
      const heard = (text: string, speaker: Speaker, read = false, asked?: string): LiveHeard => ({ text, speaker, read, clarifying: isClarifyingQuestion(text), question: likelyQuestion(text, lang), ask: asked });
      const step = liveSteps(liveTurn.current, [...(cut ? [heard(cut.yours, 'candidate', cut.read)] : []), heard(spoken, 'interviewer', false, ask)]);
      // Once per question: the same words heard again start nothing new.
      if (step.action !== 'hold' && compactText(step.turn.asked) !== compactText(livePartial.current) && compactText(step.turn.asked) !== compactText(liveQueue.current?.step.turn.asked ?? '')) latest.current.requestLive({ step, partial: true, words, before: saidBefore(step, liveTurn.current, cut?.yours) });
    };
    if (source === 'claude') ClaudeCodeProvider.warm(claudeModel); // Ready before the first question, however long the page has been open.
    void speech.current.start({
      onListening: listening => { if (!current()) return; if (listening) setMicReady(true); else if (activeRef.current) latest.current.endListening(false); },
      // When the voice stops, commit a finished-sounding final now, or start the draft for a complete-sounding question, rather
      // than waiting out timers (which Chrome slows to once a second while the tab is in the background).
      onVoiceActivity: detected => {
        if (!current()) return; setVoiceDetected(detected); silent = !detected; if (detected) return;
        quietSince = Date.now();
        if (liveOn.current && engine !== 'deepgram' && interimRef.current.trim()) preview([browserFinal.current, interimRef.current].filter(Boolean).join(' '), true);
        if (browserFinal.current) commitBrowserFinal(); else if (draftText && !endsMidPhrase(draftText)) startDraft();
      },
      // Once a new stretch of speech is long enough to tell, compare it with the open line: someone new ends the line with
      // their first words (so a laugh that never becomes words ends nothing), and the same person keeps it open longer.
      onVoiceSegment: segment => {
        if (!current()) return; voices.add(segment);
        if (segment.phase === 'start') { switchTo = 0; return; } // A newer stretch decides for itself.
        if (segment.phase !== 'early' || !browserFinal.current) return;
        const heard = voiceMatch(voices.line(), segment.print, samples(), strict);
        if (heard === 'different') { voices.release(); switchTo = segment.id; } else if (heard === 'same') resumed = true;
      },
      onInterim: text => {
        if (!current()) return;
        if (switchTo && text.trim() && browserFinal.current) { const from = pendingVoice.current; flushFinal(); switchedFrom = from; } // Someone new started talking.
        showInterim(text);
        const pending = browserFinal.current; if (text.trim()) lastWordsAt = Date.now();
        // Still talking after a pause: keep merging into the pending final so the sentence is not split.
        if (pending && text.trim()) scheduleBrowserCommit();
        // A draft answers what someone cut in with, not your words before it, and never your reading of an answer.
        const asked = (words: string) => splitInterruption(words, reading.current, lang)?.theirs ?? words;
        if (liveOn.current) { if (text.trim()) preview([pending, text].filter(Boolean).join(' ')); return; }
        const asking = asked(text);
        // While a browser final is pending, new interim words continue the utterance rather than replace the draft.
        if (!pending && text.trim() && partialQuestion.current && compactText(asking) !== compactText(partialQuestion.current)) {
          partialAnswer.current = false; partialQuestion.current = asking; abortAnswer(); setAnswer(''); setQuestion(asking.trim()); setLowConfidence(true); setStatus('Question changed · updating…');
        }
        clearTimer(partialTimer); draftText = '';
        const spoken = asked([pending, text].filter(Boolean).join(' '));
        if (text.trim() && draftReady(spoken, lang) && likelyQuestion(spoken, lang) && !isClarifyingQuestion(spoken) && !readsAnswer(spoken, reading.current, lang)) { draftText = spoken; partialTimer.current = window.setTimeout(startDraft, 650); }
      },
      onFinal: result => {
        if (!current()) return;
        clearTimer(partialTimer); draftText = ''; lastWordsAt = Date.now();
        const pending = browserFinal.current;
        if (pending) {
          // Words that sound like someone else end the line. With Deepgram, a new voice number ends it too, unless the
          // numbering flipped mid-sentence ("…Vaca like a" "the Japanese term."): the new words neither reply nor cut in,
          // don't sound like someone else, and either finish a phrase left hanging or sound like the same person.
          const renumbered = result.speaker !== pendingVoice.current; // Never with the browser's recognizer.
          const heard = voiceMatch(voices.line(), voices.words(), samples(), strict && !renumbered);
          const flip = renumbered && heard !== 'different' && !startsLikeReply(result.text) && !cutsIn(result.text) && (endsMidPhrase(pending) || (heard === 'same' && apart() && !likelyQuestion(pending, lang)));
          const contradicted = !renumbered && heard === 'different';
          if (contradicted || (renumbered && !flip)) { flushFinal(); doubted = contradicted && engine === 'deepgram'; } // That voice number is not theirs.
          else if (heard === 'same') resumed = true;
        }
        // Recognizers split one sentence into several finals at each pause; they join the same line until it settles.
        if (!browserFinal.current) {
          browserFinalSince.current = Date.now(); pendingVoice.current = result.speaker; resumed = false;
          // Someone new ended the last line, but Deepgram gave their words the same number: that number is not theirs.
          if (switchedFrom !== undefined && result.speaker === switchedFrom) doubted = true;
        }
        switchedFrom = undefined;
        browserFinal.current = [browserFinal.current, result.text].filter(Boolean).join(' ').trim(); browserConfidence.current = result.confidence ?? browserConfidence.current; showInterim('');
        voices.attach();
        // A final that arrives after the next person already started (recognizers lag): their words end the line.
        const hearing = voices.current();
        if (hearing && voiceMatch(voices.line(), hearing.print, samples(), strict) === 'different') { voices.release(); switchTo = hearing.id; }
        if (silent) commitBrowserFinal(); else scheduleBrowserCommit(); // Already quiet: it may be settled now.
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
    addLine({ text: q, time: stamp(), at: Date.now(), speaker: 'interviewer', by: 'typed' }); resetLive({ asked: q, said: [], question: true, ownWords: 0 }); void generate(q);
  }, [addLine, generate, resetLive]);
  const submitManual = useCallback(() => { const q = draft.trim(); if (!q) return; setDraft(''); ask(q); }, [draft, ask]);
  // ↵ on a transcript line answers it as asked: a question the detection missed, or one run together with other words.
  const answerLine = useCallback((text: string) => { resetLive({ asked: text, said: [], question: true, ownWords: 0 }); void latest.current.generate(text); }, [resetLive]);
  const currentPinned = !!pinned && pinned.id === entryId && pinned.answer === answer;
  const canPin = !!answer.trim() && !generating;
  const togglePin = useCallback(() => { if (currentPinned) setPinned(null); else if (canPin) setPinned({ id: entryId, time: entryTime, tag, possible: lowConfidence, question, answer, mode: shownMode, kind: answerKind }); }, [currentPinned, canPin, entryId, entryTime, tag, lowConfidence, question, answer, shownMode, answerKind]);
  const pinEntry = useCallback((entry: Entry) => setPinned(current => current?.id === entry.id ? null : entry), []);
  const showSnapshot = useCallback((item: Snapshot, message: string) => {
    archiveCurrent(); abortAnswer(); stopReading(); partialAnswer.current = false; partialQuestion.current = ''; setEntryId(++entryCounter.current); setEntryTime(stamp());
    setQuestion(item.question); setAnswer(item.answer); setShownMode(item.mode); setAnswerKind(item.kind); setAnswerError(''); setLowConfidence(false); setStatus(message);
  }, [archiveCurrent, abortAnswer, stopReading]);
  // The pinned answer is usually the live one or still under Earlier, so this scrolls to it; one that is not comes back
  // as the current answer.
  const showPinned = useCallback(() => {
    if (!pinned) return;
    const scroll = () => { const card = feed.current?.querySelector<HTMLElement>(`[data-entry="${pinned.id}"]`); if (card) feed.current!.scrollTo({ top: card.offsetTop - 6, behavior: 'smooth' }); return !!card; };
    if (scroll()) return;
    if (history.some(entry => entry.id === pinned.id)) { setEarlierOpen(true); window.requestAnimationFrame(scroll); } else showSnapshot(pinned, 'Pinned answer restored');
  }, [pinned, history, showSnapshot]);
  const copyText = useCallback(async (text: string) => { try { await navigator.clipboard.writeText(text); setStatus('Answer copied'); } catch { setStatus('Clipboard access is blocked. Select and copy the answer instead.'); } }, []);
  // You follow the live answer while its top is in view, or while it still reaches the reading line a third of the way down.
  // Below that you are reading an earlier answer: a new one waits behind a jump button, and what you read stays put.
  const followingLatest = () => {
    const body = feed.current; if (!body) return true;
    const card = body.querySelector<HTMLElement>('[data-current]'); if (!card) return body.scrollTop < 8;
    return body.scrollTop <= card.offsetTop + 8 || card.offsetTop + card.offsetHeight > body.scrollTop + body.clientHeight / 3;
  };
  const readingAnchor = (body: HTMLElement) => {
    const line = body.scrollTop + body.clientHeight / 3; let card: HTMLElement | undefined;
    for (const item of body.querySelectorAll<HTMLElement>('[data-entry]')) { if (item.offsetTop > line) break; card = item; }
    return card?.dataset.entry ? { id: card.dataset.entry, top: card.offsetTop, feedTop: body.getBoundingClientRect().top, pageY: window.scrollY } : null;
  };
  const feedScrolled = () => {
    const body = feed.current; if (!body) return;
    const own = Math.abs(body.scrollTop - feedAdjusted.current) < 1 || Date.now() < feedJump.current; feedAdjusted.current = -1; if (own) return;
    followFeed.current = followingLatest(); feedAnchor.current = followFeed.current ? null : readingAnchor(body);
    if (followFeed.current) setNewAnswer(false);
  };
  // Following scrolls instantly: a background tab may not run the smooth animation.
  const jumpToLatest = useCallback((smooth = true) => {
    const body = feed.current; const card = body?.querySelector<HTMLElement>('[data-current]');
    if (body && card) { body.scrollTo({ top: card.offsetTop - 6, behavior: smooth ? 'smooth' : 'auto' }); if (smooth) feedJump.current = Date.now() + 1000; }
    followFeed.current = true; feedAnchor.current = null; setNewAnswer(false);
  }, []);
  useLayoutEffect(() => { if (!entryId) return; if (followFeed.current) jumpToLatest(false); else setNewAnswer(true); }, [entryId, jumpToLatest]);
  // After every change, the card you are reading goes back to where it was. Otherwise the live answer streaming above it,
  // the last answer moving under Earlier, or the coach and main question resizing would push it away.
  useLayoutEffect(() => {
    const body = feed.current; const anchor = feedAnchor.current; if (!body || !anchor || followFeed.current) return;
    const card = body.querySelector<HTMLElement>(`[data-entry="${anchor.id}"]`);
    if (!card) { feedAnchor.current = null; followFeed.current = followingLatest(); return; }
    // Your own scrolling moves neither the card within the list nor the list. The whole list moving counts only while the
    // page is not scrolled (it is in the narrow layout), since the browser may then make up for it itself.
    const feedTop = body.getBoundingClientRect().top;
    const shift = card.offsetTop - anchor.top + (!window.scrollY && !anchor.pageY ? feedTop - anchor.feedTop : 0);
    if (Math.abs(shift) >= 1) { body.scrollTop += shift; feedAdjusted.current = body.scrollTop; }
    feedAnchor.current = { id: anchor.id, top: card.offsetTop, feedTop, pageY: window.scrollY };
  });
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
  const rework = useCallback((options: GenerateOptions) => void generate(question, { uncertain: lowConfidence, ...options }), [question, generate, lowConfidence]);
  const chooseMode = useCallback((next: Mode) => { setMode(next); if (question) rework({ mode: next }); }, [question, rework]);
  // Quick actions are one-off requests; they do not change the selected mode.
  const shorter = useCallback(() => rework({ mode: 'SHORT' }), [rework]);
  const detailed = useCallback(() => rework({ mode: 'DETAILED' }), [rework]);
  const followUp = useCallback(() => rework({ mode: 'SHORT', followUp: true }), [rework]);
  const regenerate = useCallback(() => rework({ mode: shownMode, followUp: answerKind === 'followup' }), [rework, shownMode, answerKind]);
  // A corrected question is answered in place on its card, and fixes the transcript line it came from, so later answers
  // remember the right words too.
  const saveEdit = useCallback(() => {
    const text = editing?.text.trim(); setEditing(null);
    if (!text || text === question.trim()) return;
    const heard = compactText(question); const lines = transcriptRef.current;
    for (let index = lines.length - 1; index >= 0; index--) {
      if (compactText(lines[index].text) !== heard) continue;
      const next = lines.map((line, at) => at === index ? { ...line, text } : line); transcriptRef.current = next; setTranscript(next); break;
    }
    resetLive({ asked: text, said: liveTurn.current?.said ?? [], question: true, ownWords: liveTurn.current?.ownWords ?? 0 }); void generate(text, { mode: shownMode, followUp: answerKind === 'followup', replace: true });
  }, [editing, question, generate, shownMode, answerKind, resetLive]);
  // Taps and typed questions from the phone mirror do exactly what the matching controls here do.
  useLayoutEffect(() => {
    mirrorCommand.current = command => {
      if (command.type === 'listen') { if (!activeRef.current) start(); }
      else if (command.type === 'stop') { if (activeRef.current) stop(); }
      else if (command.type === 'ask') ask(command.text);
      else if (command.type === 'answer') { const line = transcriptRef.current.find(item => item.id === command.line); if (line) answerLine(line.text); }
      else if (command.type === 'mode') chooseMode(command.mode);
      else if (command.type === 'coach') refreshCoach();
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
    const restored = saved.topics ?? noTopics; topicsNow.current = restored; setTopics(restored); topicsSeen.current = saved.transcript.length;
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
    const behind = [workspace.current]; const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
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
  useEffect(() => () => { sessionId.current++; activeRef.current = false; speech.current?.stop(); clearTimer(partialTimer); clearTimer(browserFinalTimer); clearTimer(liveTimer); clearTimer(coachTimer); coachRun.current?.abort(); clearTimer(topicsTimer); topicsRun.current?.abort(); controller.current?.abort(); if ('speechSynthesis' in window) window.speechSynthesis.cancel(); }, []);

  // Your context changed while the coach is showing (you added the role, notes, or a file): coach the question again with
  // it, once you have stopped typing.
  useEffect(() => {
    const turn = liveTurn.current; if (!turn || !coachOn.current || !coachShown.current) return;
    const timer = window.setTimeout(() => { if (liveTurn.current === turn) latest.current.runCoach(turn); }, 1500);
    return () => window.clearTimeout(timer);
  }, [profile.text]);

  useEffect(() => {
    const lines = transcriptRef.current; const fresh = lines.slice(topicsSeen.current); topicsSeen.current = lines.length;
    for (const line of fresh) { topicsWords.current += wordCount(line.text); if (line.speaker !== 'candidate' && lastAsk(line.text, sessionLanguage.current)) topicsDue.current = true; }
    if (fresh.length) scheduleTopics();
  }, [transcript, scheduleTopics]);
  // Jumps the transcript to where a main question was asked, showing every line.
  const showLine = useCallback((id?: number) => {
    if (!id) return; setTranscriptFilter('all'); followTranscript.current = false;
    window.requestAnimationFrame(() => { const line = transcriptBody.current?.querySelector<HTMLElement>(`[data-line="${id}"]`); if (!line) return; line.scrollIntoView({ block: 'center', behavior: 'smooth' }); line.classList.add('flash'); window.setTimeout(() => line.classList.remove('flash'), 1600); });
  }, []);
  const currentTopic = topics.list.find(topic => topic.id === topics.current); const topicIndex = topics.list.findIndex(topic => topic.id === topics.current) + 1;

  const blocks = parseAnswer(answer);
  const heardMinutes = transcript.length ? Math.max(1, Math.round((transcript[transcript.length - 1].at - transcript[0].at) / 60_000)) : 0;
  const overBudget = useMemo(() => heardCharacters(transcript) > memoryBudget, [transcript]);
  const memoryLabel = !transcript.length || source === 'demo' ? '' : overBudget ? ` · remembers the opening and latest part of the conversation (${heardMinutes} min)` : ` · remembers the conversation (${heardMinutes} min)`;
  const providerLabel = source === 'claude' ? `${claudeModelLabel(claudeModel)} · your Claude subscription` : source === 'openai' ? `${model.trim() || 'No model set'} · ${(() => { try { return new URL(endpoint).host; } catch { return 'invalid endpoint URL'; } })()}` : 'Offline demo answers';
  // The chip beside Answers names the model; its tooltip has the rest.
  const providerName = source === 'claude' ? claudeModelLabel(claudeModel) : source === 'openai' ? model.trim() || 'No model set' : 'Offline demo';
  const providerDetails = `${providerLabel}${profile.used && source !== 'demo' ? ' · using your context' : ''}${memoryLabel}`;
  const mirrorShown = !!mirror?.running && mirror.owner === 'this';
  // The current card is shown once something is asked; before that, the list shows how answers will appear.
  const showCurrent = !!(question || answer || generating || answerError);
  const sessionPlaceholder = role.trim() || 'Practice session';
  // What the coach would need from your context to be specific about you and the role.
  const hasBackground = !!about.trim() || files.some(file => file.status === 'ready' && file.text.trim());
  const coachMissing = !role.trim() && !hasBackground ? 'Add the role and your résumé in Context so the coach can be specific →'
    : !role.trim() ? 'Add the role you are interviewing for in Context for points about the company →'
      : !hasBackground ? 'Add your résumé or notes in Context so the coach can point to your own stories →' : '';
  useLayoutEffect(() => {
    sessionNow.current = session;
    sessionSnapshot.current = () => ({ version: 1, id: session.id, name: session.name.trim() || sessionPlaceholder, createdAt: session.createdAt, updatedAt: Date.now(), transcript: transcriptRef.current, history, topics, current: showCurrent ? { id: entryId, time: entryTime, tag, possible: lowConfidence, question, answer, mode: shownMode, kind: answerKind } : null, pinned });
  });
  // A saved session saves itself a moment after it changes (not on every streamed word), and when the page closes.
  useEffect(() => {
    if (!session.saved) return;
    const timer = window.setTimeout(() => { void storeSession(sessionSnapshot.current()).catch(() => setSessionNotice('This browser would not save the latest changes.')); }, 800);
    return () => window.clearTimeout(timer);
  }, [session, transcript, history, question, answer, shownMode, answerKind, lowConfidence, pinned, entryId, topics]);
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
      total: history.length + (showCurrent ? 1 : 0), live: showCurrent, generating, status, answerError, mode, topic: trackTopics && currentTopic ? { title: currentTopic.title, question: currentTopic.question } : undefined,
      // The coach as it shows here, working or not; the phone has no Context panel to link to.
      coach: liveCoach && liveAnswers && coach ? { key: coach.key, points: coach.points, tip: coach.tip, busy: coach.busy, after: coach.after || undefined, missing: coachMissing.replace(/\s*→$/, '') || undefined } : undefined,
      heard: transcript.slice(-30).map(({ id, time, text, speaker }) => ({ id, time, text, ...(speakers && speaker ? { speaker } : {}) })), interim, provider: providerLabel,
    });
  });
  const link = mirror?.links[Math.min(mirrorLink, mirror.links.length - 1)];
  const shownLines = useMemo(() => speakers && transcriptFilter !== 'all' ? transcript.filter(line => line.speaker === transcriptFilter) : transcript, [speakers, transcriptFilter, transcript]);
  // Worked out while the Review panel is open, so it follows the conversation as it goes on.
  const review = useMemo(() => panel === 'review' ? reviewSession(transcript, language) : null, [panel, transcript, language]);
  const coachReview = useCallback(async () => {
    const model = provider(); if (!review?.questions.length || !model.complete) return;
    reviewRun.current?.abort(); const run = new AbortController(); reviewRun.current = run; setCoaching({ state: 'loading' });
    try {
      const result = parseCoaching(await model.complete(reviewInstructions, coachPrompt(review, role), run.signal));
      if (!run.signal.aborted) setCoaching(result ? { state: 'done', result, questions: review.questions.slice(-15).map(item => item.question) } : { state: 'error', message: 'The coaching came back in a form Roomside could not read. Try again.' });
    } catch (reason: any) { if (!run.signal.aborted) setCoaching({ state: 'error', message: describeProviderError(reason) }); }
    finally { if (reviewRun.current === run) reviewRun.current = null; }
  }, [provider, review, role]);
  const earlier = useMemo(() => history.slice().reverse(), [history]); // Newest first, under the live answer.
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
    <section className="workspace" ref={workspace}>
      <header className="topbar">
        <div className="topbar-left"><div className="brand" aria-hidden="true">r<span>.</span></div>
          <div className="session-picker" ref={picker}><button className="session-title" onClick={() => setSessionMenu(open => !open)} aria-expanded={sessionMenu} aria-haspopup="dialog" title="Name, save, or open sessions"><span>{session.name.trim() || (session.saved ? sessionPlaceholder : 'Interview copilot')}</span><ChevronDown size={15}/></button>{sessionMenu && <SessionMenu name={session.name} placeholder={sessionPlaceholder} saved={session.saved} currentId={session.id} listening={active} sessions={savedSessions} notice={sessionNotice} onRename={name => setSession(current => ({ ...current, name }))} onSave={() => void saveThisSession()} onNew={newSession} onOpen={id => void openSession(id)} onDelete={item => void deleteSaved(item)}/>}</div>
          <span className={'save-state' + (session.saved ? ' saved' : '')} title={session.saved ? 'Saved on this computer; changes save as you go' : 'Nothing is saved unless you choose Save this session'}><i/>{session.saved ? 'Saved' : 'Memory only'}</span></div>
        <div className="top-actions">
          <button className="ghost-button" onClick={() => setPanel('review')} aria-label="Review" title="How you answered each question, and what to work on"><ListChecks size={15}/><span>Review</span></button>
          <button className="ghost-button" onClick={() => setPanel('context')} aria-label="Your context" title="Your role, notes, and résumé"><BookUser size={15}/><span>Context</span></button>
          {mirror && <button className="ghost-button" onClick={() => setPanel('phone')} aria-label={'Phone mirror' + (mirrorShown ? mirror.phones ? ', phone connected' : ', waiting for phone' : '')} title="Phone mirror"><Smartphone size={15}/><span>{mirrorShown ? mirror.phones ? 'Phone connected' : 'Waiting for phone' : 'Phone'}</span>{mirrorShown && <i className={'phone-dot' + (mirror.phones ? ' live' : '')}/>}</button>}
          <button className="icon-button" onClick={() => setPanel('settings')} aria-label="Settings" title="Settings"><Settings2 size={17}/></button>
          <button className="icon-button" onClick={clear} aria-label="Clear conversation" title="Clear transcript and answers"><Trash2 size={17}/></button><span className="top-divider"/>
          {active && <span className={'mic-state' + (micReady ? ' on' : '') + (voiceDetected ? ' voice' : '')}><i/><span>{micReady ? voiceDetected ? 'Voice detected' : 'Listening' : 'Starting…'}</span></span>}
          <button className={'listen-button' + (active ? ' stop' : '')} onClick={() => active ? stop() : start()} title={active ? 'Stop listening (esc)' : `Start listening (${listenKeys.join(isMac ? '' : '+')})`}>{active ? <Square size={12}/> : <Mic size={15}/>}{active ? 'Stop' : 'Start listening'}</button>
        </div>
      </header>
      <div className="content">
        <div className="left-col">
          <div className="col-head"><h2>Transcript</h2>{speakers && <div className="segmented" role="group" aria-label="Show lines from">{(['all', 'interviewer', 'candidate'] as const).map(value => <button key={value} className={transcriptFilter === value ? 'active' : ''} aria-pressed={transcriptFilter === value} onClick={() => setTranscriptFilter(value)}>{value === 'all' ? 'All' : value === 'interviewer' ? 'Interviewer' : 'You'}</button>)}</div>}</div>
          {error && <div className="error" role="alert">{error}</div>}{micNotice && <div className="mic-notice">{micNotice}</div>}
          <div className="transcript-card">
            <div className="transcript-body" ref={transcriptBody} onScroll={event => { const body = event.currentTarget; followTranscript.current = body.scrollHeight - body.scrollTop - body.clientHeight < 32; }}>{transcript.length === 0 && !interim ? <div className="empty-transcript"><span>Your conversation will appear here.</span><small>Start listening once everyone has agreed to the practice session, or type a question below.</small></div> : <><TranscriptLines lines={shownLines} speakers={speakers} filter={transcriptFilter} onFlip={flipSpeaker} onAnswer={answerLine}/>{interim && <div className="transcript-line interim"><time>live</time><p>{interim}<span className="cursor"/></p></div>}</>}</div>
            <div className="manual-input"><input ref={manualInput} value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); submitManual(); } }} placeholder="Type a question…" aria-label="Question"/><button onClick={submitManual} disabled={!draft.trim()} title="Send question" aria-label="Send question"><Send size={15}/></button></div>
          </div>
        </div>
        <div className="right-col">
          <div className="col-head"><h2>Answers</h2><button className="provider-chip" onClick={() => setPanel('settings')} aria-label={`Answers from ${providerDetails}. Change in Settings`} title={providerDetails}>{providerName}</button><div className="segmented" role="group" aria-label="Answer length">{modes.map(item => <button key={item} className={mode === item ? 'active' : ''} aria-pressed={mode === item} onClick={() => chooseMode(item)}>{item.toLowerCase()}</button>)}</div></div>
          {trackTopics && (currentTopic || (active && topicsBusy && !topics.list.length)) && <section className="main-question" aria-label="Main question">
            <div className="main-question-head"><b>Main question</b>{topics.list.length > 1 && <button className="main-question-count" onClick={() => setTopicsOpen(open => !open)} aria-expanded={topicsOpen} title="All the main questions so far">{topicIndex} of {topics.list.length}<ChevronDown size={12}/></button>}
              <button className="live-coach-refresh" onClick={() => runTopics()} disabled={topicsBusy} title="Check the main question again" aria-label="Check the main question again"><RefreshCw size={12}/></button></div>
            {currentTopic ? <><p className="main-question-title">{currentTopic.title}</p>{compactText(currentTopic.question) !== compactText(currentTopic.title) && <p className="main-question-text">{currentTopic.question}</p>}</> : <p className="main-question-text">Working out the main question…</p>}
            {topicsOpen && topics.list.length > 1 && <ol className="main-question-list">{[...topics.list].reverse().map((topic, index) => <li key={topic.id} value={topics.list.length - index} className={topic.id === topics.current ? 'current' : ''}><button onClick={() => showLine(topic.from)} disabled={!topic.from} title={topic.from ? 'Show where it was asked' : topic.question}>{topic.title}</button></li>)}</ol>}
          </section>}
          {liveCoach && liveAnswers && coach && <section className={'live-coach' + (coach.busy ? ' busy' : '')} aria-live="polite" aria-label="Live coach">
            <div className="live-coach-head"><b><i/>Coach</b><span>{coach.busy ? coach.key ? 'Updating…' : 'Reading the question…' : coach.after ? `after “${coach.after}”` : 'for this question'}</span><button className="live-coach-refresh" onClick={refreshCoach} disabled={coach.busy} title="Fresh tips for this question" aria-label="Get fresh coaching tips"><RefreshCw size={12}/></button></div>
            {coach.key ? <><p className="live-coach-key">{coach.key}</p>{coach.points.length > 0 && <ul>{coach.points.map(point => <li key={point}>{point}</li>)}</ul>}{coach.tip && <p className="live-coach-tip">{coach.tip}</p>}</> : <div className="typing" aria-hidden="true"><i/><i/><i/></div>}
            {coachMissing && <button className="live-coach-hint" onClick={() => setPanel('context')}>{coachMissing}</button>}
          </section>}
          {pinned && <div className="pinned-answer"><Pin size={13}/><span>{pinned.question}</span><button onClick={showPinned}>Show</button><button className="unpin" onClick={() => setPinned(null)} aria-label="Unpin answer" title="Unpin answer"><X size={13}/></button></div>}
          <div className="answer-feed" ref={feed} onScroll={feedScrolled}>
            {showCurrent ? <article className="qa-entry current" data-entry={entryId} data-current="">
              <div className="qa-head"><EntryMeta live={liveAnswers && active ? generating ? 'updating' : 'on' : undefined} possible={lowConfidence} time={entryTime} tag={tag} mode={shownMode} kind={answerKind}/><span className="entry-tools"><button className={'icon-button small' + (editing?.id === entryId ? ' pinned' : '')} onClick={() => setEditing(editing?.id === entryId ? null : { id: entryId, text: question })} disabled={!question} title="Edit question" aria-label="Edit question" aria-pressed={editing?.id === entryId}><Pencil size={14}/></button><button className="icon-button small" onClick={readAloud} disabled={!speaking && (!answer.trim() || active)} title={speaking ? 'Stop reading' : active ? 'Stop listening first, so the microphone does not pick up the read-aloud audio' : 'Read aloud'} aria-label={speaking ? 'Stop reading' : 'Read aloud'}>{speaking ? <Square size={12}/> : <Volume2 size={14}/>}</button><button className={'icon-button small' + (currentPinned ? ' pinned' : '')} onClick={togglePin} disabled={!currentPinned && !canPin} title={currentPinned ? 'Unpin answer' : `Pin answer (${mod} P)`} aria-label={currentPinned ? 'Unpin answer' : 'Pin answer'} aria-pressed={currentPinned}><Pin size={14}/></button><button className="icon-button small" onClick={() => void copyText(answer)} disabled={!answer.trim()} title="Copy answer" aria-label="Copy answer"><Copy size={14}/></button></span></div>
              {editing?.id === entryId ? <><textarea className="question-edit" value={editing.text} rows={Math.min(4, Math.ceil(editing.text.length / 70) || 1)} aria-label="Question"
                ref={element => { if (element && document.activeElement !== element) { element.focus(); element.setSelectionRange(element.value.length, element.value.length); } }}
                onChange={event => setEditing({ id: entryId, text: event.target.value })}
                onKeyDown={event => { if (event.nativeEvent.isComposing || event.keyCode === 229) return; if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); saveEdit(); } else if (event.key === 'Escape') { event.preventDefault(); setEditing(null); } }}/>
                <div className="edit-hint">Enter to answer this instead · Esc to cancel</div></>
                : <div className="question-text">{question || 'Waiting for a question…'}</div>}
              <div className="response-content" aria-live="polite" aria-busy={generating}><AnswerContent blocks={blocks}/>{!blocks.length && !answerError && (generating ? <div className="typing" aria-hidden="true"><i/><i/><i/></div> : <p className="muted">Your answer will appear here.</p>)}{answerError && <div className="answer-error" role="alert">{answerError}</div>}</div>
              <div className="qa-foot"><span className={'answer-state' + (generating ? ' busy' : answerError ? ' failed' : '')}><i/><span>{status}</span></span><span className="quick-actions"><button onClick={shorter} disabled={!question} title={`Shorter answer (${mod} 1)`}>Shorter</button><button onClick={detailed} disabled={!question} title={`Explain more (${mod} 2)`}>More detail</button><button onClick={followUp} disabled={!question} title="Prepare for the likely follow-up question">Follow-up</button><button onClick={regenerate} disabled={!question} title="Regenerate" aria-label="Regenerate"><RefreshCw size={13}/></button></span></div>
            </article> : !history.length && <div className="empty-answers"><b>Suggested answers appear here</b><span>{liveAnswers ? 'One live answer keeps up with the conversation as people talk, and earlier ones collect below it.' : 'When a question is heard or typed, an answer streams in.'} The length you pick above applies to every answer.</span></div>}
            {history.length > 0 && <section className="earlier" aria-label="Earlier answers"><button className="earlier-toggle" onClick={() => setEarlierOpen(open => !open)} aria-expanded={earlierOpen}><ChevronDown size={14}/><b>Earlier</b><span className="earlier-count">{history.length}</span>{!earlierOpen && <span className="earlier-preview">{earlier.slice(0, 3).map(entry => entry.question).join(' · ')}</span>}</button>
              {earlierOpen && earlier.map(entry => <PastAnswer key={entry.id} entry={entry} pinned={pinned?.id === entry.id} onPin={pinEntry} onCopy={copyText}/>)}</section>}
            {newAnswer && <button className="jump-latest" onClick={() => jumpToLatest()}>{liveAnswers ? 'Live answer ↑' : 'New answer ↑'}</button>}
          </div>
        </div>
      </div>
    </section>
    {settings && <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setPanel(null); }}><section className="settings-modal" ref={settingsPanel} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="settings-title"><div className="modal-head"><h2 id="settings-title">Settings</h2><button className="icon-button" onClick={() => setPanel(null)} aria-label="Close settings"><X size={18}/></button></div>
      <div className="settings-section-title">Transcription</div><label className="field-label">Speech recognition<select value={speechEngine} onChange={event => setSpeechEngine(event.target.value as 'browser' | 'deepgram')}><option value="browser">Browser built-in</option><option value="deepgram">Deepgram streaming (API key)</option></select></label><label className="field-label">Language<select value={language} onChange={event => setLanguage(event.target.value)}><option value="en-US">English (US)</option><option value="es">Spanish</option><option value="fr">French</option><option value="de">German</option><option value="pt-BR">Portuguese (Brazil)</option><option value="ja">Japanese</option><option value="zh-CN">Chinese (Mandarin)</option></select></label><div className="settings-hint">Changes apply the next time you start listening.</div>
      {speechEngine === 'browser' && <><label className="toggle-row"><span><b>Boost interview vocabulary</b><small>Uses Chrome's on-device speech model (Chrome 140 or newer) to catch terms like LeetCode and Two Sum, plus your extra words. It can be less accurate for everyday speech.</small></span><input type="checkbox" checked={boostVocabulary} onChange={event => setBoostVocabulary(event.target.checked)}/></label>
        {boostVocabulary && <div className="on-device-row"><span className="settings-hint">{onDevice === 'available' ? 'On-device model ready. Boosting applies the next time you start listening.' : onDevice === 'downloadable' ? "Chrome needs to download its on-device speech model once." : onDevice === 'downloading' || onDevice === 'installing' ? 'Downloading the on-device model…' : onDevice === 'unavailable' ? "On-device recognition is not available for this language in this browser. Google Chrome can download it for English (US)." : onDevice === 'unsupported' ? 'This browser cannot boost vocabulary; it needs Chrome 140 or newer.' : "Checking Chrome's on-device model…"}</span>{onDevice === 'downloadable' && <button className="secondary" onClick={() => void downloadOnDevice()}>Download model</button>}</div>}</>}
      {speechEngine === 'deepgram' && <><label className="field-label">Deepgram API key<input type="password" value={deepgramKey} onChange={event => { setDeepgramKey(event.target.value); setKeyFromEnv(false); setSpeechCheckMessage(''); }} placeholder="Held in memory, or set DEEPGRAM_API_KEY in .env" autoComplete="off" spellCheck={false}/></label>{keyFromEnv && <div className="settings-hint">Loaded from DEEPGRAM_API_KEY in your .env file.</div>}<button className="secondary check-button" onClick={() => void checkSpeechProvider()} disabled={checkingSpeech || !deepgramKey.trim()} title="Checks the connection only; the microphone stays off and no audio is sent">{checkingSpeech ? 'Checking…' : 'Test transcription connection'}</button>{speechCheckMessage && <div className={'provider-result ' + (speechCheckMessage.startsWith('Connected') ? 'success' : '')}>{speechCheckMessage}</div>}
        <div className="device-row"><label className="field-label">Microphone<select value={audioDeviceId} onChange={event => setAudioDeviceId(event.target.value)}><option value="">System default</option>{audioInputs.map((device, index) => <option key={device.deviceId || index} value={device.deviceId}>{device.label}</option>)}</select></label><button className="secondary" onClick={() => void detectAudioInputs()}>Detect microphones</button></div>{deviceMessage && <div className="settings-hint">{deviceMessage}</div>}</>}
      {(speechEngine === 'deepgram' || boostVocabulary) && <><label className="field-label">Extra words to recognize<textarea value={extraTerms} onChange={event => setExtraTerms(event.target.value)} placeholder="Company, product, and project names, one per line" rows={2}/></label><div className="settings-hint">Common interview terms such as LeetCode, Two Sum, and Big O are included already.</div></>}
      <div className="settings-section-title">Speakers</div>
      <label className="toggle-row"><span><b>Tell speakers apart</b><small>Labels each line Interviewer or You, so answers know who said what. {source === 'demo' ? 'Guesses from the wording only; with Claude or an OpenAI-compatible provider, a quick background check also reads the conversation.' : `A quick background check by ${source === 'claude' ? 'Claude Haiku (a little of your Claude usage)' : 'your answer provider'} fixes wrong guesses.`}{speechEngine === 'deepgram' ? ' Deepgram also separates voices.' : ''} Click a label to correct it.</small></span><input type="checkbox" checked={speakers} onChange={event => setSpeakers(event.target.checked)}/></label>
      {speakers && <div className="voice-row"><span className="settings-hint">{voiceSetup.state === 'recording' ? 'Read this aloud, as you would in the interview: "I am practicing for an interview today. I enjoy building reliable software and explaining how it works."' : voiceSetup.state === 'done' ? `Learned your voice from ${voiceSetup.seconds} s of speech. Lines that sound like you are labeled You right away.` : voiceSetup.state === 'error' ? voiceSetup.message : active ? 'Stop listening to teach Roomside your voice.' : 'Optional: read a sentence aloud for 8 seconds so your lines are labeled You from the start. Only a few numbers about your voice are kept, in this tab.'}</span>{voiceSetup.state === 'done' && <button className="text-button" onClick={() => { myVoice.current = []; setVoiceSetup({ state: 'idle' }); }}>Forget</button>}<button className="secondary" onClick={() => void teachVoice()} disabled={voiceSetup.state === 'recording' || active}>{voiceSetup.state === 'recording' ? 'Listening…' : voiceSetup.state === 'done' ? 'Learn again' : 'Learn my voice'}</button></div>}
      <div className="settings-section-title">Answers</div><label className="field-label">Answers from<select value={source} onChange={event => { sourceChosen.current = true; setSource(event.target.value as AnswerSource); setProviderCheck(''); }}><option value="claude">Claude, with your Claude subscription</option><option value="openai">OpenAI-compatible endpoint (API key)</option><option value="demo">Offline demo answers</option></select></label>
      <label className="toggle-row"><span><b>Live answer</b><small>Answers each question or problem once it sounds finished, then holds still while you read or talk. Asides and small talk leave it alone.{source === 'claude' ? ' Uses more of your Claude usage than answering questions only.' : source === 'openai' ? ' Sends more requests than answering questions only.' : ''}</small></span><input type="checkbox" checked={liveAnswers} onChange={event => { const on = event.target.checked; setLiveAnswers(on); liveOn.current = on; resetLive(null); clearTimer(partialTimer); }}/></label>
      <label className="toggle-row"><span><b>Main questions</b><small>Keeps track of the main question or case you are working on after the introductions (and a list of them so far), pinned above the answers, with a quick check by {source === 'claude' ? 'Claude' : source === 'openai' ? 'your answer provider' : 'the offline demo'} soon after a new question and otherwise every half minute or so while you talk. Answers and the coach use it, so a sub-question is answered as part of the case.{source === 'claude' ? ' Uses a little of your Claude usage.' : ''}</small></span><input type="checkbox" checked={trackTopics} onChange={event => { const on = event.target.checked; setTrackTopics(on); topicsOn.current = on; if (!on) { topicsRun.current?.abort(); topicsRun.current = null; clearTimer(topicsTimer); setTopicsBusy(false); } else latest.current.scheduleTopics(); }}/></label>
      {liveAnswers && <label className="toggle-row"><span><b>Live coach</b><small>A separate check by {source === 'claude' ? 'Claude' : source === 'openai' ? 'your answer provider' : 'the offline demo'}, pinned above the answers: for each question, the key idea to land, the next points to make, and a tip on how you are coming across, following what you say (at most every 8 seconds).{source === 'claude' ? ' Uses a little more of your Claude usage.' : ''}</small></span><input type="checkbox" checked={liveCoach} onChange={event => { const on = event.target.checked; setLiveCoach(on); coachOn.current = on; if (on && liveTurn.current) startCoach(liveTurn.current); else dropCoach(); }}/></label>}
      {source === 'claude' && <><label className="field-label">Model<select value={claudeModel} onChange={event => { setClaudeModel(event.target.value as ClaudeModel); setProviderCheck(''); }}>{claudeModels.map(item => <option key={item.id} value={item.id}>{item.label} ({item.note})</option>)}</select></label><div className="settings-hint">Runs through Claude Code on this computer, signed in with your Claude account: no API key, and usage counts toward your plan. Works while Roomside runs from <code>npm start</code>.</div></>}
      {source === 'openai' && <><label className="field-label">Chat completions endpoint<input type="url" value={endpoint} onChange={event => { setEndpoint(event.target.value); setProviderCheck(''); }} spellCheck={false}/></label><label className="field-label">Model<input value={model} onChange={event => { setModel(event.target.value); setProviderCheck(''); }} spellCheck={false}/></label><label className="field-label">API key<input type="password" value={apiKey} onChange={event => { setApiKey(event.target.value); setProviderCheck(''); }} placeholder="Held in memory for this session" autoComplete="off" spellCheck={false}/></label><div className="settings-hint">Sent only to the endpoint above. The browser may block cross-origin requests unless the endpoint allows them.</div></>}
      {source !== 'demo' && <><button className="secondary check-button" onClick={() => void checkProvider()} disabled={checkingProvider}>{checkingProvider ? 'Checking…' : 'Test connection'}</button>{providerCheck && <div className={'provider-result ' + (providerCheck.startsWith('Connected') ? 'success' : '')}>{providerCheck}</div>}</>}
      <div className="settings-section-title">Privacy</div>
      <label className="toggle-row"><span><b>Clear transcript when stopping</b><small>Discards the conversation and its context when you stop listening.</small></span><input type="checkbox" checked={clearOnStop} onChange={event => setClearOnStop(event.target.checked)}/></label>
      <p className="settings-note">Nothing is saved unless you choose Save this session in the session menu (the title at the top left); saved sessions stay in this browser until you delete them. The microphone turns on only when you press Start listening. {speechEngine === 'deepgram' ? 'While listening, audio streams to Deepgram for transcription.' : 'Browser speech recognition may process audio through its service provider.'}</p>
      <div className="settings-section-title">Keyboard shortcuts</div>
      <dl className="shortcut-list">{shortcuts.map(([keys, action]) => <Fragment key={action}><dt>{keys.map(key => <kbd key={key}>{key}</kbd>)}</dt><dd>{action}</dd></Fragment>)}</dl>
    </section></div>}
    {panel === 'context' && <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setPanel(null); }}><section className="settings-modal" ref={settingsPanel} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="context-title"><div className="modal-head"><h2 id="context-title">Your context</h2><button className="icon-button" onClick={() => setPanel(null)} aria-label="Close context"><X size={18}/></button></div>
      <p className="context-intro">What your answers should know about you. Claude answers as you, with stories from your real projects; it may fill in believable details of a moment, but never new jobs, titles, or metrics.</p>
      <label className="field-label">Interviewing for<input value={role} onChange={event => setRole(event.target.value)} placeholder="e.g. Software Engineer Intern at Stripe"/></label>
      <label className="field-label">About you<textarea value={about} onChange={event => setAbout(event.target.value)} placeholder="Experience, projects, skills, stories you want to use, and what you do for fun (hobbies, interests), which personal questions draw on…" rows={5}/></label>
      <div className="field-label">Files
        <div className={'drop-zone ' + (dragging ? 'dragging' : '')} onDragOver={event => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={event => { event.preventDefault(); setDragging(false); addFiles(event.dataTransfer.files); }}>
          <Upload size={16}/><span>Drop your résumé, the job description, or notes here</span><label className="secondary file-picker">Choose files<input type="file" multiple accept={acceptedFiles} onChange={event => { if (event.target.files) addFiles(event.target.files); event.target.value = ''; }}/></label><small>PDF, Word (.docx), text, or Markdown · read on this computer, not uploaded</small>
        </div>
        {files.length > 0 && <ul className="file-list">{files.map(file => <li key={file.id}><div className="file-row"><FileText size={14}/><span className="file-name" title={file.name}>{file.name}</span><span className={'file-meta ' + (file.status === 'error' ? 'failed' : '')}>{file.status === 'reading' ? 'Reading…' : file.status === 'error' ? file.error : `${file.text.length.toLocaleString()} characters`}</span>{file.status === 'ready' && <button className="text-button" onClick={() => setPreview(current => current === file.id ? null : file.id)}>{preview === file.id ? 'Hide text' : 'View text'}</button>}<button className="text-button" onClick={() => setFiles(list => list.filter(item => item.id !== file.id))} aria-label={`Remove ${file.name}`} title="Remove"><X size={12}/></button></div>{preview === file.id && <pre className="file-preview">{file.text.length > 6000 ? `${file.text.slice(0, 6000)}…` : file.text}</pre>}</li>)}</ul>}{defaultFiles.length > 0 && <div className="settings-hint">Added automatically when Roomside opens: {defaultFiles.join(', ')}. Set CONTEXT_FILES in .env to use other files.</div>}
      </div>
      <div className="context-meter" aria-hidden="true"><span style={{ width: `${Math.min(100, (profile.used / contextBudget) * 100)}%` }}/></div>
      <div className="settings-hint">{profile.used.toLocaleString()} of {contextBudget.toLocaleString()} characters go with each question, to your answer provider{source === 'claude' ? ' (Claude, through your subscription)' : ''} and nowhere else{profile.truncated.length ? `; shortened to fit: ${profile.truncated.join(', ')}` : ''}.{source === 'demo' ? ' The offline demo answers do not use them.' : ''}</div>
      <label className="toggle-row"><span><b>Keep on this computer</b><small>Saves this text in this browser only (never transcripts or keys). Turn it off to delete the saved copy.</small></span><input type="checkbox" checked={keepContext} onChange={event => setKeepContext(event.target.checked)}/></label>
      {contextNotice && <div className="provider-result">{contextNotice}</div>}
    </section></div>}
    {panel === 'review' && review && <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setPanel(null); }}><ReviewPanel ref={settingsPanel} review={review} coaching={coaching} onCoach={() => void coachReview()} onClose={() => setPanel(null)}
      coachNote={source === 'claude' ? 'One strength and one thing to practice for each question, from Claude (a little of your Claude usage).' : source === 'openai' ? 'One strength and one thing to practice for each question, from your answer provider.' : 'The offline demo gives sample coaching; choose Claude in Settings for real feedback.'}/></div>}
    {panel === 'phone' && <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setPanel(null); }}><section className="settings-modal" ref={settingsPanel} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="phone-title"><div className="modal-head"><h2 id="phone-title">Phone mirror</h2><button className="icon-button" onClick={() => setPanel(null)} aria-label="Close phone mirror"><X size={18}/></button></div>
      <p className="context-intro">See each question and suggested answer on your phone, type questions there, and start or stop listening. Audio still comes only from this computer's microphone, so keep this page open; it can stay in the background.</p>
      {!mirror?.running ? <><button className="primary full" onClick={() => void toggleMirror(true)} disabled={mirrorBusy}>{mirrorBusy ? 'Starting…' : 'Start phone mirror'}</button><div className="settings-hint">Your phone needs to be on the same Wi-Fi network as this computer.</div></>
        : mirror.owner === 'other' ? <div className="phone-other"><span>Another Roomside tab is mirrored to your phone right now.</span><button className="secondary" onClick={() => void mirrorHere()}>Mirror this tab</button></div>
          : link && <><div className="phone-pair"><img className="qr" src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(link.qr)}`} alt="QR code that opens Roomside on your phone" width={168} height={168}/><div className="phone-pair-copy"><b>Scan with your phone's camera</b><code className="phone-url">{link.url}</code><button className="text-button" onClick={() => void copyMirrorLink(link.url)}><Copy size={12}/> Copy link</button><span className={'phone-count ' + (mirror.phones ? 'live' : '')}><i/>{mirror.phones ? `${mirror.phones} phone${mirror.phones === 1 ? '' : 's'} connected` : 'Waiting for your phone…'}</span></div></div>
            {mirror.links.length > 1 && <label className="field-label">Network address<select value={mirrorLink} onChange={event => setMirrorLink(Number(event.target.value))}>{mirror.links.map((item, index) => <option key={item.url} value={index}>{new URL(item.url).hostname}{index === 0 ? ' (most likely)' : ''}</option>)}</select></label>}
            <div className="settings-hint">Phone can't open it? Both devices must be on the same network, and campus or office Wi-Fi often blocks connections between devices; your phone's hotspot works instead. If macOS asks whether "node" may accept incoming connections, choose Allow.</div></>}
      {mirrorMessage && <div className={'provider-result ' + (mirrorMessage === 'Link copied.' ? 'success' : '')}>{mirrorMessage}</div>}
      <p className="settings-note">Anyone with the link on your network can see this session's transcript and answers, and start or stop listening, until you stop mirroring. The link changes every time you start. Your context files are never sent to the phone.</p>
      {mirror?.running && <button className="secondary full phone-stop" onClick={() => void toggleMirror(false)} disabled={mirrorBusy}>Stop phone mirror</button>}
    </section></div>}
  </main>;
}
