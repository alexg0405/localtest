from fleetops import queries
from fleetops.report import run


def test_hours_by_model_since_the_thirteenth():
    assert run(queries.hours_by_model("2026-10-13")) == [
        {"model": "Q400", "flights": 8, "hours": 8.6},
        {"model": "E175", "flights": 6, "hours": 7.5},
        {"model": "A220", "flights": 3, "hours": 3.6},
    ]
