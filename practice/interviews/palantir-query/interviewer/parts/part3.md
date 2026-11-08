## Part 3: hours by aircraft model

Finance prices the maintenance contract by flying hours. Add
`hours_by_model(since)`: for each aircraft model in **our fleet**, the flights
that flew on or after the date `since` (like `"2026-10-13"`, compared with each
flight's `date`):

- `model`
- `flights`: how many flew (a cancelled flight has no arrival time, and
  doesn't count).
- `hours`: the hours from departure to arrival, added up, rounded to 1 decimal
  place.

Most hours first. Coastline Connect's aircraft fly some routes under our
flight numbers, but they aren't ours and finance bills them separately: none
of their flights belong in this report.

`tests/test_part3_hours.py` has an example.
