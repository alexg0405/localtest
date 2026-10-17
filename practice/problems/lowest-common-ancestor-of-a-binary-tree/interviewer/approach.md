**Approach:** a post-order DFS. Each call returns:
- `p` or `q` if the subtree contains one of them (or the node itself is one),
- the LCA if the subtree already contains both,
- `None` otherwise.

The first node whose left and right calls both return something is the lowest
common ancestor. That's O(n) time and O(h) space for the recursion.

**Alternative:** record each node's parent with a BFS, collect p's ancestors in
a set, then walk up from q until you hit one. That's also O(n), and has no
recursion-depth worries.

**Pitfalls:** comparing values instead of nodes; treating the tree as a BST;
very deep trees exceeding Python's recursion limit.
