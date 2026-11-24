# Follow-up from the interviewer

RedNote is adding streak freezes. A creator can spend a freeze to cover a day
they didn't post, so their streak keeps going.

Add a function to `streaks/posting_streaks.py`:

```python
def longest_streak_with_freezes(days, freezes) -> int: ...
```

- `freezes` is how many days without a note the creator can cover, 0 or more.
- A streak starts and ends on a day with a note. Every day in between has a
  note, or is covered by a freeze.
- It returns the length of the longest streak, frozen days included.

```python
longest_streak_with_freezes([1, 2, 4, 5, 6, 9], 1)   # 6: days 1 to 6, with day 3 frozen
```

A creator can have a few hundred thousand notes, so don't try every pair of
days. Talk me through the design before you code it.
