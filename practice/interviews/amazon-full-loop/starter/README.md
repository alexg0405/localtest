# Amazon SDE intern full interview (practice)

This simulates one complete 60-minute Amazon final-round interview with every
part candidates report: a deep dive on something from your résumé, Leadership
Principles questions with deep follow-ups, then one coding problem in a plain
shared editor.

Add your résumé above before you start. The interviewer picks a project or role
from it to dig into. Without one, it asks about the project you're proudest of.

## How this round works

| Minutes | What happens |
|---|---|
| 0–2 | Introductions. The interviewer asks you to introduce yourself; press Enter when you're done and the questions start. |
| 2–20 | One project or role from your résumé, in depth: what you built, how it works, why you built it that way, what breaks at scale, and the hardest bug. Then two Leadership Principles questions, each with up to three follow-ups. They change every session. Answer out loud with the mic, or in the chat. If an answer runs long, the interviewer moves on to keep time. |
| 20–24 | Read the coding problem below and ask clarifying questions. Start coding whenever you're ready. |
| 24–50 | Code it and talk through your thinking. The interviewer gives a time check at 10 and 5 minutes left, and adds a follow-up at minute 40, or as soon as your tests pass. |
| 50–60 | Dry-run your code on the example, give the time and space complexity, and ask the interviewer your questions. Press **Done coding** to get here early. |

- **No AI.** Amazon tells candidates not to use generative AI tools during
  interviews unless explicitly permitted, so this round has no coding
  assistant.
- **Write and run your code in the browser editor** (the first tab on the
  right). **Run tests** runs the example tests, and the **Custom input** console
  runs any Python you write against your code. Your runs count as evidence.
  Interviewers still expect you to explain your approach and dry-run the example
  out loud. Grading runs hidden tests, including large inputs, after you submit.
- Use STAR for behavioral answers (Situation, Task, Action, Result), and say
  "I", not "we", for what you did.

## Coding problem: top late carriers

Amazon Logistics hands packages to several delivery carriers. Each delivery
produces a record:

```
(package_id, carrier, promised_day, delivered_day)
```

A package is **late** when it is delivered after its promised day.

Write `top_late_carriers(records, k)` in `deliveries/late_carriers.py` (open in the editor). It returns
the names of the `k` carriers with the most late packages, the most late first.
The operations team uses it to decide which carriers to review each week.

```python
records = [
    ("p1", "FastShip", 3, 4),
    ("p2", "FastShip", 2, 2),
    ("p3", "QuickBox", 5, 7),
    ("p4", "QuickBox", 1, 3),
    ("p5", "Parcelo", 4, 4),
]
top_late_carriers(records, 2)   # ["QuickBox", "FastShip"]
```

Ask the interviewer about anything that isn't specified.
