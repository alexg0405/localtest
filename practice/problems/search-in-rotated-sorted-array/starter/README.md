# 33. Search in Rotated Sorted Array

Medium · Binary search · Array · [Official statement on LeetCode](https://leetcode.com/problems/search-in-rotated-sorted-array/)

`nums` was sorted in increasing order with distinct values, then rotated at
an unknown point (so `[2, 5, 9, 15, 18]` might become `[15, 18, 2, 5, 9]`).
Return the index of `target`, or `-1` if it isn't there, in O(log n) time.

```python
search([15, 18, 2, 5, 9], 5)    # 3
search([15, 18, 2, 5, 9], 4)    # -1
```

Write `search(nums, target)` in `solution.py` (open in the editor).

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
