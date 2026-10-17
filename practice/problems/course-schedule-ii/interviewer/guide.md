# Interviewer guide: 210. Course Schedule II

Spoilers: this file has the approach. Keep it out of the candidate's workspace.

## Approach

**Approach:** topological sort of the graph with an edge from each
prerequisite to the course that needs it.

- **Kahn's algorithm (BFS):** start from courses with in-degree 0, take them
  one at a time, and decrement their neighbors' in-degrees. If you can't take
  every course, there's a cycle.
- **DFS with three colors** (unvisited, visiting, done) also works: a back edge
  to a "visiting" node means a cycle, and reverse post-order is the answer. In
  Python, prefer an iterative DFS for deep graphs.

Both are O(V + E) time and space.

**Pitfalls:** reversing the edge direction; forgetting courses with no
prerequisites at all; recursion depth on long chains.

Target: O(V + E) time and space.

## Follow-up questions to ask

- How would you detect the cycle and report which courses are in it?
- What if you could take up to two courses per semester and wanted the fewest semesters?
- When would you choose DFS over Kahn's algorithm?

## Signals

Green: clarifies constraints first; states brute force and then the optimal
approach with complexity before coding; dry-runs the example; tests edge cases.
Red: codes immediately; silent; can't state the complexity; never tests.
