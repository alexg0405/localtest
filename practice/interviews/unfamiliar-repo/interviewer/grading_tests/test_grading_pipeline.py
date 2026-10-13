"""Grading tests for catalog-pipeline. Kept out of the candidate workspace."""
import json
import shutil
from pathlib import Path

import pytest

from pipeline.cli import main
from pipeline.config import load_config

EXAMPLES = Path(__file__).resolve().parent.parent / "examples"
BOM = b"\xef\xbb\xbf"


def setup(folder, text, bom=False, options=None, name="feed.csv"):
    (folder / name).write_bytes((BOM if bom else b"") + text.encode("utf-8"))
    config = {"input": name, "output": "out/catalog.json"}
    if options is not None:
        config["options"] = options
    path = folder / "config.json"
    path.write_text(json.dumps(config), encoding="utf-8")
    return path


def catalog(folder):
    return json.loads((folder / "out" / "catalog.json").read_text(encoding="utf-8"))


def test_nightly_workflow_writes_the_expected_catalog(tmp_path, capsys):
    folder = tmp_path / "examples"
    shutil.copytree(EXAMPLES, folder, ignore=shutil.ignore_patterns("out"))
    assert main([str(folder / "nightly.json")]) == 0
    assert catalog(folder) == [
        {"sku": "BAG-2", "name": "Tote Bag", "price_cents": 999},
        {"sku": "MUG-1", "name": "Café Crème Mug", "price_cents": 1175},
        {"sku": "TEE-M", "name": "Logo Tee (M)", "price_cents": 1800},
    ]
    out = capsys.readouterr().out
    assert "line 6: missing name" in out and "line 7" in out


def test_output_bytes_are_utf8_with_exact_names(tmp_path):
    config = setup(tmp_path, "sku,name,price\nC-1,Crème brûlée torch,30.00\n", bom=True)
    assert main([str(config), "--quiet"]) == 0
    raw = (tmp_path / "out" / "catalog.json").read_bytes()
    assert "Crème brûlée torch".encode("utf-8") in raw
    assert BOM not in raw


def test_bom_and_no_bom_give_the_same_catalog(tmp_path):
    text = "sku,name,price\nA-1,Apple,1.25\n"
    with_bom, without = tmp_path / "bom", tmp_path / "plain"
    with_bom.mkdir()
    without.mkdir()
    assert main([str(setup(with_bom, text, bom=True)), "--quiet"]) == 0
    assert main([str(setup(without, text)), "--quiet"]) == 0
    assert catalog(with_bom) == catalog(without) == [{"sku": "A-1", "name": "Apple", "price_cents": 125}]


def test_bom_with_messy_headers(tmp_path):
    config = setup(tmp_path, " SKU ,Name, Price \nA-1,Apple,1.25\n", bom=True)
    assert main([str(config), "--quiet"]) == 0
    assert catalog(tmp_path)[0]["sku"] == "A-1"


def test_missing_field_reports_the_file_line_number(tmp_path, capsys):
    config = setup(tmp_path, "sku,name,price\nA-1,Apple,1.25\n\nB-1,,2.00\n")
    assert main([str(config)]) == 0
    assert "line 4: missing name" in capsys.readouterr().out


def test_all_rows_invalid_fails_with_exit_code_1(tmp_path, capsys):
    config = setup(tmp_path, "sku,name,price\nA-1,,1.25\n")
    assert main([str(config)]) == 1
    assert "error:" in capsys.readouterr().err
    assert not (tmp_path / "out" / "catalog.json").exists()


def test_missing_input_file_fails_cleanly(tmp_path, capsys):
    path = tmp_path / "config.json"
    path.write_text(json.dumps({"input": "nope.csv", "output": "out/catalog.json"}))
    assert main([str(path)]) == 1
    assert "error:" in capsys.readouterr().err


@pytest.mark.parametrize("price", ["12.345", "-1.00", "NaN", "1e2x"])
def test_invalid_prices_are_skipped(tmp_path, price):
    config = setup(tmp_path, f"sku,name,price\nA-1,Apple,1.25\nB-1,Bee,{price}\n")
    assert main([str(config), "--quiet"]) == 0
    assert [item["sku"] for item in catalog(tmp_path)] == ["A-1"]


# Requirement change (revealed at minute 30)

def test_change_semicolon_feed_with_only_the_delimiter_set(tmp_path):
    config = setup(tmp_path, "sku;name;price\nEU-1;Crêpe Pan;24.90\nEU-2;Moka Pot;31.00\nEU-1;Crêpe Pan;22.00\n", bom=True, options={"delimiter": ";"})
    assert main([str(config), "--quiet"]) == 0
    assert catalog(tmp_path) == [
        {"sku": "EU-1", "name": "Crêpe Pan", "price_cents": 2200},
        {"sku": "EU-2", "name": "Moka Pot", "price_cents": 3100},
    ]


def test_change_partial_options_keep_the_other_defaults(tmp_path):
    path = setup(tmp_path, "sku;name;price\n", options={"delimiter": ";"})
    options = load_config(path)["options"]
    assert options["delimiter"] == ";"
    assert options["dedupe_key"] == "sku"
    assert options["required"] == ["sku", "name", "price"]


def test_change_default_delimiter_is_still_a_comma(tmp_path):
    config = setup(tmp_path, "sku,name,price\nA-1,Apple,1.25\n")
    assert load_config(config)["options"].get("delimiter", ",") == ","
    assert main([str(config), "--quiet"]) == 0
    assert catalog(tmp_path) == [{"sku": "A-1", "name": "Apple", "price_cents": 125}]


def test_change_overriding_one_option_does_not_leak_into_the_next_config(tmp_path):
    first, second = tmp_path / "one", tmp_path / "two"
    first.mkdir()
    second.mkdir()
    load_config(setup(first, "sku;name;price\n", options={"delimiter": ";", "required": ["sku"]}))
    options = load_config(setup(second, "sku,name,price\n"))["options"]
    assert options.get("delimiter", ",") == "," and options["required"] == ["sku", "name", "price"]
