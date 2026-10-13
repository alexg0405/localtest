# Requirement change from the product owner

The mobile team found a bug on their side: after an app update, two different
carts were sometimes sent with the **same `request_id`**. Today the second cart
would silently get the first cart's order back.

New rule:

- If a `request_id` that already produced an order is reused with a **different
  customer or different items**, `place_order` raises a new exception,
  `IdempotencyConflict`. Add it to `orders/models.py` as a subclass of
  `OrderError`. Nothing is charged or reserved for the conflicting call.
- Items count as the same when they have the same SKUs, quantities, and unit
  prices. The order in which the items are listed does not matter.
- A true duplicate (same customer, same items) still returns the original order.

Please add tests for the new rule.
