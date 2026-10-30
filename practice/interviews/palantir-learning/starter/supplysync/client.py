"""The hospitals' inventory systems.

In production this is an HTTP client for each hospital's system. Here they're simulated in memory, with the same
paging, latency, and failures, so the sync can be tested on a laptop. Tests set up the hospitals and the failures.
"""
from __future__ import annotations

import math
import threading
import time
from collections import Counter
from dataclasses import dataclass
from typing import Dict, Iterable, List, Optional, Sequence, Tuple


@dataclass(frozen=True)
class Item:
    sku: str
    name: str
    on_hand: int


@dataclass(frozen=True)
class Page:
    items: List[Item]
    pages: int  # how many pages this hospital's inventory has in all


class TransientError(ConnectionError):
    """The connection dropped partway through. Trying the same request again usually works."""


class HospitalOffline(Exception):
    """The hospital's system is down for maintenance. Trying again tonight won't help."""


class TooManyRequests(Exception):
    """The hospital got a second request while one was still in flight. These old systems take one at a time."""


class HospitalAPI:
    """Every hospital's inventory system. fetch_page is the only call.

    inventories: each hospital's items.   page_size: items per page.   latency: seconds per request.
    drops: {hospital: request numbers that drop}, counting that hospital's requests from 1.
    offline: hospitals that are down.   slow: {hospital: seconds per request} for hospitals slower than latency.
    """

    def __init__(self, inventories: Dict[str, Sequence[Item]], page_size: int = 4, latency: float = 0.02,
                 drops: Optional[Dict[str, Iterable[int]]] = None, offline: Iterable[str] = (), slow: Optional[Dict[str, float]] = None,
                 broken: Iterable[str] = ()):
        self._inventories = {hospital: list(items) for hospital, items in inventories.items()}
        self._page_size, self._latency = page_size, latency
        self._drops = {hospital: set(numbers) for hospital, numbers in (drops or {}).items()}
        self._offline, self._broken, self._slow = set(offline), set(broken), dict(slow or {})
        self._lock = threading.Lock()
        self._start = time.monotonic()
        self._in_flight, self._per_hospital = 0, Counter()
        self.max_in_flight = 0       # the most requests in flight at once, across all hospitals
        self.max_per_hospital = 0    # the most in flight at once to any one hospital
        self.attempts = Counter()    # (hospital, page) -> how many times it was requested
        self.requests: List[Tuple[str, int, float, str]] = []   # (hospital, page, seconds after the API was made, outcome)
        self._counts = Counter()

    def fetch_page(self, hospital_id: str, page: int) -> Page:
        """One page of a hospital's inventory. Page 0 always exists; Page.pages says how many there are."""
        if hospital_id not in self._inventories:
            raise KeyError(f"there's no hospital {hospital_id!r}")
        with self._lock:
            started = round(time.monotonic() - self._start, 4)
            self._counts[hospital_id] += 1
            number = self._counts[hospital_id]
            self._in_flight += 1
            self._per_hospital[hospital_id] += 1
            crowded = self._per_hospital[hospital_id] > 1
            self.max_in_flight = max(self.max_in_flight, self._in_flight)
            self.max_per_hospital = max(self.max_per_hospital, self._per_hospital[hospital_id])
            self.attempts[(hospital_id, page)] += 1
        outcome = "ok"
        try:
            if crowded:
                raise TooManyRequests(f"{hospital_id} got a second request while one was still in flight")
            time.sleep(self._slow.get(hospital_id, self._latency))
            if hospital_id in self._offline:
                raise HospitalOffline(f"{hospital_id}'s inventory system is down for maintenance")
            if number in self._drops.get(hospital_id, ()):
                raise TransientError(f"the connection to {hospital_id} dropped")
            if hospital_id in self._broken:
                raise ValueError(f"{hospital_id} sent a page that doesn't parse")
            items = self._inventories[hospital_id]
            pages = max(1, math.ceil(len(items) / self._page_size))
            if not 0 <= page < pages:
                raise IndexError(f"{hospital_id} has pages 0 to {pages - 1}, not {page}")
            return Page(items[page * self._page_size:(page + 1) * self._page_size], pages)
        except Exception as error:
            outcome = type(error).__name__
            raise
        finally:
            with self._lock:
                self._in_flight -= 1
                self._per_hospital[hospital_id] -= 1
                self.requests.append((hospital_id, page, started, outcome))
