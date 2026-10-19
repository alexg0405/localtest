# Order service

You have joined the team that owns a small order service. It places orders,
reserves stock, charges a payment gateway, and lists a customer's orders page by
page. Everything is in memory so it can run on a laptop.

Support has escalated two customer reports, and product wants a missing feature:

1. "I tapped *Place order* twice because the app was slow, and I was charged
   twice." The mobile app retries a request with the **same `request_id`** when
   it times out.
2. "My order history is missing an order." The history screen walks through
   `list_orders` one page at a time.
3. Customers cannot cancel an order yet. `OrderService.cancel_order` needs to be
   implemented.

Your interviewer will play the product owner. Ask them about anything that is
unclear before you change behaviour.

## Requirements

- `place_order(request_id, customer_id, items)` places one order:
  - It reserves stock for every item, charges the customer the order total, and
    stores the order with status `PLACED`.
  - Calling it again with a `request_id` that already produced an order returns
    that same order. It must not charge again or reserve stock again.
  - If any item is out of stock it raises `OutOfStock`, and no stock stays
    reserved for that request.
  - Transient gateway errors (`TransientPaymentError`) are retried, with at most
    **3 attempts in total**. A declined card (`PaymentDeclined`) is not retried.
    When payment fails, it raises `PaymentFailed`, stores no order, and returns
    all reserved stock.
- `cancel_order(order_id)` cancels a `PLACED` order and returns its stock.
- `list_orders(customer_id=None, limit=20, page_token=None)` returns
  `(orders, next_page_token)` in creation order. Following `next_page_token`
  until it is `None` must return every matching order exactly once. `limit` must
  be between 1 and 100.

## Acceptance criteria

- The visible tests in `tests/` pass: `pytest -q`
- The duplicate-request and pagination reports are fixed, with regression tests.
- `cancel_order` works and is tested.
- You can explain your changes, your assumptions, and the tradeoffs you made.

## Try it

```sh
python examples/demo.py
pytest -q
```

Run these with the practice virtualenv active: `source ~/interview-practice/.venv/bin/activate`
on macOS or Linux, or `& ~\interview-practice\.venv\Scripts\Activate.ps1` in PowerShell on
Windows (the dashboard shows the exact command for your setup).

## Also in this session

- `patch_review/` contains a patch an AI assistant proposed for one of these
  issues. You will review it later in the session (see `patch_review/REVIEW.md`).
- Partway through, the product owner may change a requirement. If they do, it
  appears in the dashboard and in `CHANGE_REQUEST.md` in this folder.
