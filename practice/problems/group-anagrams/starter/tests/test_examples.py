from solution import group_anagrams


def normalize(groups):
    return sorted(sorted(group) for group in groups)


def test_example():
    result = group_anagrams(["stop", "pots", "cat", "tops", "act", "dog"])
    assert normalize(result) == normalize([["stop", "pots", "tops"], ["cat", "act"], ["dog"]])
