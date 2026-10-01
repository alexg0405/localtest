import { describe, expect, it } from 'vitest';
import { acknowledges, bounded, justSaid, liveCoachPrompt, liveStep, liveSteps, parseLiveCoach, type LiveHeard, type LiveStep, type LiveTurn } from './live';
import { lastAsk } from './speakers';
import { likelyQuestion } from './text';

// A line as the app hears it: the question in it is found the same way, whoever it was labeled.
const heard = (text: string, speaker?: LiveHeard['speaker'], extra: Partial<LiveHeard> = {}): LiveHeard => ({ text, speaker, read: false, clarifying: false, question: likelyQuestion(text), ask: lastAsk(text), ...extra });
const turn = (asked: string, said: string[] = [], question = true, ownWords = 0): LiveTurn => ({ asked, said, question, ownWords });
// Feeds lines one by one, as they are committed, and keeps what each step did.
function replay(lines: LiveHeard[], start: LiveTurn | null = null) {
  let current = start; const steps: LiveStep[] = [];
  for (const line of lines) { const step = liveStep(current, line); current = step.turn; steps.push(step); }
  return steps;
}

describe('liveStep', () => {
  it('answers each question on its own, growing only while they set it up or trail off', () => {
    const [intro, question, next] = replay([heard('So this role is the Capital One TIP program.', 'interviewer'), heard('Do you know what it is?', 'interviewer'), heard('What does the team work on day to day?', 'interviewer')]);
    expect(intro).toEqual({ action: 'new', turn: turn('So this role is the Capital One TIP program.', [], false) });
    expect(question).toEqual({ action: 'update', turn: turn('So this role is the Capital One TIP program. Do you know what it is?') });
    // Another question is a new turn even before you reply.
    expect(next).toEqual({ action: 'new', turn: turn('What does the team work on day to day?') });
    const [, rest] = replay([heard('Can you walk me through', 'interviewer'), heard('your latest project', 'interviewer')]);
    expect(rest).toEqual({ action: 'update', turn: turn('Can you walk me through your latest project') });
    const [, why] = replay([heard("What's your favorite language?", 'interviewer'), heard('And why?', 'interviewer')]);
    expect(why).toEqual({ action: 'update', turn: turn("What's your favorite language? And why?") });
  });

  it('finds the question in a line that runs on into the answer, whoever it was heard from', () => {
    const line = 'This array is sorted, but it may be ascending or descending. What is the complexity to find the largest value? So compare both ends, O of one.';
    for (const speaker of ['interviewer', 'candidate', undefined] as const) {
      expect(liveStep(turn('Tell me about yourself.', ['I am a junior']), heard(line, speaker))).toEqual({ action: 'new', turn: turn('This array is sorted, but it may be ascending or descending. What is the complexity to find the largest value?') });
    }
  });

  it('keeps a practice session where every line was heard as the interviewer from becoming one long question', () => {
    const steps = replay([
      heard("Hey, I'm your interviewer, Sam. I work here at Acme. Why don't you tell me a little bit about yourself?", 'interviewer'),
      heard('Yeah. Okay. Perfect. Perfect. That works. Thanks.', 'interviewer'),
      heard('This array of size nine is sorted, but it may be ascending or descending. What is the complexity to find the largest value? So access both ends and compare, O of one.', 'interviewer'),
      heard('Now take two files. Compute the sum of all integers in both files. What is the overall complexity? O of m plus n.', 'interviewer'),
      heard('What is the complexity to insert n keys in random order into a binary search tree? So the insertion', 'interviewer'),
      heard('I mean,', 'candidate'),
    ]);
    expect(steps.map(step => step.action)).toEqual(['new', 'hold', 'new', 'new', 'new', 'hold']);
    expect(steps.map(step => step.turn?.asked.split('?')[0].split('. ').pop())).toEqual(["Why don't you tell me a little bit about yourself", "Why don't you tell me a little bit about yourself", 'What is the complexity to find the largest value', 'What is the overall complexity', 'What is the complexity to insert n keys in random order into a binary search tree', 'What is the complexity to insert n keys in random order into a binary search tree']);
  });

  it('stays on the problem through a natural back and forth about it', () => {
    const problem = 'Sure. Alright. So, given a linked list, swap every two adjacent nodes and return its head. You must solve it without modifying the values in the nodes. Okay. So given';
    const steps = replay([
      heard(problem, 'interviewer'),
      heard("I'm actually just trying to solve this problem real quick.", 'candidate'),
      heard('I think this is.', 'interviewer'),
      heard('Yeah. Yeah.', 'candidate'),
      heard('You just', 'interviewer'),
      heard('I go through the list. Save', 'candidate'),
      heard('a right pointer on the left pointer.', 'interviewer'),
      heard("Yeah. Well, I'd swap the pointers. Right? So for each pair, I get one and two. You see what I'm saying, though?", 'candidate'),
      heard('like,', 'interviewer'),
      heard("next to twos next, like, point twos next to ones.", undefined),
      heard("But it's like this. Right? Yeah.", 'interviewer'),
    ]);
    expect(steps.map(step => step.action)).toEqual(['new', 'hold', 'hold', 'hold', 'hold', 'hold', 'hold', 'hold', 'hold', 'hold', 'hold']);
    const last = steps[steps.length - 1].turn!;
    expect(last.asked).toBe(problem); // A problem keeps its constraints.
    expect(last.ownWords).toBe(10 + 6 + 22 + 10); // Your own words, which the live coach follows.
  });

  it('holds still through a case while you read it aloud and ask what it covers, whoever each line was heard from', () => {
    // A practice case interview transcribed with Deepgram, labeled as it ended up: introductions, the case, you reading it
    // aloud and asking what it covers, and their next question.
    const lines: [string, LiveHeard['speaker']][] = [
      ['Hey. My name is Alex.', 'candidate'],
      ["Yeah. I'm a sophomore. No. And, I might be... I only weren't that too late. And, recently, I also worked at Berkeley Berkshire Gray.", 'candidate'],
      ['Mhmm. Okay. Yeah. That that sounds good. So', 'interviewer'],
      ["why don't we go ahead and get started then?", 'interviewer'],
      ["Let's go ahead and do a problem right here. So, the main thing that we're gonna be looking at today is, at this case, study. So why don't you go ahead and just take a second to read the problem, and then we can get started.", 'interviewer'],
      ["Okay. So first thing I see is that there's a case study question talking about how Capital One can integrate virtual private networks.", 'candidate'],
      ['I think for a VPN integration case study. I wanna try to get some clarification, I guess.', 'interviewer'], // Probably you.
      ["So are we talking about connecting Capital One's internal systems, or is this more about like, customers, getting that, like, remote", 'candidate'],
      ["like, the the, like, customers accessing services remotely. And once the scale, we're looking at, like, like, are we gonna have to count for concurrency or data centers, stuff like that?", 'candidate'],
      ["Anyways, yeah, I'm ready. Alright. Sounds good. So next question is a bit more about the", 'interviewer'],
      ['VPN. What would you think is the main problem with the virtual private network?', 'interviewer'],
    ];
    const setup = lines[4][0]; const yours = [5, 6, 7, 8];
    // Your lines after the setup could each have been You, Interviewer, or not labeled yet when they were committed, before
    // the background check relabeled them.
    const labelings = yours.reduce<LiveHeard['speaker'][][]>(all => all.flatMap(labels => (['candidate', 'interviewer', undefined] as const).map(speaker => [...labels, speaker])), [[]]);
    for (const labels of labelings) {
      const steps = replay(lines.map(([text, speaker], index) => heard(text, yours.includes(index) ? labels[yours.indexOf(index)] : speaker)));
      const seen = `your lines labeled ${labels.map(label => label ?? 'nobody').join(', ')}`;
      expect(steps.slice(4).map(step => step.action), seen).toEqual(['new', 'hold', 'hold', 'hold', 'hold', 'hold', 'new']);
      expect(steps.slice(4, 10).map(step => step.turn?.asked), seen).toEqual(Array(6).fill(setup));
      expect(steps[10].turn, seen).toEqual(turn('VPN. What would you think is the main problem with the virtual private network?'));
    }
    // As labeled in the end, your reading and your questions are what you said to the case, which the live coach follows.
    expect(replay(lines.map(([text, speaker]) => heard(text, speaker)))[9].turn!.said).toEqual([lines[5][0], lines[7][0], lines[8][0]]);
  });

  it('holds still while you read an answer, explain in your own words, check something, or ask them', () => {
    const asked = turn('What do you know about Capital One?');
    expect(liveStep(asked, heard('honestly mostly that you are big on cloud', 'candidate'))).toEqual({ action: 'hold', turn: turn(asked.asked, ['honestly mostly that you are big on cloud'], true, 8) });
    // Reading aloud counts as replying, though not as your own words.
    const reading = liveStep(asked, heard('I know you are one of the largest banks', 'candidate', { read: true }));
    expect(reading).toEqual({ action: 'hold', turn: turn(asked.asked, ['I know you are one of the largest banks']) });
    expect(liveStep(reading.turn, heard('Nice. What else do you know?', 'interviewer'))).toEqual({ action: 'new', turn: turn('Nice. What else do you know?') });
    expect(liveStep(asked, heard('does that make sense?', 'candidate'))).toEqual({ action: 'hold', turn: turn(asked.asked, ['does that make sense?'], true, 4) });
    // A clarifying question waits for their reply.
    expect(liveStep(asked, heard('can I assume you mean the tech side', 'candidate', { clarifying: true }))).toEqual({ action: 'hold', turn: asked });
    expect(liveStep(asked, heard('   ', 'candidate'))).toEqual({ action: 'hold', turn: asked });
  });

  it('lets listening noises and fillers pass, from either side', () => {
    const answering = turn('Tell me about yourself.', ['sure so I am a junior studying computer science'], true, 9);
    for (const text of ['Mm-hmm.', 'Right, okay.', 'Oh nice!', 'Okay, so', 'yeah', 'Got it, thanks.', 'Perfect. That works. Thanks.', 'Take your time.', 'I mean,']) expect(liveStep(answering, heard(text, 'interviewer'))).toEqual({ action: 'hold', turn: answering });
    expect(acknowledges('Nice, and what was the hardest part?')).toBe(false);
    expect(acknowledges('Yeah so basically I led the backend')).toBe(false);
  });

  it('takes someone unlabeled for you once the question is asked, and for them while they set it up', () => {
    const asked = turn('What do you know about Capital One?');
    expect(liveStep(asked, heard("it's a big cloud shop from what I've read"))).toEqual({ action: 'hold', turn: turn(asked.asked, ["it's a big cloud shop from what I've read"], true, 9) });
    const setup = turn('So this role is on the payments team.', [], false);
    expect(liveStep(setup, heard('mostly the checkout side of things'))).toEqual({ action: 'update', turn: turn(`${setup.asked} mostly the checkout side of things`, [], false) });
  });

  it('leaves the answer alone when the question it answers is said again', () => {
    const asked = turn('How would you scale remote access for millions of customers?', ['I would start with the load'], true, 6);
    // You reading it back, word for word or nearly, or them repeating it.
    for (const [text, speaker] of [['How would you scale remote access for millions of customers?', 'candidate'], ['So how would you scale remote access for millions of customers?', 'candidate'], ['How would you scale remote access for millions of customers?', 'interviewer']] as const) {
      expect(liveStep(asked, heard(text, speaker))).toEqual({ action: 'hold', turn: asked });
    }
    // A different question that shares some of its words is a new one.
    expect(liveStep(asked, heard('How would you scale it for a billion customers instead?', 'interviewer')).action).toBe('new');
  });

  it('leaves the answer alone for what they say about it once they have asked', () => {
    const asked = turn('How would you design a rate limiter?');
    expect(liveStep(asked, heard('Just a high level sketch is fine for now.', 'interviewer'))).toEqual({ action: 'hold', turn: asked });
    const replied = turn(asked.asked, ['I would start with a token bucket'], true, 7);
    expect(liveStep(replied, heard('Nice, I like that direction a lot.', 'interviewer'))).toEqual({ action: 'hold', turn: replied });
  });

  it('lets the goodbyes at the end pass without asking for more coaching', () => {
    const asked = turn('Do you have any questions for me?', ['what does a typical day look like'], true, 7);
    for (const [text, speaker] of [['Honestly the people. Alright, thanks so much for your time today!', 'interviewer'], ['Thank you, this was great.', 'candidate'], ['Great question.', 'interviewer'], ['Nice talking with you, take care!', 'candidate']] as const) {
      expect(liveStep(asked, heard(text, speaker))).toEqual({ action: 'hold', turn: asked });
    }
    expect(liveStep(asked, heard('yeah it was great honestly, we shipped it on time', 'candidate')).turn!.ownWords).toBe(7 + 10);
    // A question after the thanks still counts.
    expect(liveStep(asked, heard('Thanks for your time. Do you have a minute for one more question about your resume?', 'interviewer')).action).toBe('new');
  });

  it('answers the start of the conversation, whatever it is', () => {
    expect(liveStep(null, heard('hi thanks for having me', 'candidate'))).toEqual({ action: 'new', turn: turn('hi thanks for having me', [], false) });
    expect(liveStep(null, heard('Hey, how are you doing today?'))).toEqual({ action: 'new', turn: turn('Hey, how are you doing today?') });
    expect(liveStep(null, heard('Hi, thanks for joining today.', 'interviewer'))).toEqual({ action: 'new', turn: turn('Hi, thanks for joining today.', [], false) });
    expect(liveStep(null, heard('does that make sense?', 'candidate'))).toEqual({ action: 'hold', turn: null });
  });

  it('keeps what it responds to short, favoring the latest of it', () => {
    const intro = Array.from({ length: 12 }, (_, index) => `Our team number ${index + 1} works on another part of the payments stack.`);
    const steps = replay(intro.map(text => heard(text, 'interviewer')));
    const asked = steps[steps.length - 1].turn!.asked;
    expect(asked.length).toBeLessThanOrEqual(400);
    expect(asked.endsWith('Our team number 12 works on another part of the payments stack.')).toBe(true);
    expect(asked.startsWith('Our team number')).toBe(true); // Whole sentences, from the latest back.
    expect(bounded('x'.repeat(500))).toBe(`…${'x'.repeat(400)}`);
  });
});

