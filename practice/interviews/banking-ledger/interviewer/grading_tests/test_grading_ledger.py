"""Grading tests for the ledger. Kept out of the candidate workspace."""
import inspect

import pytest

from ledger.money import InvalidAmount, format_cents, parse_amount
from ledger.processor import LedgerProcessor
from ledger.report import account_statement, daily_totals


def event(event_id, account, kind, amount, timestamp="2026-03-01T12:00:00Z", **extra):
    return {"event_id": event_id, "account_id": account, "type": kind, "amount": amount, "timestamp": timestamp, **extra}


def funded(cents=10000, **kwargs):
    return LedgerProcessor(opening_balances={"a1": cents}, **kwargs)


# Money

@pytest.mark.parametrize("text, cents", [
    ("0.01", 1), ("0.29", 29), ("4.35", 435), ("19.99", 1999), ("10", 1000), ("10.5", 1050),
    ("1000000.99", 100000099), ("90071992547409.93", 9007199254740993),
])
def test_parse_amount_exact_values(text, cents):
    assert parse_amount(text) == cents


@pytest.mark.parametrize("text", ["1.005", "1e3", "abc", "", "1,000.00", "-5.00", " 5.00", "5.", "nan", "inf", "+5"])
def test_parse_amount_rejects_malformed_strings(text):
    with pytest.raises(InvalidAmount):
        parse_amount(text)


@pytest.mark.parametrize("cents, text", [(0, "$0.00"), (5, "$0.05"), (-5, "-$0.05"), (-12345, "-$123.45"), (123456, "$1234.56")])
def test_format_cents(cents, text):
    assert format_cents(cents) == text


# Validation

@pytest.mark.parametrize("bad", [
    {"amount": 19.99},
    {"amount": "0.00"},
    {"type": "refund"},
    {"type": "CREDIT"},
    {"currency": "EUR"},
    {"timestamp": "2026-03-01T12:00:00"},
    {"timestamp": "yesterday"},
])
def test_invalid_events_are_rejected_and_change_nothing(bad):
    raw = event("e1", "a1", "credit", "5.00")
    raw.update(bad)
    result = funded().process([raw])
    assert result.balances == {"a1": 10000}
    assert result.applied == []
    assert [r.event_id for r in result.rejected] == ["e1"]


def test_missing_field_is_rejected_with_the_event_id():
    raw = event("e1", "a1", "credit", "5.00")
    del raw["account_id"]
    result = funded().process([raw])
    assert [r.event_id for r in result.rejected] == ["e1"] and result.applied == []


def test_currency_is_optional_and_usd_is_accepted():
    result = funded().process([event("e1", "a1", "credit", "5.00"), event("e2", "a1", "credit", "1.00", currency="USD")])
    assert result.balances == {"a1": 10600}


# Duplicates

def test_duplicates_within_a_batch_are_listed_and_skipped():
    deposit = event("e1", "a1", "credit", "1.00")
    result = funded().process([deposit, dict(deposit), dict(deposit)])
    assert result.balances == {"a1": 10100}
    assert result.duplicates == ["e1", "e1"]
    assert len(result.applied) == 1


def test_duplicates_in_a_later_batch_are_skipped():
    processor = funded()
    processor.process([event("e1", "a1", "debit", "10.00")])
    result = processor.process([event("e1", "a1", "debit", "10.00"), event("e2", "a1", "debit", "1.00")])
    assert result.balances == {"a1": 8900}
    assert result.duplicates == ["e1"]


# Funds

def test_debit_of_the_exact_balance_is_allowed():
    result = funded(2500).process([event("e1", "a1", "debit", "25.00")])
    assert result.balances == {"a1": 0} and result.rejected == []


def test_rejected_debit_leaves_the_balance_unchanged():
    result = funded(1000).process([event("e1", "a1", "debit", "200.00"), event("e2", "a1", "debit", "3.00")])
    assert result.balances == {"a1": 700}
    assert [(r.event_id, "insufficient funds" in r.reason) for r in result.rejected] == [("e1", True)]


