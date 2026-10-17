# Interviewer guide: 236. Lowest Common Ancestor of a Binary Tree

Spoilers: this file has the approach. Keep it out of the candidate's workspace.

## Approach

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

Target: O(n) time, O(h) space.

## Follow-up questions to ask

- How does it simplify if the tree is a binary search tree?
- What if p or q might not be in the tree at all?
- How would you do it without recursion?

## Signals

Green: clarifies constraints first; states brute force and then the optimal
approach with complexity before coding; dry-runs the example; tests edge cases.
Red: codes immediately; silent; can't state the complexity; never tests.
