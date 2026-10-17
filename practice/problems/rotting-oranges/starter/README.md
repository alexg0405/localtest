# 994. Rotting Oranges

Medium · Graph · BFS · Grid · [Official statement on LeetCode](https://leetcode.com/problems/rotting-oranges/)

A grid holds `0` (empty), `1` (fresh orange), and `2` (rotten orange). Every
minute, each fresh orange next to a rotten one (up, down, left, or right)
becomes rotten. Return the number of minutes until no fresh orange is left, or
`-1` if some can never rot. If there are no fresh oranges at the start, the
answer is `0`.

```python
oranges_rotting([[2, 1, 0], [1, 1, 0], [0, 1, 1]])   # 4
oranges_rotting([[2, 0, 1]])                         # -1
```

Write `oranges_rotting(grid)` in `solution.py` (open in the editor).

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