# Reports

def test_daily_totals_use_the_utc_day():
    result = LedgerProcessor().process([
        event("e1", "a1", "credit", "10.00", "2026-03-01T23:30:00-05:00"),
        event("e2", "a1", "credit", "1.00", "2026-03-02T00:30:00+02:00"),
    ])
    assert daily_totals(result) == {
        "2026-03-01": {"credits": 100, "debits": 0, "count": 1},
        "2026-03-02": {"credits": 1000, "debits": 0, "count": 1},
    }


def test_daily_totals_leave_out_rejected_and_duplicate_events():
    deposit = event("e1", "a1", "credit", "10.00")
    result = LedgerProcessor().process([deposit, dict(deposit), event("e2", "a1", "credit", "1.00", currency="EUR"), event("e3", "a1", "debit", "500.00")])
    assert daily_totals(result) == {"2026-03-01": {"credits": 1000, "debits": 0, "count": 1}}


def test_statement_lines_have_signed_amounts_and_running_balances():
    processor = LedgerProcessor(opening_balances={"a1": 1000, "a2": 0})
    result = processor.process([
        event("e1", "a1", "credit", "5.00", "2026-03-01T10:00:00Z"),
        event("e2", "a2", "credit", "7.00", "2026-03-01T11:00:00Z"),
        event("e3", "a1", "debit", "2.50", "2026-03-02T04:00:00+05:00"),
    ])
    statement = account_statement(result, "a1")
    assert statement == {
        "account_id": "a1",
        "opening_cents": 1000,
        "closing_cents": 1250,
        "lines": [
            {"event_id": "e1", "date": "2026-03-01", "amount_cents": 500, "balance_cents": 1500},
            {"event_id": "e3", "date": "2026-03-01", "amount_cents": -250, "balance_cents": 1250},
        ],
    }


def test_statement_skips_rejected_events_and_matches_the_balance():
    result = funded(1000).process([event("e1", "a1", "debit", "500.00"), event("e2", "a1", "debit", "1.00")])
    statement = account_statement(result, "a1")
    assert [line["event_id"] for line in statement["lines"]] == ["e2"]
    assert statement["closing_cents"] == result.balances["a1"] == 900


def test_statement_for_an_account_with_no_activity():
    statement = account_statement(LedgerProcessor().process([]), "nobody")
    assert statement == {"account_id": "nobody", "opening_cents": 0, "closing_cents": 0, "lines": []}


# Requirement change (revealed at minute 30)

def overdraft_supported():
    assert "overdraft_limit_cents" in inspect.signature(LedgerProcessor).parameters, "LedgerProcessor has no overdraft_limit_cents parameter"


def test_change_overdraft_down_to_fifty_dollars_is_allowed():
    overdraft_supported()
    result = LedgerProcessor(opening_balances={"a1": 0}).process([event("e1", "a1", "debit", "50.00")])
    assert result.balances == {"a1": -5000} and result.rejected == []


def test_change_debit_past_the_overdraft_limit_is_rejected():
    overdraft_supported()
    result = LedgerProcessor(opening_balances={"a1": 1000}).process([event("e1", "a1", "debit", "60.01"), event("e2", "a1", "debit", "60.00")])
    assert [r.event_id for r in result.rejected] == ["e1"]
    assert "insufficient funds" in result.rejected[0].reason
    assert result.balances == {"a1": -5000}


def test_change_overdraft_limit_is_configurable():
    overdraft_supported()
    result = LedgerProcessor(opening_balances={"a1": 1000}, overdraft_limit_cents=0).process([event("e1", "a1", "debit", "10.01")])
    assert result.balances == {"a1": 1000} and len(result.rejected) == 1


def test_change_statement_shows_negative_balances():
    overdraft_supported()
    result = LedgerProcessor().process([event("e1", "a1", "debit", "12.34")])
    assert account_statement(result, "a1")["closing_cents"] == -1234
    assert format_cents(result.balances["a1"]) == "-$12.34"
