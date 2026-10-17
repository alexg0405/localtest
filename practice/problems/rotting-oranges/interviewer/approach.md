**Approach:** multi-source BFS. Put *every* rotten orange in the queue at
the start, then process the queue one layer at a time; each layer is one
minute. Count fresh oranges first and decrement as they rot, so you know at the
end whether any were unreachable. That's O(R·C) time and space.

**Pitfalls:** running a separate BFS from each rotten orange (wrong and slow);
counting one extra minute after the last layer; returning -1 instead of 0 when
there were no fresh oranges.
