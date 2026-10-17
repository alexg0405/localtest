# Interviewer guide: 200. Number of Islands

Spoilers: this file has the approach. Keep it out of the candidate's workspace.

## Approach

**Approach:** scan every cell. Each unvisited land cell starts a new island:
count it, then flood-fill its whole island (BFS with a queue, iterative DFS
with a stack, or recursive DFS) so its other cells aren't counted again.
That's O(R·C) time and O(R·C) space for the visited marks or the queue.

**Python gotcha:** recursive DFS works in most languages, but Python's default
recursion limit is about 1,000, so one big island crashes it. Use an explicit
queue or stack. Union-find is another valid approach.

**Pitfalls:** counting diagonals as connected; marking cells visited when you
pop them instead of when you push them, which queues cells many times.

Target: O(R·C) time and space.

## Follow-up questions to ask

- How would union-find solve this, and when would you prefer it?
- What if land were added one cell at a time and you had to report the count after each?
- How would you find the size of the largest island?

## Signals

Green: clarifies constraints first; states brute force and then the optimal
approach with complexity before coding; dry-runs the example; tests edge cases.
Red: codes immediately; silent; can't state the complexity; never tests.
