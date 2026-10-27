# Follow-up from the interviewer

The prices now come from a live feed, one day at a time, and the alert service
has to tell customers as soon as a day's wait is known, not once the history is
complete.

Add a class `PriceWatch` to `pricing/price_alerts.py`:

- `add(price)` records the next day's price (days are numbered 0, 1, 2, … in
  the order they're added) and returns the earlier days that just got cheaper:
  a list of `(day, wait)` pairs for every day whose first strictly lower price
  is this one, oldest day first. Most calls return `[]`.
- A day that never gets cheaper is never returned.
- `add` runs for every price update across millions of items, so each call
  needs to be fast.

```python
watch = PriceWatch()
watch.add(7)   # []
watch.add(9)   # []
watch.add(8)   # [(1, 1)]           day 1 ($9) got cheaper the next day
watch.add(6)   # [(0, 3), (2, 1)]
watch.add(8)   # []
watch.add(5)   # [(3, 2), (4, 1)]
```

Keep `days_until_cheaper` working. This example is now in
`tests/test_followup_example.py`, so **Run tests** checks it too. Talk me
through how your approach changes before you code it.
