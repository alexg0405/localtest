from solution import lowest_common_ancestor
from tree import build_tree, find


def test_examples():
    root = build_tree([3, 7, 1, 4, 9, None, 8, None, None, 2, 6])
    assert lowest_common_ancestor(root, find(root, 4), find(root, 6)).val == 7
    assert lowest_common_ancestor(root, find(root, 2), find(root, 8)).val == 3
    assert lowest_common_ancestor(root, find(root, 9), find(root, 6)).val == 9
