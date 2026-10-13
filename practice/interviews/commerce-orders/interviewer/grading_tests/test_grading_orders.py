"""Grading tests for the order service. Kept out of the candidate workspace."""
import pytest

from orders import models
from orders.inventory import InventoryStore
from orders.models import InvalidTransition, LineItem, OrderNotFound, OrderStatus, OutOfStock, PaymentFailed
from orders.payments import FakePaymentGateway
from orders.retry import with_retries
from orders.service import OrderService


def make(stock=None, script=None):
    inventory = InventoryStore(stock or {"MUG-1": 10, "TEE-M": 10})
    gateway = FakePaymentGateway(script=script)
    return OrderService(inventory, gateway, sleep=lambda seconds: None), inventory, gateway


def walk(service, **kwargs):
    seen, token, pages = [], None, 0
    while True:
        page, token = service.list_orders(page_token=token, **kwargs)
        pages += 1
        seen.extend(order.order_id for order in page)
        if token is None:
            return seen, pages
        assert pages < 1000


# Duplicate requests

def test_duplicate_request_charges_and_reserves_once():
    service, inventory, gateway = make()
    items = [LineItem("MUG-1", 2, 500)]
    first = service.place_order("r1", "c1", items)
    for _ in range(3):
        assert service.place_order("r1", "c1", items).order_id == first.order_id
    assert gateway.calls == 1
    assert inventory.available("MUG-1") == 8
    assert walk(service)[0] == [first.order_id]


def test_failed_request_can_be_retried_with_the_same_id():
    service, inventory, gateway = make(script=["declined"])
    with pytest.raises(PaymentFailed):
        service.place_order("r1", "c1", [LineItem("MUG-1", 1, 500)])
    order = service.place_order("r1", "c1", [LineItem("MUG-1", 1, 500)])
    assert order.status == OrderStatus.PLACED
    assert len(gateway.charges) == 1
    assert inventory.available("MUG-1") == 9


# Stock

def test_out_of_stock_on_a_later_item_releases_earlier_items():
    service, inventory, _ = make(stock={"MUG-1": 5, "TEE-M": 1})
    with pytest.raises(OutOfStock):
        service.place_order("r1", "c1", [LineItem("MUG-1", 3, 500), LineItem("TEE-M", 2, 900)])
    assert inventory.available("MUG-1") == 5
    assert inventory.available("TEE-M") == 1


def test_payment_failure_releases_stock_and_stores_no_order():
    service, inventory, gateway = make(script=["transient", "transient", "transient"])
    with pytest.raises(PaymentFailed):
        service.place_order("r1", "c1", [LineItem("MUG-1", 4, 500)])
    assert inventory.available("MUG-1") == 10
    assert walk(service)[0] == []
    assert gateway.charges == []


# Retries

def test_transient_errors_get_three_attempts_in_total():
    service, _, gateway = make(script=["transient", "transient", "transient", "ok"])
    with pytest.raises(PaymentFailed):
        service.place_order("r1", "c1", [LineItem("MUG-1", 1, 500)])
    assert gateway.calls == 3


def test_success_on_the_third_attempt():
    service, _, gateway = make(script=["transient", "transient", "ok"])
    service.place_order("r1", "c1", [LineItem("MUG-1", 1, 500)])
    assert gateway.calls == 3 and len(gateway.charges) == 1


def test_declined_card_is_not_retried():
    service, inventory, gateway = make(script=["declined", "ok"])
    with pytest.raises(PaymentFailed):
        service.place_order("r1", "c1", [LineItem("MUG-1", 1, 500)])
    assert gateway.calls == 1
    assert inventory.available("MUG-1") == 10


def test_with_retries_does_not_sleep_after_the_last_attempt():
    sleeps = []

    def always_fails():
        raise TimeoutError("boom")

    with pytest.raises(TimeoutError):
        with_retries(always_fails, max_attempts=3, retry_on=(TimeoutError,), sleep=sleeps.append)
    assert len(sleeps) == 2


