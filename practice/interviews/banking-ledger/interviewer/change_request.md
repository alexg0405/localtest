# Requirement change from the finance partner

Product has approved a small overdraft for standard accounts, starting with the
next batch run.

- A debit is now allowed as long as the balance afterwards is **not below
  -$50.00**. A debit that would take the balance below -$50.00 is still rejected
  with the reason `"insufficient funds"`.
- Make the limit configurable: `LedgerProcessor(opening_balances=None,
  overdraft_limit_cents=5000)`. `overdraft_limit_cents=0` gives the old rule.
- Statements and formatted balances must show negative balances correctly.

Please add tests for the new rule.
