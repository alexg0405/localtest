import threading


def within(seconds, function):
    """Runs function in a thread and fails if it takes longer than seconds (so a slow solution cannot hang grading)."""
    result, error = [], []

    def run():
        try:
            result.append(function())
        except BaseException as caught:
            error.append(caught)

    thread = threading.Thread(target=run, daemon=True)
    thread.start()
    thread.join(seconds)
    assert not thread.is_alive(), f"took longer than {seconds} seconds"
    if error:
        raise error[0]
    return result[0]

from solution import lowest_common_ancestor
from tree import TreeNode, build_tree, find

TREE = [3, 7, 1, 4, 9, None, 8, None, None, 2, 6]


def lca(values, a, b):
    root = build_tree(values)
    return lowest_common_ancestor(root, find(root, a), find(root, b))


def test_examples():
    assert lca(TREE, 4, 6).val == 7
    assert lca(TREE, 2, 8).val == 3


def test_a_node_can_be_its_own_ancestor():
    assert lca(TREE, 9, 6).val == 9
    assert lca(TREE, 3, 2).val == 3


def test_same_node_twice():
    assert lca(TREE, 4, 4).val == 4


def test_returns_the_node_not_just_the_value():
    root = build_tree(TREE)
    node = find(root, 7)
    assert lowest_common_ancestor(root, find(root, 4), find(root, 2)) is node


def test_works_when_values_repeat_across_the_tree():
    root = TreeNode(5, TreeNode(5, TreeNode(1), TreeNode(2)), TreeNode(5))
    left_child = root.left
    assert lowest_common_ancestor(root, left_child.left, left_child.right) is left_child
    assert lowest_common_ancestor(root, left_child.right, root.right) is root


def test_two_node_tree():
    assert lca([1, 2], 1, 2).val == 1


def test_large_balanced_tree_is_fast():
    values = list(range(1, 2 ** 16))
    root = build_tree(values)
    p, q = find(root, 2 ** 15), find(root, 2 ** 16 - 1)
    assert within(4.0, lambda: lowest_common_ancestor(root, p, q)).val == 1
