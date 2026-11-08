## Part 1: what can't fly today

Every morning, crew scheduling plans around the aircraft that can't fly. Add
`unavailable_aircraft()` to `fleetops/queries.py`: a Weft query for every
aircraft that **isn't in service**.

- Columns: `tail`, `model`, `base`, `status`.
- Sorted by `tail`.
- It returns `(query, params)`, like the other functions in the file.

`tests/test_part1_unavailable.py` has an example.
