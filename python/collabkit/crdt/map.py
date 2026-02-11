"""
LWW-Map (Last-Writer-Wins Map) CRDT implementation.

A map where each key is independently an LWW-Register.
Supports nested paths for deep object structures.
"""

from __future__ import annotations

from typing import Any, Dict

from .base import CRDT, Operation, StateCRDT, VersionVector


class LWWMap(StateCRDT[Dict[str, Any]]):
    """
    Last-Writer-Wins Map.

    Each key in the map is independently resolved using LWW semantics.
    Supports nested paths like ["users", "123", "name"] for deep updates.

    Example:
        state = LWWMap("node-1")
        state.set(["user", "name"], "Alice")
        state.set(["user", "age"], 30)
        print(state.value())  # {"user": {"name": "Alice", "age": 30}}
    """

    def __init__(self, node_id: str, initial_value: dict[str, Any] | None = None):
        super().__init__(node_id)
        # Store (value, timestamp, node_id) for each path
        self._entries: dict[tuple[str, ...], tuple[Any, float, str]] = {}
        # Track deleted paths
        self._tombstones: dict[tuple[str, ...], tuple[float, str]] = {}

        if initial_value:
            self._init_from_value(initial_value)

    def _init_from_value(self, value: dict[str, Any], path: tuple[str, ...] = ()) -> None:
        """Initialize entries from a nested dictionary."""
        for key, val in value.items():
            current_path = path + (key,)
            if isinstance(val, dict):
                self._init_from_value(val, current_path)
            else:
                self._entries[current_path] = (val, 0.0, self.node_id)

    def set(self, path: list[str] | tuple[str, ...], value: Any) -> Operation:
        """
        Set a value at the given path.

        If value is a dict, it will be flattened into individual path entries.
        Returns the operation that was applied.
        """
        op = Operation.create(
            node_id=self.node_id,
            path=path,
            op_type="set",
            value=value,
        )
        self.apply(op)
        return op

    def delete(self, path: list[str] | tuple[str, ...]) -> Operation:
        """
        Delete a value at the given path.

        Returns the operation that was applied.
        """
        op = Operation.create(
            node_id=self.node_id,
            path=path,
            op_type="delete",
        )
        self.apply(op)
        return op

    def get(self, path: list[str] | tuple[str, ...]) -> Any:
        """Get a value at the given path."""
        path_tuple = tuple(path) if isinstance(path, list) else path

        # Check if path is deleted
        if path_tuple in self._tombstones:
            tombstone = self._tombstones[path_tuple]
            entry = self._entries.get(path_tuple)
            if entry is None or tombstone[0] > entry[1]:
                return None

        entry = self._entries.get(path_tuple)
        if entry:
            return entry[0]

        # Check for nested values
        result = self._get_nested(path_tuple)
        return result

    def _get_nested(self, path: tuple[str, ...]) -> dict[str, Any] | None:
        """Get all values nested under a path as a dictionary."""
        result: dict[str, Any] = {}
        path_len = len(path)

        for entry_path, (value, ts, _) in self._entries.items():
            if len(entry_path) > path_len and entry_path[:path_len] == path:
                # Check tombstone
                tombstone = self._tombstones.get(entry_path)
                if tombstone and tombstone[0] > ts:
                    continue

                # Build nested structure
                remaining = entry_path[path_len:]
                current = result
                for key in remaining[:-1]:
                    if key not in current:
                        current[key] = {}
                    current = current[key]
                current[remaining[-1]] = value

        return result if result else None

    def apply(self, op: Operation) -> bool:
        """Apply a set or delete operation."""
        if self._has_seen(op):
            return False

        path = op.path

        if op.op_type == "set":
            self._apply_set(path, op.value, op.timestamp, op.node_id)
        elif op.op_type == "delete":
            self._apply_delete(path, op.timestamp, op.node_id)
        else:
            raise ValueError(f"LWWMap supports 'set' and 'delete' operations, got '{op.op_type}'")

        self._record_operation(op)
        return True

    def _apply_set(self, path: tuple[str, ...], value: Any, timestamp: float, node_id: str) -> None:
        """Apply a set operation at a path."""
        if isinstance(value, dict):
            # Flatten nested dict into individual entries
            self._flatten_set(path, value, timestamp, node_id)
        else:
            existing = self._entries.get(path)
            if existing is None or self._is_newer(timestamp, node_id, existing[1], existing[2]):
                self._entries[path] = (value, timestamp, node_id)

    def _flatten_set(
        self, path: tuple[str, ...], value: dict[str, Any], timestamp: float, node_id: str
    ) -> None:
        """Flatten a nested dict into individual path entries."""
        for key, val in value.items():
            current_path = path + (key,)
            if isinstance(val, dict):
                self._flatten_set(current_path, val, timestamp, node_id)
            else:
                existing = self._entries.get(current_path)
                if existing is None or self._is_newer(timestamp, node_id, existing[1], existing[2]):
                    self._entries[current_path] = (val, timestamp, node_id)

    def _apply_delete(self, path: tuple[str, ...], timestamp: float, node_id: str) -> None:
        """Apply a delete operation at a path."""
        existing = self._tombstones.get(path)
        if existing is None or self._is_newer(timestamp, node_id, existing[0], existing[1]):
            self._tombstones[path] = (timestamp, node_id)

    def _is_newer(
        self, ts1: float, node1: str, ts2: float, node2: str
    ) -> bool:
        """Check if (ts1, node1) is newer than (ts2, node2)."""
        if ts1 != ts2:
            return ts1 > ts2
        return node1 > node2

    def merge(self, other: "LWWMap") -> None:
        """Merge another map into this one."""
        for op in other.all_operations():
            self.apply(op)

    def value(self) -> dict[str, Any]:
        """Get the current value as a nested dictionary."""
        result: dict[str, Any] = {}

        for path, (value, ts, _) in self._entries.items():
            # Check tombstone
            tombstone = self._tombstones.get(path)
            if tombstone and tombstone[0] > ts:
                continue

            # Build nested structure
            current = result
            for key in path[:-1]:
                if key not in current:
                    current[key] = {}
                elif not isinstance(current[key], dict):
                    # Conflict: path has both a value and nested values
                    # Nested values take precedence
                    current[key] = {}
                current = current[key]

            if path:  # Don't set if path is empty
                current[path[-1]] = value

        return result

    def state(self) -> dict[str, Any]:
        """Get the full state for transmission."""
        return {
            "entries": {
                ".".join(path): {"value": val, "timestamp": ts, "node_id": nid}
                for path, (val, ts, nid) in self._entries.items()
            },
            "tombstones": {
                ".".join(path): {"timestamp": ts, "node_id": nid}
                for path, (ts, nid) in self._tombstones.items()
            },
            "operations": [op.to_dict() for op in self._operations],
        }

    @classmethod
    def from_state(cls, node_id: str, state: dict[str, Any]) -> "LWWMap":
        """Reconstruct map from transmitted state."""
        lww_map = cls(node_id)

        for path_str, entry in state.get("entries", {}).items():
            path = tuple(path_str.split(".")) if path_str else ()
            lww_map._entries[path] = (
                entry["value"],
                entry["timestamp"],
                entry["node_id"],
            )

        for path_str, tombstone in state.get("tombstones", {}).items():
            path = tuple(path_str.split(".")) if path_str else ()
            lww_map._tombstones[path] = (
                tombstone["timestamp"],
                tombstone["node_id"],
            )

        lww_map._operations = [
            Operation.from_dict(op) for op in state.get("operations", [])
        ]

        return lww_map

    def keys(self) -> list[str]:
        """Get top-level keys."""
        seen = set()
        for path in self._entries.keys():
            if path:
                seen.add(path[0])
        return list(seen)

    def __contains__(self, key: str) -> bool:
        """Check if a top-level key exists."""
        return any(path and path[0] == key for path in self._entries.keys())

    def __getitem__(self, key: str) -> Any:
        """Get a value by key (top-level only)."""
        return self.get((key,))

    def __setitem__(self, key: str, value: Any) -> None:
        """Set a value by key (top-level only)."""
        self.set((key,), value)