describe('liveSteps', () => {
  it('folds your words, their interruption, and your reply into one step', () => {
    const asked = turn('Walk me through your background.');
    expect(liveSteps(asked, [heard('and before that I was at Globex doing', 'candidate', { ask: undefined }), heard('oh so how was that', 'interviewer'), heard('yeah it was great honestly', 'candidate', { ask: undefined })]))
      .toEqual({ action: 'new', turn: turn('oh so how was that', ['yeah it was great honestly'], true, 5) });
    // Reading before they cut in still makes theirs a new turn.
    expect(liveSteps(asked, [heard('I started out on the data team', 'candidate', { read: true }), heard('wait, which team?', 'interviewer')]))
      .toEqual({ action: 'new', turn: turn('wait, which team?') });
    expect(liveSteps(asked, [heard('I started out on the data team', 'candidate', { read: true })])).toEqual({ action: 'hold', turn: turn(asked.asked, ['I started out on the data team']) });
    expect(liveSteps(null, [heard('Mm-hmm.', 'interviewer')])).toEqual({ action: 'hold', turn: null });
  });
});

describe('justSaid', () => {
  it('takes what was just said for Answer now, back to their latest line or question whoever it was taken for', () => {
    const lines = [
      { text: 'Tell me about yourself.', speaker: 'interviewer' as const },
      { text: "Sure, I'm a junior studying computer science.", speaker: 'candidate' as const },
      { text: 'What was the hardest part of your internship at Chewy?', speaker: 'candidate' as const }, // Missed: taken for yours.
      { text: 'Um, so', speaker: 'candidate' as const },
    ];
    expect(justSaid(lines)).toBe('What was the hardest part of your internship at Chewy? Um, so');
    expect(justSaid(lines, ' honestly the on-call ')).toBe('What was the hardest part of your internship at Chewy? Um, so honestly the on-call'); // And the words still coming.
    // Their line, even unlabeled, with the line before it; or with only your own statements lately, the last two lines.
    expect(justSaid([{ text: 'Thanks.', speaker: 'candidate' }, { text: 'So how did you test it', speaker: undefined }])).toBe('Thanks. So how did you test it');
    expect(justSaid(['I led the migration.', 'It took a month.', 'We shipped it in May.'].map(text => ({ text, speaker: 'candidate' as const })))).toBe('It took a month. We shipped it in May.');
    expect(justSaid([])).toBe('');
    expect(justSaid([], 'what about caching')).toBe('what about caching');
    // Not back to a question the live answer already answers: what was said after it.
    const after = [{ text: 'How would you design a URL shortener?', speaker: 'interviewer' as const }, { text: "I'd hash the long URL into a short key.", speaker: 'candidate' as const }, { text: 'I wonder how you would handle collisions at scale.', speaker: 'candidate' as const }];
    expect(justSaid(after, '', 'en-US', 'How would you design a URL shortener?')).toBe("I'd hash the long URL into a short key. I wonder how you would handle collisions at scale.");
    expect(justSaid(after)).toBe("How would you design a URL shortener? I'd hash the long URL into a short key. I wonder how you would handle collisions at scale.");
    // Pressed again after another miss: from the line it answered last time, labeled yours or not.
    expect(justSaid([...after, { text: 'I wonder what you would put in the cache first.', speaker: 'candidate' }], '', 'en-US', "I'd hash the long URL into a short key. I wonder how you would handle collisions at scale."))
      .toBe('I wonder how you would handle collisions at scale. I wonder what you would put in the cache first.');
    // Short like the rest of the live answer: the question it goes back to, then the latest of what you said after it.
    const long = justSaid([{ text: 'How did the migration go?', speaker: 'interviewer' }, ...Array.from({ length: 5 }, (_, index) => ({ text: `Part ${index + 1} of my answer goes on about the ledger, the payments stack, and the team.`, speaker: 'candidate' as const }))]);
    expect(long.length).toBeLessThanOrEqual(400); expect(long.startsWith('How did the migration go? … Part')).toBe(true);
    expect(long.endsWith('Part 5 of my answer goes on about the ledger, the payments stack, and the team.')).toBe(true);
  });
});