# Pagination

def test_pagination_with_a_partial_last_page():
    service, _, _ = make(stock={"MUG-1": 100})
    placed = [service.place_order(f"r{n}", "c1", [LineItem("MUG-1", 1, 100)]).order_id for n in range(45)]
    seen, pages = walk(service, limit=20)
    assert seen == placed and pages == 3


def test_pagination_with_an_exact_multiple_has_no_empty_page():
    service, _, _ = make(stock={"MUG-1": 100})
    placed = [service.place_order(f"r{n}", "c1", [LineItem("MUG-1", 1, 100)]).order_id for n in range(40)]
    seen, pages = walk(service, limit=20)
    assert seen == placed and pages == 2


def test_pagination_filters_by_customer_across_pages():
    service, _, _ = make(stock={"MUG-1": 100})
    mine = []
    for n in range(12):
        customer = "me" if n % 3 else "other"
        order = service.place_order(f"r{n}", customer, [LineItem("MUG-1", 1, 100)])
        if customer == "me":
            mine.append(order.order_id)
    assert walk(service, customer_id="me", limit=3)[0] == mine


def test_empty_store_returns_one_empty_page():
    service, _, _ = make()
    assert service.list_orders() == ([], None)


@pytest.mark.parametrize("limit", [0, 101, -1])
def test_limit_out_of_range_is_rejected(limit):
    service, _, _ = make()
    with pytest.raises(ValueError):
        service.list_orders(limit=limit)


# Cancelling

def test_cancel_releases_stock_once():
    service, inventory, _ = make()
    order = service.place_order("r1", "c1", [LineItem("MUG-1", 3, 500), LineItem("TEE-M", 1, 900)])
    service.cancel_order(order.order_id)
    service.cancel_order(order.order_id)
    assert order.status == OrderStatus.CANCELLED
    assert inventory.available("MUG-1") == 10 and inventory.available("TEE-M") == 10


def test_shipped_order_cannot_be_cancelled():
    service, inventory, _ = make()
    order = service.place_order("r1", "c1", [LineItem("MUG-1", 3, 500)])
    service.ship_order(order.order_id)
    with pytest.raises(InvalidTransition):
        service.cancel_order(order.order_id)
    assert inventory.available("MUG-1") == 7


def test_cancel_unknown_order_raises_not_found():
    service, _, _ = make()
    with pytest.raises(OrderNotFound):
        service.cancel_order("ord-404")


# Requirement change (revealed at minute 30)

def conflict_error():
    error = getattr(models, "IdempotencyConflict", None)
    assert error is not None, "orders.models.IdempotencyConflict does not exist"
    assert issubclass(error, models.OrderError)
    return error


def test_change_reused_request_id_with_different_items_conflicts():
    error = conflict_error()
    service, inventory, gateway = make()
    service.place_order("r1", "c1", [LineItem("MUG-1", 1, 500)])
    with pytest.raises(error):
        service.place_order("r1", "c1", [LineItem("MUG-1", 2, 500)])
    assert gateway.calls == 1 and inventory.available("MUG-1") == 9


def test_change_reused_request_id_from_another_customer_conflicts():
    error = conflict_error()
    service, _, _ = make()
    service.place_order("r1", "c1", [LineItem("MUG-1", 1, 500)])
    with pytest.raises(error):
        service.place_order("r1", "c2", [LineItem("MUG-1", 1, 500)])


def test_change_same_items_in_another_order_is_still_a_duplicate():
    conflict_error()
    service, _, gateway = make()
    first = service.place_order("r1", "c1", [LineItem("MUG-1", 1, 500), LineItem("TEE-M", 2, 900)])
    again = service.place_order("r1", "c1", [LineItem("TEE-M", 2, 900), LineItem("MUG-1", 1, 500)])
    assert again.order_id == first.order_id and gateway.calls == 1
