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