describe('liveCoachPrompt and parseLiveCoach', () => {
  it('gives the coach the question, the latest of what you said, and how long you have been at it', () => {
    expect(liveCoachPrompt(turn('Why this role?'), 3)).toBe('The role and company they are interviewing for are not given.\n\nQuestion: Why this role?\n\nWhat the candidate has said so far, in their own words or reading from a suggested answer: nothing yet\n\nCoach this answer now. Name the specific project, job, or detail from their background above that fits; never tell them to research or pick one. The points are things to say, not questions for them to think about.');
    expect(liveCoachPrompt(turn('Why this role?', ['mostly the scale', 'and the people']), 45, 4, ' Software Engineer Intern at Acme ')).toBe('They are interviewing for: Software Engineer Intern at Acme\n\nQuestion: Why this role?\n\nWhat the candidate has said so far, in their own words or reading from a suggested answer: "mostly the scale and the people"\n\nThey have been answering for about 45 seconds, with 4 filler words.\n\nCoach this answer now. Name the specific project, job, or detail from their background above that fits, and connect it to Software Engineer Intern at Acme; never tell them to research or pick one. The points are things to say, not questions for them to think about.');
    expect(liveCoachPrompt(turn('Why this role?'), 25)).toContain('It has been about 25 seconds since the question, and they have not said anything yet.');
    // Words still coming in go along too, so a refresh mid-sentence sees them.
    expect(liveCoachPrompt(turn('Why this role?', ['mostly the scale']), 5, 0, '', undefined, ' and at Chewy I upgraded the ')).toContain('"mostly the scale"\n\nBeing said right now, not yet final, by either of them: "and at Chewy I upgraded the"\n\nCoach this answer now.');
    // Asking for fresh notes shows the coach the ones on screen.
    expect(liveCoachPrompt(turn('Why this role?'), 3, 0, 'Capital One Intern', { key: 'Scale of the data', points: ['Name the pipeline', 'Tie it to banking'], tip: 'Slow down' }))
      .toContain('\n\nThey asked for fresh notes, so these on screen were not enough: KEY: Scale of the data; points: Name the pipeline; Tie it to banking; tip: Slow down. Keep the KEY only if it is still the right idea, but make every point and the tip new: other stories, details, or angles from their background than the ones above, not the same ones reworded.\n\nCoach this answer now.');
    const long = liveCoachPrompt(turn('Why this role?', Array.from({ length: 200 }, (_, index) => `point ${index}`)), 0);
    expect(long).toMatch(/answer: "…\S/); expect(long).toContain('point 199"'); expect(long).not.toContain('point 1 ');
  });

  it("reads the coach's key idea, points, and tip", () => {
    expect(parseLiveCoach('KEY: Relink pointers; a dummy node handles the head\n• Walk through 1→2→3→4\n- Stop when fewer than two remain\n3. Then O(n) time, O(1) space\n• One too many\nTIP: **Slow down** a little'))
      .toEqual({ key: 'Relink pointers; a dummy node handles the head', points: ['Walk through 1→2→3→4', 'Stop when fewer than two remain', 'Then O(n) time, O(1) space'], tip: 'Slow down a little' });
    expect(parseLiveCoach('• Lead with the result\n• Then the how')).toEqual({ key: 'Lead with the result', points: ['Then the how'], tip: '' });
    expect(parseLiveCoach('Sorry, I cannot help with that.')).toBeNull();
    expect(parseLiveCoach('KEY: Lead with the result\nTIP: none yet—take your time')?.tip).toBe('');
    expect(parseLiveCoach('KEY: Lead with the result\nTIP: Nothing to fix')?.tip).toBe('');
    expect(parseLiveCoach('KEY: Lead with the result\nTIP: Nonstop talking; pause')?.tip).toBe('Nonstop talking; pause');
    expect(parseLiveCoach('KEY: Say *how* you learned it\n• Name the docs you used')).toEqual({ key: 'Say how you learned it', points: ['Name the docs you used'], tip: '' });
  });
});
