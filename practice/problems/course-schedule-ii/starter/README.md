# 210. Course Schedule II

Medium · Graph · Topological sort · BFS · [Official statement on LeetCode](https://leetcode.com/problems/course-schedule-ii/)

There are `num_courses` courses labeled `0` to `num_courses - 1`. Each pair
`[a, b]` in `prerequisites` means you must take course `b` before course `a`.
Return an order in which you can take every course, or `[]` if it's impossible.
Any valid order is fine.

```python
find_order(3, [[1, 0], [2, 1]])    # [0, 1, 2]
find_order(2, [[0, 1], [1, 0]])    # []   (each needs the other first)
```

Write `find_order(num_courses, prerequisites)` in `solution.py` (open in the editor).

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
