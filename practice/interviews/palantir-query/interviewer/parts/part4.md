## Part 4 (stretch): the morning defect briefing

At 6am, maintenance control at each base walks through the defects that are
still open. Add `open_defects(base)`: every defect whose **current** status is
`open` or `deferred`, on the aircraft at that base that are **in service**
(grounded aircraft and ones in a check are with the hangar team already).

- A defect's current status is the one on its latest row in the defect log,
  by `at`.
- Columns: `defect`, `tail`, `model`, `system`, `status` (the defect's), and
  `updated` (the `at` of that latest row).
- Oldest `updated` first.

`tests/test_part4_defects.py` has an example.
