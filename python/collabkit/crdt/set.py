"""
OR-Set (Observed-Remove Set) CRDT implementation.

An OR-Set allows both add and remove operations. When an element
is added and removed concurrently, the add wins (add-wins semantics).
"""

from __future__ import annotations

from typing import Any, Generic, Set, TypeVar
import hashlib
import json

from .base import Operation, StateCRDT

T = TypeVar("T")


def _hash_value(value: Any) -> str:
    """Create a deterministic hash for any JSON-serializable value."""
    serialized = json.dumps(value, sort_keys=True, default=str)
    return hashlib.sha256(serialized.encode()).hexdigest()[:16]


class ORSet(StateCRDT[Set[T]]):
    """
    Observed-Remove Set (OR-Set / Add-Wins Set).

    Each element has a unique tag when added. Remove operations
    only remove elements with tags that have been "observed" (seen).
    Concurrent add and remove results in the element being present.

    Example:
        my_set = ORSet[str]("node-1")
        my_set.add("apple")
        my_set.add("banana")
        my_set.remove("apple")
        print(my_set.value())  # {"banana"}
    """

    def __init__(self, node_id: str):
        super().__init__(node_id)
        # Map from element hash -> set of (tag, value) pairs
        self._elements: dict[str, set[tuple[str, Any]]] = {}
        # Set of removed tags
        self._removed_tags: set[str] = set()

    def add(self, value: T) -> Operation:
        """
        Add an element to the set.

        Returns the operation that was applied.
        """
        op = Operation.create(
            node_id=self.node_id,
            path=(),
            op_type="add",
            value=value,
        )
        self.apply(op)
        return op

    def remove(self, value: T) -> Operation:
        """
        Remove an element from the set.

        Only removes instances that have been observed locally.
        Returns the operation that was applied.
        """
        # Collect all tags for this value that we've seen
        value_hash = _hash_value(value)
        observed_tags = []
        if value_hash in self._elements:
            for tag, _ in self._elements[value_hash]:
                if tag not in self._removed_tags:
                    observed_tags.append(tag)

        op = Operation.create(
            node_id=self.node_id,
            path=(),
            op_type="remove",
            value={"element": value, "tags": observed_tags},
        )
        self.apply(op)
        return op

    def apply(self, op: Operation) -> bool:
        """Apply an add or remove operation."""
        if self._has_seen(op):
            return False

        if op.op_type == "add":
            self._apply_add(op)
        elif op.op_type == "remove":
            self._apply_remove(op)
        else:
            raise ValueError(f"ORSet supports 'add' and 'remove' operations, got '{op.op_type}'")

        self._record_operation(op)
        return True

    def _apply_add(self, op: Operation) -> None:
        """Apply an add operation."""
        value = op.value
        value_hash = _hash_value(value)

        # Use operation ID as unique tag
        tag = op.id

        if value_hash not in self._elements:
            self._elements[value_hash] = set()

        self._elements[value_hash].add((tag, value))

    def _apply_remove(self, op: Operation) -> None:
        """Apply a remove operation."""
        tags = op.value.get("tags", [])
        for tag in tags:
            self._removed_tags.add(tag)

    def merge(self, other: "ORSet[T]") -> None:
        """Merge another set into this one."""
        # Merge elements
        for value_hash, tagged_values in other._elements.items():
            if value_hash not in self._elements:
                self._elements[value_hash] = set()
            self._elements[value_hash].update(tagged_values)

        # Merge removed tags
        self._removed_tags.update(other._removed_tags)

        # Merge operations
        for op in other.all_operations():
            if not self._has_seen(op):
                self._record_operation(op)

    def value(self) -> set[T]:
        """Get the current set contents."""
        result = set()
        for value_hash, tagged_values in self._elements.items():
            for tag, val in tagged_values:
                if tag not in self._removed_tags:
                    # Can't add unhashable types to set, use first one found
                    try:
                        result.add(val)
                    except TypeError:
                        # Value is unhashable, skip duplicates
                        if val not in [v for v in result]:
                            result.add(val)
                    break  # Only need one surviving instance
        return result

    def to_list(self) -> list[T]:
        """Get the current set contents as a list (for unhashable types)."""
        result = []
        seen_hashes = set()
        for value_hash, tagged_values in self._elements.items():
            for tag, val in tagged_values:
                if tag not in self._removed_tags and value_hash not in seen_hashes:
                    result.append(val)
                    seen_hashes.add(value_hash)
                    break
        return result

    def contains(self, value: T) -> bool:
        """Check if the set contains a value."""
        value_hash = _hash_value(value)
        if value_hash not in self._elements:
            return False

        for tag, _ in self._elements[value_hash]:
            if tag not in self._removed_tags:
                return True
        return False

    def __contains__(self, value: T) -> bool:
        """Check if the set contains a value."""
        return self.contains(value)

    def __len__(self) -> int:
        """Get the number of elements in the set."""
        return len(self.to_list())

    def state(self) -> dict[str, Any]:
        """Get the full state for transmission."""
        return {
            "elements": {
                vh: [(tag, val) for tag, val in tagged]
                for vh, tagged in self._elements.items()
            },
            "removed_tags": list(self._removed_tags),
            "operations": [op.to_dict() for op in self._operations],
        }

    @classmethod
    def from_state(cls, node_id: str, state: dict[str, Any]) -> "ORSet[T]":
        """Reconstruct set from transmitted state."""
        or_set: ORSet[T] = cls(node_id)

        for value_hash, tagged_list in state.get("elements", {}).items():
            or_set._elements[value_hash] = {(tag, val) for tag, val in tagged_list}

        or_set._removed_tags = set(state.get("removed_tags", []))
        or_set._operations = [
            Operation.from_dict(op) for op in state.get("operations", [])
        ]

        return or_set
