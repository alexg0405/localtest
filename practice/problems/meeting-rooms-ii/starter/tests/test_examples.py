from solution import min_meeting_rooms


def test_examples():
    assert min_meeting_rooms([[9, 12], [10, 11], [11, 13], [13, 14]]) == 2
    assert min_meeting_rooms([[1, 5], [5, 8]]) == 1
