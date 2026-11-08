"""Weft against its docs: run in a workspace, it prints "ok" or fails with what's wrong (verify runs it)."""
import weft

tables = {
    "orders": [
        {"order_id": "A-1", "store": "S1", "placed": "2026-03-01T09:00", "total": 120, "status": "paid"},
        {"order_id": "A-2", "store": "S2", "placed": "2026-03-01T10:30", "total": None, "status": "refunded"},
        {"order_id": "A-1", "store": "S1", "placed": "2026-03-02T08:00", "total": 120, "status": "refunded"},
        {"order_id": "A-3", "store": "S9", "placed": "2026-03-02T11:00", "total": 40, "status": "paid"},
    ],
    "stores": [
        {"store": "S1", "city": "Reno", "status": "open"},
        {"store": "S2", "city": "Bend", "status": None},
    ],
}


def fails(query, **params):
    try:
        weft.run(query, tables, params)
    except weft.QueryError:
        return True
    return False


assert fails('from orders sort placed where store == "S1"') and fails("select store from stores"), "clauses come in a fixed order, from first"
assert fails('from stores where status = "open"') and fails("from stores where status == 'open'"), "== compares, and strings are double-quoted"
assert weft.run('from stores where status != "open"', tables) == [], "any comparison with missing is false, != included"
assert [r["store"] for r in weft.run('from stores where status != "open" or status is missing', tables)] == ["S2"], "is missing finds missing values"
assert fails("from stores where status == missing"), "== missing is an error"
counted = weft.run("from orders compute rows = count(*), totals = count(total), average = avg(total)", tables)
assert counted == [{"rows": 4, "totals": 3, "average": 280 / 3}], "count(*) counts rows; count(x) and avg skip missing"
assert fails("from orders group by store compute n = count(*) select status"), "after group by, only keys and computed columns are left"
joined = weft.run("from orders join stores on store", tables)
assert len(joined) == 4 and joined[3]["city"] is None, "join keeps unmatched rows"
assert [r["order_id"] for r in weft.run("from orders join inner stores on store", tables)] == ["A-1", "A-2", "A-1"], "join inner drops them"
assert joined[0]["status"] == "paid" and joined[0]["stores.status"] == "open", "a clashing column comes back prefixed with its table"
latest = weft.run("from orders latest per order_id by placed where status == \"paid\"", tables)
assert [r["order_id"] for r in latest] == ["A-3"], "latest keeps each key's largest row, before where"
assert weft.run("from orders where store == $s select order_id", tables, {"s": 'S1" or store != "'}) == [], "a parameter is a value, never query text"
assert fails("from orders where store == $s") and fails("from orders sort $c", c="store"), "a parameter needs a value, and can't name a column"
assert [r["total"] for r in weft.run("from orders sort total desc", tables)] == [120, 120, 40, None], "missing sorts last, even descending"
assert [r["order_id"] for r in weft.run("from orders sort total desc limit $n", tables, {"n": 2})] == ["A-1", "A-1"], "limit takes a parameter"
assert weft.run('from orders where order_id == "A-3" select h = hours_between("2026-03-01T09:00", placed)', tables) == [{"h": 26.0}], "hours_between"
print("ok")
