import pytest

from ledger.money import parse_amount
from ledger.processor import LedgerProcessor
from ledger.report import account_statement, daily_totals


def event(event_id, account, kind, amount, timestamp="2026-03-01T12:00:00Z", **extra):
    return {"event_id": event_id, "account_id": account, "type": kind, "amount": amount, "timestamp": timestamp, **extra}


def test_parse_amount_whole_dollars_and_cents():
    assert parse_amount("12.34") == 1234
    assert parse_amount("7") == 700


@pytest.mark.parametrize("text, cents", [("19.99", 1999), ("0.29", 29)])
def test_parse_amount_is_exact(text, cents):
    assert parse_amount(text) == cents


def test_credits_and_debits_update_the_balance():
    result = LedgerProcessor().process([event("e1", "a1", "credit", "100.00"), event("e2", "a1", "debit", "30.00")])
    assert result.balances == {"a1": 7000}
    assert len(result.applied) == 2


def test_duplicate_event_is_applied_once():
    deposit = event("e1", "a1", "credit", "100.00")
    result = LedgerProcessor().process([deposit, dict(deposit)])
    assert result.balances == {"a1": 10000}
    assert result.duplicates == ["e1"]


def test_debit_that_overdraws_is_rejected():
    result = LedgerProcessor().process([event("e1", "a1", "credit", "10.00"), event("e2", "a1", "debit", "100.00")])
    assert result.balances == {"a1": 1000}
    assert [r.event_id for r in result.rejected] == ["e2"]
    assert "insufficient funds" in result.rejected[0].reason


def test_daily_totals_counts_applied_transactions():
    result = LedgerProcessor().process([
        event("e1", "a1", "credit", "50.00", "2026-03-01T09:00:00Z"),
        event("e2", "a1", "debit", "20.00", "2026-03-02T09:00:00Z"),
    ])
    assert daily_totals(result) == {
        "2026-03-01": {"credits": 5000, "debits": 0, "count": 1},
        "2026-03-02": {"credits": 0, "debits": 2000, "count": 1},
    }


def test_account_statement_running_balance():
    processor = LedgerProcessor(opening_balances={"a1": 1000})
    result = processor.process([event("e1", "a1", "credit", "5.00"), event("e2", "a1", "debit", "2.50")])
    statement = account_statement(result, "a1")
    assert statement["opening_cents"] == 1000
    assert [line["balance_cents"] for line in statement["lines"]] == [1500, 1250]
    assert statement["closing_cents"] == 1250
