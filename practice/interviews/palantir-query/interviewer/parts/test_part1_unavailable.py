from fleetops import queries
from fleetops.report import run


def test_every_aircraft_that_isnt_in_service():
    assert run(queries.unavailable_aircraft()) == [
        {"tail": "N403TW", "model": "E175", "base": "PDX", "status": "grounded"},
        {"tail": "N405TW", "model": "E175", "base": "BOI", "status": "heavy check"},
        {"tail": "N513TW", "model": "Q400", "base": "BOI", "status": None},   # not signed off into service yet
        {"tail": "N601TW", "model": "A220", "base": "PDX", "status": None},
    ]
