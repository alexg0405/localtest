# 875. Koko Eating Bananas

Medium · Binary search · Array · [Official statement on LeetCode](https://leetcode.com/problems/koko-eating-bananas/)

Koko has piles of bananas, `piles[i]` in pile `i`, and `h` hours (with
`h >= len(piles)`). Each hour she picks one pile and eats up to `k` bananas from
it; if the pile has fewer than `k`, she finishes it and waits out the rest of
the hour. Return the smallest whole number `k` that lets her finish every pile
within `h` hours.

```python
min_eating_speed([3, 8, 5], 6)    # 3   (1 + 3 + 2 = 6 hours)
min_eating_speed([10, 4], 2)      # 10
```

Write `min_eating_speed(piles, h)` in `solution.py` (open in the editor).

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
