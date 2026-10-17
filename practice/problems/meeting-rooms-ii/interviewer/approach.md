**Heap:** sort by start time and keep a min-heap of the end times of rooms
in use. For each meeting, if the earliest end is at or before its start, reuse
that room (replace its end time); otherwise add a room. The heap's size at the
end is the answer: O(n log n) time, O(n) space.

**Sweep line:** sort the starts and the ends separately. Walk through the
starts; each start before the next end needs a new room, otherwise one room
frees up. The maximum count is the answer, also O(n log n).

**Pitfalls:** `<` versus `<=` for back-to-back meetings; not sorting; counting
the maximum overlap by checking every pair (O(n²)).
