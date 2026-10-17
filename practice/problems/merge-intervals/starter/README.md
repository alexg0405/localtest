# 56. Merge Intervals

Medium · Array · Sorting · Intervals · [Official statement on LeetCode](https://leetcode.com/problems/merge-intervals/)

Given a list of intervals `[start, end]` (with `start <= end`), merge every
group of overlapping intervals and return the result sorted by start. Intervals
that only touch at an endpoint, like `[1, 2]` and `[2, 3]`, count as
overlapping.

```python
merge([[6, 8], [1, 3], [2, 4], [9, 10]])   # [[1, 4], [6, 8], [9, 10]]
merge([[1, 5], [5, 7]])                    # [[1, 7]]
```

Write `merge(intervals)` in `solution.py` (open in the editor).

## How this session works

| Minutes | What happens |
|---|---|
| 0–3 | Read the problem and ask clarifying questions. |
| 3–8 | Explain your approach: brute force first, then better, with time and space complexity. |
| 8–28 | Code it in the editor. **Run tests** runs the examples; **Custom input** runs any Python you write. |
| 28–35 | Walk through your code on an example, give the complexity, and answer a follow-up. |

Talk out loud with the mic, or type in the Interviewer chat. In **coach mode**
the interviewer becomes a tutor: ask for a hint any time, and it helps you read
failing tests. In **real mode** it behaves like an interviewer, and hints cost
points.
