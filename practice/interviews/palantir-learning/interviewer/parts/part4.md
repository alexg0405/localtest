## Part 4 (stretch): live progress

The operations team watches a dashboard while the sync runs. Give `pull_all`
an `on_progress=None` parameter: a function to call as
`on_progress(done, total)` each time a hospital finishes, pulled or missing,
**while the sync is still running**, so the dashboard moves.

- `done` counts up from 1. `total` is the number of hospitals.
- Late hospitals don't count.

`tests/test_part4_progress.py` has an example.
