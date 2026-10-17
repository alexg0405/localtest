**Approach:** scan every cell. Each unvisited land cell starts a new island:
count it, then flood-fill its whole island (BFS with a queue, iterative DFS
with a stack, or recursive DFS) so its other cells aren't counted again.
That's O(R·C) time and O(R·C) space for the visited marks or the queue.

**Python gotcha:** recursive DFS works in most languages, but Python's default
recursion limit is about 1,000, so one big island crashes it. Use an explicit
queue or stack. Union-find is another valid approach.

**Pitfalls:** counting diagonals as connected; marking cells visited when you
pop them instead of when you push them, which queues cells many times.
