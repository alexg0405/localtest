# Interviewer guide: 994. Rotting Oranges

Spoilers: this file has the approach. Keep it out of the candidate's workspace.

## Approach

**Approach:** multi-source BFS. Put *every* rotten orange in the queue at
the start, then process the queue one layer at a time; each layer is one
minute. Count fresh oranges first and decrement as they rot, so you know at the
end whether any were unreachable. That's O(R·C) time and space.

**Pitfalls:** running a separate BFS from each rotten orange (wrong and slow);
counting one extra minute after the last layer; returning -1 instead of 0 when
there were no fresh oranges.

Target: O(R·C) time and space.

## Follow-up questions to ask

- Why does BFS (and not DFS) give the right number of minutes?
- What if some oranges took two minutes to rot?
- How would you return which orange rots last?

## Signals

Green: clarifies constraints first; states brute force and then the optimal
approach with complexity before coding; dry-runs the example; tests edge cases.
Red: codes immediately; silent; can't state the complexity; never tests.
