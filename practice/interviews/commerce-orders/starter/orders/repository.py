from __future__ import annotations

from typing import Dict, List, Optional, Tuple

from .models import Order, OrderNotFound


class OrderRepository:
    """Stores orders in creation order."""

    def __init__(self) -> None:
        self._orders: Dict[str, Order] = {}

    def add(self, order: Order) -> None:
        self._orders[order.order_id] = order

    def get(self, order_id: str) -> Order:
        try:
            return self._orders[order_id]
        except KeyError:
            raise OrderNotFound(order_id) from None

    def list_orders(
        self, customer_id: Optional[str] = None, limit: int = 20, page_token: Optional[str] = None
    ) -> Tuple[List[Order], Optional[str]]:
        """Returns one page of orders and the token for the next page (None on the last page)."""
        if limit < 1 or limit > 100:
            raise ValueError("limit must be between 1 and 100")
        orders = [o for o in self._orders.values() if customer_id is None or o.customer_id == customer_id]
        start = int(page_token) + 1 if page_token else 0
        page = orders[start:start + limit]
        next_token = str(start + limit) if start + limit < len(orders) else None
        return page, next_token
