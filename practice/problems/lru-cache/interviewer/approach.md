**Data structures:** a hash map from key to node, plus a doubly linked list
in recency order (sentinel head and tail nodes keep the edge cases simple).

- `get`: find the node, move it to the front, return its value.
- `put`: update and move, or insert at the front; if over capacity, unlink the
  node at the back and delete its key from the map.

Everything is O(1). In Python, `OrderedDict` with `move_to_end` and
`popitem(last=False)` is the same structure built in, but interviewers often
ask you to build the list yourself.

**Pitfalls:** forgetting that `get` refreshes recency; evicting on an update of
an existing key; forgetting to delete the evicted key from the map.
