from fulfillment.robot_moves import min_moves


def test_example_from_the_problem():
    assert min_moves(["D..#", ".#..", "...P"]) == 5
