from fleetops import queries
from fleetops.report import run


def test_the_three_worst_aircraft_out_of_portland():
    assert run(queries.delays_by_aircraft("PDX")) == [
        {"tail": "N602TW", "flights": 3, "avg_delay": 55.0, "worst": 60},   # one of the three was cancelled
        {"tail": "N402TW", "flights": 3, "avg_delay": 28.3, "worst": 55},
        {"tail": "N401TW", "flights": 4, "avg_delay": 6.5, "worst": 21},
    ]
