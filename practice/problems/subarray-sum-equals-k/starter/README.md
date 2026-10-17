# 560. Subarray Sum Equals K

Medium · Prefix sum · Hash map · Array · [Official statement on LeetCode](https://leetcode.com/problems/subarray-sum-equals-k/)

Given a list of integers `nums` (which may include negative numbers) and an
integer `k`, return how many contiguous, non-empty subarrays add up to exactly
`k`.

```python
subarray_sum([2, -1, 1, 2], 2)   # 4   ([2], [2, -1, 1], [-1, 1, 2], [2])
subarray_sum([1, 2, 3], 7)       # 0
```

Write `subarray_sum(nums, k)` in `solution.py` (open in the editor).

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
