"""Places a few orders and walks the order history page by page.

Run from the repository root:  python examples/demo.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from orders.inventory import InventoryStore  # noqa: E402
from orders.models import LineItem  # noqa: E402
from orders.payments import FakePaymentGateway  # noqa: E402
from orders.service import OrderService  # noqa: E402

inventory = InventoryStore({"MUG-1": 50, "TEE-M": 50})
gateway = FakePaymentGateway(script=["transient", "ok"])
service = OrderService(inventory, gateway, sleep=lambda seconds: None)

first = service.place_order("req-1", "cust-7", [LineItem("MUG-1", 2, 1299)])
print("placed", first.order_id, "total", first.total_cents, "cents")

again = service.place_order("req-1", "cust-7", [LineItem("MUG-1", 2, 1299)])
print("same request again ->", again.order_id, "| charges so far:", len(gateway.charges))

for n in range(2, 8):
    service.place_order(f"req-{n}", "cust-7", [LineItem("TEE-M", 1, 1800)])

token, seen = None, []
while True:
    page, token = service.list_orders(customer_id="cust-7", limit=3, page_token=token)
    seen.extend(order.order_id for order in page)
    if token is None:
        break
print("history:", seen)
print("MUG-1 left:", inventory.available("MUG-1"), "| TEE-M left:", inventory.available("TEE-M"))
