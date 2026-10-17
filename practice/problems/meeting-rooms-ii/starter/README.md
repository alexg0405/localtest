# 253. Meeting Rooms II

Medium · Heap · Sorting · Intervals · [Official statement on LeetCode](https://leetcode.com/problems/meeting-rooms-ii/)

Each meeting is `[start, end]` and uses a room from `start` up to, but not
including, `end`, so a meeting ending at 10 frees its room for one starting at
10. Return the fewest rooms needed to hold every meeting.

```python
min_meeting_rooms([[9, 12], [10, 11], [11, 13], [13, 14]])   # 2
min_meeting_rooms([[1, 5], [5, 8]])                         # 1
```

Write `min_meeting_rooms(meetings)` in `solution.py` (open in the editor).

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
