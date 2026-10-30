## Part 3: the nightly window

The report has to be ready by 6am. Give `pull_all` a `deadline=None`
parameter: how many seconds to wait for the hospitals.

- Hospitals that aren't finished by the deadline go in `Pull.late`
  (sorted), and none of their items are used.
- Don't send a late hospital any more requests once its time is up: its
  system needs the rest of the night for backups.
- With no deadline, wait for every hospital, as before.

`tests/test_part3_deadline.py` has an example.
