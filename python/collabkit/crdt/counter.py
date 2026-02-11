"""
Counter CRDT implementations.

G-Counter: Grow-only counter (increment only)
PN-Counter: Positive-Negative counter (increment and decrement)
"""

from __future__ import annotations

from typing import Any

from .base import Operation, StateCRDT


class GCounter(StateCRDT[int]):
    """
    Grow-only Counter (G-Counter).

    Each node maintains its own count, and the total is the sum
    of all node counts. Only supports increment operations.

    Example:
        counter = GCounter("node-1")
        counter.increment(5)
        print(counter.value())  # 5
    """

    def __init__(self, node_id: str):
        super().__init__(node_id)
        self._counts: dict[str, int] = {}

    def increment(self, amount: int = 1) -> Operation:
        """
        Increment the counter.

        Args:
            amount: Positive integer to add (default 1)

        Returns the operation that was applied.
        """
        if amount < 0:
            raise ValueError("GCounter only supports positive increments")

        op = Operation.create(
            node_id=self.node_id,
            path=(),
            op_type="increment",
            value=amount,
        )
        self.apply(op)
        return op

    def apply(self, op: Operation) -> bool:
        """Apply an increment operation."""
        if self._has_seen(op):
            return False

        if op.op_type != "increment":
            raise ValueError(f"GCounter only supports 'increment' operations, got '{op.op_type}'")

        if op.value < 0:
            raise ValueError("GCounter only supports positive increments")

        # Add to the node's count
        current = self._counts.get(op.node_id, 0)
        self._counts[op.node_id] = current + op.value

        self._record_operation(op)
        return True

    def merge(self, other: "GCounter") -> None:
        """Merge another counter by taking max of each node's count."""
        for node_id, count in other._counts.items():
            current = self._counts.get(node_id, 0)
            self._counts[node_id] = max(current, count)

        # Also apply any operations we haven't seen
        for op in other.all_operations():
            if not self._has_seen(op):
                self._record_operation(op)

    def value(self) -> int:
        """Get the current counter value (sum of all node counts)."""
        return sum(self._counts.values())

    def state(self) -> dict[str, Any]:
        """Get the full state for transmission."""
        return {
            "counts": dict(self._counts),
            "operations": [op.to_dict() for op in self._operations],
        }

    @classmethod
    def from_state(cls, node_id: str, state: dict[str, Any]) -> "GCounter":
        """Reconstruct counter from transmitted state."""
        counter = cls(node_id)
        counter._counts = dict(state.get("counts", {}))
        counter._operations = [
            Operation.from_dict(op) for op in state.get("operations", [])
        ]
        return counter


class PNCounter(StateCRDT[int]):
    """
    Positive-Negative Counter (PN-Counter).

    Combines two G-Counters: one for increments, one for decrements.
    The value is the difference between the two.

    Example:
        counter = PNCounter("node-1")
        counter.increment(10)
        counter.decrement(3)
        print(counter.value())  # 7
    """

    def __init__(self, node_id: str):
        super().__init__(node_id)
        self._positive: dict[str, int] = {}  # Increment counts per node
        self._negative: dict[str, int] = {}  # Decrement counts per node

    def increment(self, amount: int = 1) -> Operation:
        """
        Increment the counter.

        Args:
            amount: Positive integer to add (default 1)
        """
        if amount < 0:
            raise ValueError("Use decrement() for negative values")

        op = Operation.create(
            node_id=self.node_id,
            path=(),
            op_type="increment",
            value=amount,
        )
        self.apply(op)
        return op

    def decrement(self, amount: int = 1) -> Operation:
        """
        Decrement the counter.

        Args:
            amount: Positive integer to subtract (default 1)
        """
        if amount < 0:
            raise ValueError("Use increment() for negative values")

        op = Operation.create(
            node_id=self.node_id,
            path=(),
            op_type="decrement",
            value=amount,
        )
        self.apply(op)
        return op

    def apply(self, op: Operation) -> bool:
        """Apply an increment or decrement operation."""
        if self._has_seen(op):
            return False

        if op.op_type == "increment":
            current = self._positive.get(op.node_id, 0)
            self._positive[op.node_id] = current + op.value
        elif op.op_type == "decrement":
            current = self._negative.get(op.node_id, 0)
            self._negative[op.node_id] = current + op.value
        else:
            raise ValueError(
                f"PNCounter supports 'increment' and 'decrement' operations, got '{op.op_type}'"
            )

        self._record_operation(op)
        return True

    def merge(self, other: "PNCounter") -> None:
        """Merge another counter by taking max of each node's counts."""
        for node_id, count in other._positive.items():
            current = self._positive.get(node_id, 0)
            self._positive[node_id] = max(current, count)

        for node_id, count in other._negative.items():
            current = self._negative.get(node_id, 0)
            self._negative[node_id] = max(current, count)

        for op in other.all_operations():
            if not self._has_seen(op):
                self._record_operation(op)

    def value(self) -> int:
        """Get the current counter value (positive - negative)."""
        pos = sum(self._positive.values())
        neg = sum(self._negative.values())
        return pos - neg

    def state(self) -> dict[str, Any]:
        """Get the full state for transmission."""
        return {
            "positive": dict(self._positive),
            "negative": dict(self._negative),
            "operations": [op.to_dict() for op in self._operations],
        }

    @classmethod
    def from_state(cls, node_id: str, state: dict[str, Any]) -> "PNCounter":
        """Reconstruct counter from transmitted state."""
        counter = cls(node_id)
        counter._positive = dict(state.get("positive", {}))
        counter._negative = dict(state.get("negative", {}))
        counter._operations = [
            Operation.from_dict(op) for op in state.get("operations", [])
        ]
        return counter
