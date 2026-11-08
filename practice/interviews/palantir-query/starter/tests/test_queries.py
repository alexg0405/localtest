from fleetops import queries
from fleetops.report import run


def test_the_fleet_at_a_base_by_model_then_tail():
    assert run(queries.fleet_at("BOI")) == [
        {"tail": "N602TW", "model": "A220", "status": "in service"},
        {"tail": "N404TW", "model": "E175", "status": "in service"},
        {"tail": "N405TW", "model": "E175", "status": "heavy check"},
        {"tail": "N512TW", "model": "Q400", "status": "in service"},
        {"tail": "N513TW", "model": "Q400", "status": None},
    ]


def test_an_aircrafts_flights_oldest_first():
    rows = run(queries.flights_for("N402TW"))
    assert [(r["flight"], r["date"]) for r in rows] == [("TW201", "2026-10-12"), ("TW202", "2026-10-12"), ("TW201", "2026-10-13"),
                                                        ("TW202", "2026-10-13"), ("TW201", "2026-10-14")]
    assert rows[3]["departed"] is None and rows[3]["delay"] is None   # cancelled
