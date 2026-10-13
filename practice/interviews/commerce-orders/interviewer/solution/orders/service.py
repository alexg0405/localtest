from __future__ import annotations

import itertools
import time
from collections import Counter
from typing import Callable, Dict, Iterable, List, Optional, Tuple

from .inventory import InventoryStore
from .models import IdempotencyConflict, InvalidTransition, LineItem, Order, OrderStatus, PaymentFailed
from .payments import FakePaymentGateway, PaymentDeclined, TransientPaymentError
from .repository import OrderRepository
from .retry import with_retries


def _fingerprint(customer_id: str, items: List[LineItem]) -> Tuple[str, Counter]:
    # Item order does not matter; SKU, quantity, and unit price do.
    return customer_id, Counter((item.sku, item.quantity, item.unit_price_cents) for item in items)


class OrderService:
    def __init__(
        self,
        inventory: InventoryStore,
        gateway: FakePaymentGateway,
        repository: Optional[OrderRepository] = None,
        sleep: Callable[[float], None] = time.sleep,
    ):
        self.inventory = inventory
        self.gateway = gateway
        self.repository = repository or OrderRepository()
        self._sleep = sleep
        self._by_request: Dict[str, str] = {}  # request_id -> order_id, only for orders that were placed
        self._ids = itertools.count(1)

    def place_order(self, request_id: str, customer_id: str, items: Iterable[LineItem]) -> Order:
        items = list(items)
        existing_id = self._by_request.get(request_id)
        if existing_id is not None:
            existing = self.repository.get(existing_id)
            if _fingerprint(customer_id, items) != _fingerprint(existing.customer_id, existing.items):
                raise IdempotencyConflict(f"request {request_id} was already used for order {existing_id}")
            return existing
        if not items:
            raise ValueError("an order needs at least one item")

        self._reserve_all(items)
        order = Order(order_id=f"ord-{next(self._ids)}", customer_id=customer_id, items=items, request_id=request_id)
        try:
            with_retries(
                lambda: self.gateway.charge(customer_id, order.total_cents, request_id),
                max_attempts=3,
                retry_on=(TransientPaymentError,),
                sleep=self._sleep,
            )
        except (TransientPaymentError, PaymentDeclined) as error:
            self._release_all(items)
            raise PaymentFailed(str(error)) from error

        # Recorded only after payment succeeds, so a failed request can be retried with the same id.
        self.repository.add(order)
        self._by_request[request_id] = order.order_id
        return order

    def cancel_order(self, order_id: str) -> Order:
        """Cancels a PLACED order and returns its stock. Cancelling twice is a no-op."""
        order = self.repository.get(order_id)
        if order.status == OrderStatus.CANCELLED:
            return order
        if order.status != OrderStatus.PLACED:
            raise InvalidTransition(f"cannot cancel an order that is {order.status.value}")
        self._release_all(order.items)
        order.status = OrderStatus.CANCELLED
        return order

    def ship_order(self, order_id: str) -> Order:
        order = self.repository.get(order_id)
        if order.status != OrderStatus.PLACED:
            raise InvalidTransition(f"cannot ship an order that is {order.status.value}")
        order.status = OrderStatus.SHIPPED
        return order

    def list_orders(
        self, customer_id: Optional[str] = None, limit: int = 20, page_token: Optional[str] = None
    ) -> Tuple[List[Order], Optional[str]]:
        return self.repository.list_orders(customer_id=customer_id, limit=limit, page_token=page_token)

    def _reserve_all(self, items: List[LineItem]) -> None:
        reserved: List[LineItem] = []
        try:
            for item in items:
                self.inventory.reserve(item.sku, item.quantity)
                reserved.append(item)
        except Exception:
            self._release_all(reserved)
            raise

    def _release_all(self, items: List[LineItem]) -> None:
        for item in items:
            self.inventory.release(item.sku, item.quantity)
