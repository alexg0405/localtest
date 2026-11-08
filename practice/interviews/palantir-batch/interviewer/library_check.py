"""sluice against its docs: run in a workspace, it prints "ok" or fails with what's wrong (verify runs it)."""
import sluice

calls = []
def source():
    calls.append("source")
    return [{"k": "a", "n": n} for n in range(7)]

def seen(record):
    calls.append("map")
    return record

pipeline = sluice.Pipeline(source, batch_size=3).map(seen)
assert calls == [], "building a pipeline runs nothing"
report = pipeline.run()
assert isinstance(report, sluice.RunReport) and calls.count("source") == 1 and calls.count("map") == 7, "run() reads the source and runs the steps"
assert report.read == 7 and report.batches == 3 and len(report.output) == 7, "records are read batch_size at a time"

by_batch = sluice.Pipeline(source, batch_size=3).aggregate(by="k", total=sluice.Sum("n"), count=sluice.Count()).run()
assert by_batch.output == [{"k": "a", "total": 3, "count": 3}, {"k": "a", "total": 12, "count": 3}, {"k": "a", "total": 6, "count": 1}], "aggregates work per batch by default"
by_run = sluice.Pipeline(source, batch_size=3).aggregate(by="k", total=sluice.Sum("n"), scope="run").map(lambda r: {**r, "after": True}).run()
assert by_run.output == [{"k": "a", "total": 21, "after": True}], "scope='run' aggregates the whole run, then goes on through the later steps"

def mutate(record):
    record["n"] = 0
    return record

try:
    sluice.Pipeline([{"n": 1}]).map(mutate, name="mutate").run()
    raise AssertionError("changing a record should fail the run")
except sluice.RunFailed as failed:
    assert failed.step == "mutate" and isinstance(failed.cause, TypeError), "records are read-only"
assert sluice.Pipeline([{"n": 1}]).map(lambda r: r.replace(n=2)).run().output == [{"n": 2}], "replace() gives a new dict"

def parse(record):
    return {"n": int(record["n"])}

rows = [{"n": "1"}, {"n": "x"}, {"n": "3"}]
skipped = sluice.Pipeline(rows).map(parse, on_error="skip").run()
assert skipped.output == [{"n": 1}, {"n": 3}] and skipped.skipped == 1 and skipped.dead_letters == [], "skip drops and counts"
lettered = sluice.Pipeline(rows).map(parse, on_error="dead_letter").run()
letter = lettered.dead_letters[0]
assert len(lettered.dead_letters) == 1 and letter.step == "parse" and dict(letter.record) == {"n": "x"} and isinstance(letter.error, ValueError), "dead_letter keeps the record and its error"
assert lettered.step("parse").records_in == 3 and lettered.step("parse").dead_lettered == 1, "the report counts each step"

store = sluice.Store()
table = store.table("parsed")
try:
    sluice.Pipeline([{"n": "1"}, {"n": "2"}, {"n": "x"}, {"n": "4"}], batch_size=2).map(parse).sink(table).run()
    raise AssertionError("fail should raise RunFailed")
except sluice.RunFailed as failed:
    assert failed.step == "parse" and dict(failed.record) == {"n": "x"} and isinstance(failed.report, sluice.RunReport), "RunFailed has the step, record, and report"
assert table.rows() == [{"n": 1}, {"n": 2}], "batches before a failure stay written; the failing batch writes nothing"

appended = store.table("appended")
twice = sluice.Pipeline([{"id": 1, "v": "a"}]).sink(appended)
twice.run()
twice.run()
assert len(appended) == 2, "append writes every row again on a re-run"
upserted = store.table("upserted")
once = sluice.Pipeline([{"id": 1, "v": "a"}, {"id": 2, "v": "b"}]).sink(upserted, mode="upsert", key="id")
once.run()
once.run()
sluice.Pipeline([{"id": 1, "v": "c"}]).sink(upserted, mode="upsert", key="id").run()
assert upserted.rows() == [{"id": 1, "v": "c"}, {"id": 2, "v": "b"}], "upsert replaces the row with the same key"
sluice.Pipeline([{"id": 3, "v": "d"}]).sink(upserted, mode="replace").run()
assert upserted.rows() == [{"id": 3, "v": "d"}], "replace empties the whole table first"
print("ok")
