from fleetops import queries
from fleetops.report import run


def test_the_portland_briefing():
    assert run(queries.open_defects("PDX")) == [
        {"defect": "D-101", "tail": "N401TW", "model": "E175", "system": "hydraulics", "status": "deferred", "updated": "2026-10-11T09:30"},
        {"defect": "D-103", "tail": "N402TW", "model": "E175", "system": "avionics", "status": "open", "updated": "2026-10-13T05:50"},
        {"defect": "D-105", "tail": "N511TW", "model": "Q400", "system": "landing gear", "status": "open", "updated": "2026-10-13T14:20"},
        {"defect": "D-111", "tail": "N514TW", "model": "Q400", "system": "fuel", "status": "open", "updated": "2026-10-14T06:30"},
    ]
