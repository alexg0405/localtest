# 236. Lowest Common Ancestor of a Binary Tree

Medium · Tree · DFS · Recursion · [Official statement on LeetCode](https://leetcode.com/problems/lowest-common-ancestor-of-a-binary-tree/)

Given the `root` of a binary tree (not necessarily a search tree) and two
nodes `p` and `q` that are both in it, return their lowest common ancestor: the
deepest node that has both `p` and `q` as descendants. A node counts as a
descendant of itself.

`tree.py` has a `TreeNode` class, `build_tree` (from a level-order list with
`None` for missing children), and `find(root, value)`.

```python
root = build_tree([3, 7, 1, 4, 9, None, 8, None, None, 2, 6])
#          3
#        /   \
#       7     1
#      / \     \
#     4   9     8
#        / \
#       2   6
lowest_common_ancestor(root, find(root, 4), find(root, 6)).val   # 7
lowest_common_ancestor(root, find(root, 2), find(root, 8)).val   # 3
lowest_common_ancestor(root, find(root, 9), find(root, 6)).val   # 9
```

Write `lowest_common_ancestor(root, p, q)` in `solution.py` (open in the editor).

## How this session works

| Minutes | What happens |
|---|---|
| 0–3 | Read the problem and ask clarifying questions. |
| 3–8 | Explain your approach: brute force first, then better, with time and space complexity. |
| 8–28 | Code it in the editor. **Run tests** runs the examples; **Custom input** runs any Python you write. |
| 28–35 | Walk through your code on an example, give the complexity, and answer a follow-up. |

Talk out loud with the mic, or type in the Interviewer chat. In **coach mode**
the interviewer becomes a tutor: ask for a hint any time, and it helps you read
failing tests. In **real mode** it behaves like an interviewer, and hints cost
points.
