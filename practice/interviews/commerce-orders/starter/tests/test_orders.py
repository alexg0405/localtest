import pytest

from orders.inventory import InventoryStore
from orders.models import LineItem, OrderStatus, OutOfStock
from orders.payments import FakePaymentGateway
from orders.service import OrderService


def make_service(stock=None, script=None):
    inventory = InventoryStore(stock or {"MUG-1": 10, "TEE-M": 10})
    gateway = FakePaymentGateway(script=script)
    return OrderService(inventory, gateway, sleep=lambda seconds: None), inventory, gateway


def test_place_order_reserves_stock_and_charges_total():
    service, inventory, gateway = make_service()
    order = service.place_order("r1", "c1", [LineItem("MUG-1", 2, 1299), LineItem("TEE-M", 1, 1800)])
    assert order.status == OrderStatus.PLACED
    assert order.total_cents == 2 * 1299 + 1800
    assert inventory.available("MUG-1") == 8
    assert gateway.charges == [("c1", 4398, "r1")]


def test_out_of_stock_raises():
    service, _, _ = make_service(stock={"MUG-1": 1})
    with pytest.raises(OutOfStock):
        service.place_order("r1", "c1", [LineItem("MUG-1", 2, 1299)])


def test_transient_gateway_error_is_retried():
    service, _, gateway = make_service(script=["transient", "ok"])
    service.place_order("r1", "c1", [LineItem("MUG-1", 1, 1299)])
    assert len(gateway.charges) == 1


def test_same_request_id_returns_the_same_order():
    service, inventory, gateway = make_service()
    first = service.place_order("r1", "c1", [LineItem("MUG-1", 1, 1299)])
    second = service.place_order("r1", "c1", [LineItem("MUG-1", 1, 1299)])
    assert second.order_id == first.order_id
    assert len(gateway.charges) == 1
    assert inventory.available("MUG-1") == 9


def test_pages_return_every_order_once():
    service, _, _ = make_service(stock={"MUG-1": 100})
    placed = [service.place_order(f"r{n}", "c1", [LineItem("MUG-1", 1, 100)]).order_id for n in range(7)]
    seen, token = [], None
    while True:
        page, token = service.list_orders(customer_id="c1", limit=3, page_token=token)
        seen.extend(order.order_id for order in page)
        if token is None:
            break
    assert seen == placed


def test_cancel_returns_stock():
    service, inventory, _ = make_service()
    order = service.place_order("r1", "c1", [LineItem("MUG-1", 3, 1299)])
    cancelled = service.cancel_order(order.order_id)
    assert cancelled.status == OrderStatus.CANCELLED
    assert inventory.available("MUG-1") == 10
