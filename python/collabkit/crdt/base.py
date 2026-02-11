"""
CRDT base classes and Operation dataclass.

CRDTs (Conflict-free Replicated Data Types) allow concurrent modifications
to shared state without coordination, automatically merging changes.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Generic, TypeVar
import time
import uuid

T = TypeVar("T")


@dataclass(frozen=True)
class Operation:
    """
    Represents a single operation on a CRDT.

    Operations are immutable and can be applied in any order to achieve
    eventual consistency across all replicas.
    """
    id: str
    timestamp: float
    node_id: str
    path: tuple[str, ...]
    op_type: str  # 'set', 'delete', 'increment', 'decrement', 'add', 'remove'
    value: Any = None

    @classmethod
    def create(
        cls,
        node_id: str,
        path: list[str] | tuple[str, ...],
        op_type: str,
        value: Any = None,
    ) -> "Operation":
        """Create a new operation with auto-generated ID and timestamp."""
        return cls(
            id=str(uuid.uuid4()),
            timestamp=time.time(),
            node_id=node_id,
            path=tuple(path) if isinstance(path, list) else path,
            op_type=op_type,
            value=value,
        )

    def to_dict(self) -> dict[str, Any]:
        """Serialize operation to dictionary."""
        return {
            "id": self.id,
            "timestamp": self.timestamp,
            "node_id": self.node_id,
            "path": list(self.path),
            "op_type": self.op_type,
            "value": self.value,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any], use_server_timestamp: bool = True) -> "Operation":
        """
        Deserialize operation from dictionary.

        Args:
            data: The operation dictionary
            use_server_timestamp: If True, ignore client timestamp and use server time.
                This prevents clients from manipulating LWW by sending future timestamps.
        """
        return cls(
            id=data["id"],
            timestamp=time.time() if use_server_timestamp else data["timestamp"],
            node_id=data["node_id"],
            path=tuple(data["path"]),
            op_type=data["op_type"],
            value=data.get("value"),
        )


@dataclass
class VersionVector:
    """
    Tracks the latest timestamp seen from each node.

    Used for efficient sync - only send operations newer than
    what the peer has already seen.
    """
    timestamps: dict[str, float] = field(default_factory=dict)

    def update(self, node_id: str, timestamp: float) -> None:
        """Update the vector with a new timestamp from a node."""
        current = self.timestamps.get(node_id, 0)
        self.timestamps[node_id] = max(current, timestamp)

    def get(self, node_id: str) -> float:
        """Get the latest timestamp seen from a node."""
        return self.timestamps.get(node_id, 0)

    def merge(self, other: "VersionVector") -> None:
        """Merge another version vector into this one."""
        for node_id, timestamp in other.timestamps.items():
            self.update(node_id, timestamp)

    def to_dict(self) -> dict[str, float]:
        """Serialize to dictionary."""
        return dict(self.timestamps)

    @classmethod
    def from_dict(cls, data: dict[str, float]) -> "VersionVector":
        """Deserialize from dictionary."""
        return cls(timestamps=dict(data))


class CRDT(ABC, Generic[T]):
    """
    Abstract base class for all CRDT types.

    Subclasses must implement:
    - apply: Apply a single operation
    - merge: Merge another CRDT of the same type
    - value: Get the current resolved value
    - operations_since: Get operations after a timestamp
    """

    def __init__(self, node_id: str):
        self.node_id = node_id
        self._operations: list[Operation] = []
        self._version_vector = VersionVector()

    @abstractmethod
    def apply(self, op: Operation) -> bool:
        """
        Apply an operation to this CRDT.

        Returns True if the operation was applied (not a duplicate).
        """
        ...

    @abstractmethod
    def merge(self, other: "CRDT[T]") -> None:
        """Merge another CRDT into this one."""
        ...

    @abstractmethod
    def value(self) -> T:
        """Get the current resolved value."""
        ...

    def operations_since(self, timestamp: float) -> list[Operation]:
        """Get all operations after the given timestamp."""
        return [op for op in self._operations if op.timestamp > timestamp]

    def all_operations(self) -> list[Operation]:
        """Get all operations."""
        return list(self._operations)

    def _record_operation(self, op: Operation) -> None:
        """Record an operation and update version vector."""
        self._operations.append(op)
        self._version_vector.update(op.node_id, op.timestamp)

    def _has_seen(self, op: Operation) -> bool:
        """Check if we've already seen this operation."""
        return any(existing.id == op.id for existing in self._operations)


class StateCRDT(CRDT[T]):
    """
    Base class for state-based CRDTs.

    State-based CRDTs transmit the full state and merge using
    a join-semilattice operation.
    """

    @abstractmethod
    def state(self) -> dict[str, Any]:
        """Get the full CRDT state for transmission."""
        ...

    @classmethod
    @abstractmethod
    def from_state(cls, node_id: str, state: dict[str, Any]) -> "StateCRDT[T]":
        """Reconstruct CRDT from transmitted state."""
        ...
