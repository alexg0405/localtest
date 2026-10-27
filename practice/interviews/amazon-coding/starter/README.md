# Amazon SDE intern coding round (practice)

This simulates a 45-minute Amazon technical interview that's only coding: one
problem, a follow-up, and the interviewer's questions. No behavioral questions.

## How this round works

| Minutes | What happens |
|---|---|
| 0–8 | Read the problem below and ask clarifying questions. Then, before you code, walk the interviewer through your approach and its time and space complexity. |
| 8–35 | Code it and talk it through. Starting with a slower version is fine: once it works, the interviewer asks for its complexity and whether you can do better. The interviewer gives a time check at 10 and 5 minutes left. |
| 35–45 | Walk through your solution on the example, give the complexity, answer the interviewer's follow-up questions, and ask yours. Press **Done coding** to get here early. |

- **The follow-up.** Once your solution passes the example test and is fast
  enough, the interviewer extends the problem (or at minute 26, if it works
  but is still slow). It shows up in the Follow-up tab.
- **Hints.** If you're stuck, say so or press **Hint**. If you go quiet for a
  few minutes, the interviewer checks in, and gives you a small hint if
  you're still stuck. Each hint lowers your problem-solving score a little, as
  leaning on a real interviewer would, so try first, but don't sit stuck.
- **No AI.** Amazon tells candidates not to use generative AI tools during
  interviews unless explicitly permitted, so this round has no coding
  assistant.
- **Write and run your code in the browser editor** (the first tab on the
  right). **Run tests** runs the example tests, and the **Custom input** console
  runs any Python you write against your code. Your runs count as evidence.
  Interviewers still expect you to explain your approach and dry-run the
  example out loud. Grading runs hidden tests, including large inputs, after
  you submit.

## Coding problem: price-drop alerts

Amazon's price tracker lets a customer watching an item see how long they'd
have waited for a better price. You get the item's price for each day, oldest
first, as whole cents.

Write `days_until_cheaper(prices)` in `pricing/price_alerts.py` (open in the
editor). For each day, it returns how many days later the price was first lower
than that day's price, or 0 if it never was.

```python
days_until_cheaper([7, 9, 8, 6, 8, 5])   # [3, 1, 1, 2, 1, 0]
```

Day 0's price is 7, and the first lower price is 6, on day 3, so day 0 waits 3
days. Day 5 is the last day, so it's 0.

Ask the interviewer about anything that isn't specified.
