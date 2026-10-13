from __future__ import annotations

from typing import Dict, Optional

from .models import OutOfStock


class InventoryStore:
    """Units on hand per SKU. Reserving takes units out; releasing puts them back."""

    def __init__(self, stock: Optional[Dict[str, int]] = None):
        self._stock: Dict[str, int] = dict(stock or {})

    def available(self, sku: str) -> int:
        return self._stock.get(sku, 0)

    def reserve(self, sku: str, quantity: int) -> None:
        if quantity <= 0:
            raise ValueError(f"quantity must be positive, got {quantity}")
        on_hand = self.available(sku)
        if on_hand < quantity:
            raise OutOfStock(f"{sku}: requested {quantity}, available {on_hand}")
        self._stock[sku] = on_hand - quantity

    def release(self, sku: str, quantity: int) -> None:
        self._stock[sku] = self.available(sku) + quantity
