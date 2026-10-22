from deliveries.late_carriers import top_late_carriers


def test_example_from_the_problem():
    records = [
        ("p1", "FastShip", 3, 4),
        ("p2", "FastShip", 2, 2),
        ("p3", "QuickBox", 5, 7),
        ("p4", "QuickBox", 1, 3),
        ("p5", "Parcelo", 4, 4),
    ]
    assert top_late_carriers(records, 2) == ["QuickBox", "FastShip"]
