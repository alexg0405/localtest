# 146. LRU Cache

Medium · Design · Hash map · Linked list · [Official statement on LeetCode](https://leetcode.com/problems/lru-cache/)

Design a class `LRUCache` that stores up to `capacity` key-value pairs.

- `get(key)` returns the value for `key`, or `-1` if it isn't there.
- `put(key, value)` inserts or updates the key. If that makes the cache hold
  more than `capacity` keys, it evicts the **least recently used** key first.
- Both `get` and `put` count as using a key, and both should run in O(1) on
  average.

```python
cache = LRUCache(2)
cache.put("a", 1)
cache.put("b", 2)
cache.get("a")       # 1      ("a" is now the most recently used)
cache.put("c", 3)    # evicts "b"
cache.get("b")       # -1
cache.get("c")       # 3
```

Write `LRUCache(capacity).get(key) / .put(key, value)` in `solution.py` (open in the editor).

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
