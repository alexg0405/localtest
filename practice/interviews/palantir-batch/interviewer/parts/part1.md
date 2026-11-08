## Part 1: find the meters that went quiet

The utility's field team sends a technician to any meter that's dropping
readings. A healthy meter sends **96 a day**, one every 15 minutes. Write
`meter_gaps` in `meterbill/job.py`, with sluice, so it writes a row to the
`meter_gaps` table for every meter that sent fewer than 96 readings that day:

```python
{"meter": "M-1010", "account": "R-101", "day": "2026-11-02", "readings": 90, "missing": 6}
```

- Meters that sent all 96 get no row.
- Return the run report, and have `run_nightly` run it too, with its report
  under `"meter_gaps"`.

`tests/test_part1_meter_gaps.py` checks it.
