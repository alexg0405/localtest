from __future__ import annotations

import itertools
import time
from typing import Callable, Dict, Iterable, List, Optional, Tuple

from .inventory import InventoryStore
from .models import InvalidTransition, LineItem, Order, OrderStatus, PaymentFailed
from .payments import FakePaymentGateway
from .repository import OrderRepository
from .retry import with_retries


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
        self._by_request: Dict[str, str] = {}  # request_id -> order_id
        self._ids = itertools.count(1)

    def place_order(self, request_id: str, customer_id: str, items: Iterable[LineItem]) -> Order:
        if request_id in self.repository._orders:
            return self.repository.get(self._by_request[request_id])
        items = list(items)
        if not items:
            raise ValueError("an order needs at least one item")

        for item in items:
            self.inventory.reserve(item.sku, item.quantity)

        order = Order(
            order_id=f"ord-{next(self._ids)}",
            customer_id=customer_id,
            items=items,
            request_id=request_id,
        )
        try:
            with_retries(
                lambda: self.gateway.charge(customer_id, order.total_cents, request_id),
                max_attempts=3,
                sleep=self._sleep,
            )
        except Exception as error:
            raise PaymentFailed(str(error)) from error

        self.repository.add(order)
        self._by_request[request_id] = order.order_id
        return order

    def cancel_order(self, order_id: str) -> Order:
        """Cancels a PLACED order and returns its stock to inventory."""
        raise NotImplementedError("cancel_order is not implemented yet")

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
