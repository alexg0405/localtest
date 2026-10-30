## Part 2: flaky and offline hospitals

Two things happen most nights:

- A connection drops partway through (`TransientError`). Trying again
  usually works. Try a hospital **up to 3 times in all**. If it still fails,
  list it in `Pull.missing`.
- A hospital's system is down for maintenance (`HospitalOffline`). Don't
  retry it: list it in `Pull.missing` straight away.

Either way, the other hospitals still make it into the report. `missing` is
sorted.

`tests/test_part2_failures.py` has an example.
