# Follow-up from the interviewer

The operations dashboard now shows the top carriers live. Records arrive one at
a time, and the dashboard asks for the top carriers after updates.

Add a class to `deliveries/late_carriers.py`:

```python
class LateCarrierTracker:
    def record(self, package_id, carrier, promised_day, delivered_day): ...
    def top(self, k) -> list[str]: ...
```

- `record` adds one delivery record. A later record for the same package
  replaces the earlier one: a correction can make a late package on time, or
  move it to a different carrier.
- `top(k)` returns the same answer `top_late_carriers` would give for all the
  records so far.
- `top` can be called after every record, and there can be hundreds of
  thousands of records, so don't recompute everything from scratch each time.

Talk me through the design before you code it.
