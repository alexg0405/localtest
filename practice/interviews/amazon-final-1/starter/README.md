# Amazon SDE intern final round 1 (practice)

This simulates one 45-minute Amazon final-round interview. Recent intern final
rounds (Summer 2026 and Winter 2027 cycles) follow the same shape: Leadership
Principles questions with deep follow-ups, then one coding problem in a plain
shared editor.

## How this round works

| Minutes | What happens |
|---|---|
| 0–2 | Introductions. The interviewer asks you to introduce yourself. |
| 2–20 | Two Leadership Principles questions, each with three follow-ups. They change every session. Answer out loud with the mic, or in the chat. |
| 20–24 | Read the coding problem below and ask clarifying questions. |
| 24–40 | Code it and talk through your thinking. Partway through, the interviewer adds a follow-up. |
| 40–45 | Dry-run your code on the example, give the time and space complexity, and ask the interviewer your questions. |

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
