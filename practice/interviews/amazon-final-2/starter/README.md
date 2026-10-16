# Amazon SDE intern final round 2 (practice)

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

## Coding problem: robot moves

A fulfillment-center robot starts at its dock and has to reach a pick station.
The floor is a grid of strings:

- `.` floor
- `#` shelf
- `D` the robot's dock (its start)
- `P` a pick station

Write `min_moves(grid)` in `fulfillment/robot_moves.py` (open in the editor). It returns the fewest
moves the robot needs to reach a pick station. Warehouse planning uses it to
estimate pick times.

```python
grid = [
    "D..#",
    ".#..",
    "...P",
]
min_moves(grid)   # 5
```

Ask the interviewer about anything that isn't specified.
