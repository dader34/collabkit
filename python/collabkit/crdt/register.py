"""
LWW-Register (Last-Writer-Wins Register) CRDT implementation.

A register holds a single value. Concurrent writes are resolved
by keeping the value with the latest timestamp.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Generic, TypeVar

from .base import CRDT, Operation, StateCRDT

T = TypeVar("T")


@dataclass
class TimestampedValue(Generic[T]):
    """A value with its associated timestamp and node ID."""
    value: T
    timestamp: float
    node_id: str

    def __gt__(self, other: "TimestampedValue[T]") -> bool:
        """Compare by timestamp, then node_id for deterministic tie-breaking."""
        if self.timestamp != other.timestamp:
            return self.timestamp > other.timestamp
        return self.node_id > other.node_id

    def __ge__(self, other: "TimestampedValue[T]") -> bool:
        return self == other or self > other


class LWWRegister(StateCRDT[T]):
    """
    Last-Writer-Wins Register.

    Stores a single value. When concurrent writes occur, the write
    with the latest timestamp wins. Ties are broken deterministically
    using node_id comparison.

    Example:
        register = LWWRegister[str]("node-1")
        register.set("hello")
        print(register.value())  # "hello"
    """

    def __init__(self, node_id: str, initial_value: T | None = None):
        super().__init__(node_id)
        self._current: TimestampedValue[T | None] = TimestampedValue(
            value=initial_value,
            timestamp=0.0,
            node_id=node_id,
        )

    def set(self, value: T) -> Operation:
        """
        Set a new value.

        Returns the operation that was applied.
        """
        op = Operation.create(
            node_id=self.node_id,
            path=(),
            op_type="set",
            value=value,
        )
        self.apply(op)
        return op

    def apply(self, op: Operation) -> bool:
        """Apply a set operation."""
        if self._has_seen(op):
            return False

        if op.op_type != "set":
            raise ValueError(f"LWWRegister only supports 'set' operations, got '{op.op_type}'")

        new_value = TimestampedValue(
            value=op.value,
            timestamp=op.timestamp,
            node_id=op.node_id,
        )

        # Only update if new value is "greater" (later timestamp or higher node_id)
        if new_value > self._current:
            self._current = new_value

        self._record_operation(op)
        return True

    def merge(self, other: "LWWRegister[T]") -> None:
        """Merge another register into this one."""
        # Apply all operations from the other register
        for op in other.all_operations():
            self.apply(op)

    def value(self) -> T | None:
        """Get the current value."""
        return self._current.value

    def state(self) -> dict[str, Any]:
        """Get the full state for transmission."""
        return {
            "value": self._current.value,
            "timestamp": self._current.timestamp,
            "node_id": self._current.node_id,
            "operations": [op.to_dict() for op in self._operations],
        }

    @classmethod
    def from_state(cls, node_id: str, state: dict[str, Any]) -> "LWWRegister[T]":
        """Reconstruct register from transmitted state."""
        register = cls(node_id)
        register._current = TimestampedValue(
            value=state["value"],
            timestamp=state["timestamp"],
            node_id=state["node_id"],
        )
        register._operations = [
            Operation.from_dict(op) for op in state.get("operations", [])
        ]
        return register
