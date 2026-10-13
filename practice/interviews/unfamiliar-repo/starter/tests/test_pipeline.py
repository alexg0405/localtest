import json
import shutil
from pathlib import Path

from pipeline.cli import main

EXAMPLES = Path(__file__).resolve().parent.parent / "examples"


def write_feed(folder, text, bom=False, name="feed.csv"):
    data = text.encode("utf-8")
    (folder / name).write_bytes((b"\xef\xbb\xbf" if bom else b"") + data)
    config = folder / "config.json"
    config.write_text(json.dumps({"input": name, "output": "out/catalog.json"}))
    return config


def catalog(folder):
    return json.loads((folder / "out" / "catalog.json").read_text(encoding="utf-8"))


def test_reads_a_plain_csv(tmp_path):
    config = write_feed(tmp_path, "sku,name,price\nA-1,Apple,1.25\n")
    assert main([str(config), "--quiet"]) == 0
    assert catalog(tmp_path) == [{"sku": "A-1", "name": "Apple", "price_cents": 125}]


def test_headers_ignore_case_and_spaces(tmp_path):
    config = write_feed(tmp_path, " SKU , Name ,PRICE\nA-1,Apple,1.25\n")
    assert main([str(config), "--quiet"]) == 0
    assert catalog(tmp_path)[0]["sku"] == "A-1"


def test_last_row_wins_and_output_is_sorted(tmp_path):
    config = write_feed(tmp_path, "sku,name,price\nB-1,Bee,2.00\nA-1,Old,1.00\nA-1,New,1.50\n")
    assert main([str(config), "--quiet"]) == 0
    assert catalog(tmp_path) == [
        {"sku": "A-1", "name": "New", "price_cents": 150},
        {"sku": "B-1", "name": "Bee", "price_cents": 200},
    ]


def test_bad_price_is_skipped_and_reported(tmp_path, capsys):
    config = write_feed(tmp_path, "sku,name,price\nA-1,Apple,1.25\nB-1,Bee,cheap\n")
    assert main([str(config)]) == 0
    assert "line 3" in capsys.readouterr().out


def test_nightly_example_succeeds(tmp_path, capsys):
    folder = tmp_path / "examples"
    shutil.copytree(EXAMPLES, folder, ignore=shutil.ignore_patterns("out"))
    assert main([str(folder / "nightly.json")]) == 0
    items = catalog(folder)
    assert [item["sku"] for item in items] == ["BAG-2", "MUG-1", "TEE-M"]
    assert items[1] == {"sku": "MUG-1", "name": "Café Crème Mug", "price_cents": 1175}
