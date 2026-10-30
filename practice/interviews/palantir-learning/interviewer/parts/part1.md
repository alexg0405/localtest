## Part 1: pull the hospitals in parallel

Tonight's sync pulls one hospital after another and takes 40 minutes. Change
`pull_all` in `supplysync/sync.py` so it pulls the hospitals at the same time,
with relay.

- Use at most **4 workers**: the network's VPN won't take more than four
  requests at once.
- Each hospital's system takes **one request at a time**. A second request
  while one is in flight fails with `TooManyRequests`.
- The result is the same as before: every hospital's items, in `Pull.stock`.

`tests/test_part1_parallel.py` checks it.
