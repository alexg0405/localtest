# RedNote second round (practice)

This simulates a 60-minute second-round interview with an engineer from
RedNote's New York office. The round is described as mostly behavioral, with
a chance of coding, so this practice round has both: a deep dive on a project
from your résumé, three behavioral questions with follow-ups, then a light
coding problem in a plain shared editor.

Add your résumé above before you start. The interviewer picks a project or role
from it to dig into. Without one, it asks about the project you're proudest of.

## How this round works

| Minutes | What happens |
|---|---|
| 0–3 | Introductions. The interviewer asks about you and what interests you about RedNote; press Enter when you're done and the questions start. |
| 3–32 | One project or role from your résumé, in depth: what you built, how it works, why you built it that way, and the hardest bug. Then three behavioral questions, each with up to three follow-ups. They change every session. Answer out loud with the mic, or in the chat. If an answer runs long, the interviewer moves on to keep time. |
| 32–35 | Read the coding problem below and ask clarifying questions. Start coding whenever you're ready. |
| 35–52 | Code it and talk through your thinking. The interviewer gives a time check at 10 and 5 minutes left, and adds a follow-up at minute 45, or as soon as your tests pass. |
| 52–60 | Walk through your code on the example, give the time and space complexity, and ask the interviewer your questions. Press **Done coding** to get here early. |

- **No AI.** It's a live interview with an engineer, so there's no coding
  assistant.
- **Write and run your code in the browser editor** (the first tab on the
  right). **Run tests** runs the example tests, and the **Custom input** console
  runs any Python you write against your code. Your runs count as evidence.
  Explain your approach and walk through the example out loud too. Grading runs
  hidden tests, including large inputs, after you submit.
- Use STAR for behavioral answers (Situation, Task, Action, Result), say "I",
  not "we", for what you did, and end with a result you can measure.

## Coding problem: posting streaks

RedNote shows creators how many days in a row they've posted a note. Write
`longest_streak(days)` in `streaks/posting_streaks.py` (open in the editor).

`days` lists the days a creator posted a note, as day numbers: day 0 is the
day they joined. It returns the length of the creator's longest streak: the
most consecutive days with at least one note on each.

```python
longest_streak([5, 1, 2, 9, 3, 2, 10])   # 3: days 1, 2, and 3
```

Ask the interviewer about anything that isn't specified.
