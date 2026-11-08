## Part 2: who's running late

The station manager at each airport wants to see which aircraft are dragging
its on-time numbers down. Add `delays_by_aircraft(airport, top=3)`: for the
flights **out of** that airport, one row per aircraft:

- `tail`
- `flights`: how many flights it was scheduled to fly out of the airport,
  **cancelled ones included**.
- `avg_delay`: its average delay in minutes over the flights that flew,
  rounded to 1 decimal place.
- `worst`: its longest delay.

Worst average delay first, and only the first `top` aircraft. The airport
comes from a dropdown on the dashboard, so pass it, and `top`, as Weft
parameters: don't paste them into the query text.

`tests/test_part2_delays.py` has an example.
