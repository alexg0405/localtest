## Part 4 (stretch): one bad reading stopped the night

Last night, meter M-1040 sent `ERR` instead of a number. The job stopped
at that reading: accounts after it got no usage, and nobody was charged.

Make one bad reading unable to stop the night, without losing it:

- Every other reading is billed as normal, including the rest of that
  account's day.
- Each bad reading goes in a `bad_readings` table, so the metering team can
  fix it in the morning: one row per bad reading, with its `meter`,
  `account`, `ts`, the `wh` it sent, and the `error` as text.
- Like the rest of the job, it must be safe to re-run.

`tests/test_part4_bad_readings.py` has an example.
