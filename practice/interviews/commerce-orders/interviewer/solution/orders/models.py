from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import List


class OrderStatus(str, Enum):
    PLACED = "PLACED"
    SHIPPED = "SHIPPED"
    CANCELLED = "CANCELLED"


@dataclass(frozen=True)
class LineItem:
    sku: str
    quantity: int
    unit_price_cents: int

    @property
    def total_cents(self) -> int:
        return self.quantity * self.unit_price_cents


@dataclass
class Order:
    order_id: str
    customer_id: str
    items: List[LineItem]
    request_id: str
    status: OrderStatus = OrderStatus.PLACED

    @property
    def total_cents(self) -> int:
        return sum(item.total_cents for item in self.items)


class OrderError(Exception):
    """Base class for errors the API layer turns into 4xx responses."""


class OutOfStock(OrderError):
    pass


class OrderNotFound(OrderError):
    pass


class InvalidTransition(OrderError):
    """The order is not in a state that allows this action."""


class PaymentFailed(OrderError):
    pass


class IdempotencyConflict(OrderError):
    """A request_id was reused for a different order."""
