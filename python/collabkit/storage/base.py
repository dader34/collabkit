"""
Abstract storage provider interface.

Implement this interface to persist room state and operations.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any

from ..crdt.base import Operation


@dataclass
class RoomData:
    """
    Persisted room data.

    Attributes:
        id: Unique room identifier
        state: Current CRDT state (serialized)
        created_at: Unix timestamp of creation
        updated_at: Unix timestamp of last update
        metadata: Additional room data
    """
    id: str
    state: dict[str, Any]
    created_at: float
    updated_at: float
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class PresenceData:
    """
    User presence data.

    Attributes:
        room_id: Room the user is in
        user_id: User identifier
        connection_id: Unique connection identifier
        data: Custom presence data (cursor, status, etc.)
        last_seen: Unix timestamp of last activity
    """
    room_id: str
    user_id: str
    connection_id: str
    data: dict[str, Any]
    last_seen: float


class StorageProvider(ABC):
    """
    Abstract base class for storage providers.

    Implement this interface to persist room state, operations,
    and presence data.

    Example:
        class MyStorage(StorageProvider):
            async def get_room(self, room_id: str) -> RoomData | None:
                # Load from your database
                ...

            async def save_room(self, room: RoomData) -> None:
                # Save to your database
                ...
    """

    @abstractmethod
    async def connect(self) -> None:
        """Initialize storage connection."""
        ...

    @abstractmethod
    async def disconnect(self) -> None:
        """Close storage connection."""
        ...

    # Room operations

    @abstractmethod
    async def get_room(self, room_id: str) -> RoomData | None:
        """
        Get room data by ID.

        Args:
            room_id: The room identifier

        Returns:
            RoomData if room exists, None otherwise
        """
        ...

    @abstractmethod
    async def save_room(self, room: RoomData) -> None:
        """
        Save room data.

        Creates or updates the room.

        Args:
            room: The room data to save
        """
        ...

    @abstractmethod
    async def delete_room(self, room_id: str) -> bool:
        """
        Delete a room.

        Args:
            room_id: The room identifier

        Returns:
            True if room was deleted, False if it didn't exist
        """
        ...

    @abstractmethod
    async def list_rooms(self, limit: int = 100, offset: int = 0) -> list[RoomData]:
        """
        List all rooms.

        Args:
            limit: Maximum number of rooms to return
            offset: Number of rooms to skip

        Returns:
            List of room data
        """
        ...

    # Operation log

    @abstractmethod
    async def save_operation(self, room_id: str, op: Operation) -> None:
        """
        Save an operation to the log.

        Operations are used for syncing clients that were offline.

        Args:
            room_id: The room identifier
            op: The operation to save
        """
        ...

    @abstractmethod
    async def get_operations(
        self,
        room_id: str,
        since: float,
        limit: int = 1000,
    ) -> list[Operation]:
        """
        Get operations since a timestamp.

        Args:
            room_id: The room identifier
            since: Unix timestamp to get operations after
            limit: Maximum number of operations to return

        Returns:
            List of operations ordered by timestamp
        """
        ...

    @abstractmethod
    async def prune_operations(
        self,
        room_id: str,
        before: float,
    ) -> int:
        """
        Delete old operations.

        Used to clean up operation log after snapshotting.

        Args:
            room_id: The room identifier
            before: Delete operations before this timestamp

        Returns:
            Number of operations deleted
        """
        ...

    # Presence

    @abstractmethod
    async def save_presence(self, presence: PresenceData) -> None:
        """
        Save user presence data.

        Args:
            presence: The presence data to save
        """
        ...

    @abstractmethod
    async def get_presence(self, room_id: str) -> list[PresenceData]:
        """
        Get all presence data for a room.

        Args:
            room_id: The room identifier

        Returns:
            List of presence data for all users in room
        """
        ...

    @abstractmethod
    async def delete_presence(self, room_id: str, connection_id: str) -> bool:
        """
        Delete presence data for a connection.

        Args:
            room_id: The room identifier
            connection_id: The connection to remove

        Returns:
            True if presence was deleted
        """
        ...

    @abstractmethod
    async def cleanup_stale_presence(self, older_than: float) -> int:
        """
        Delete presence data that hasn't been updated recently.

        Args:
            older_than: Delete presence older than this timestamp

        Returns:
            Number of presence records deleted
        """
        ...


class MemoryStorage(StorageProvider):
    """
    In-memory storage for development and testing.

    Data is not persisted across restarts.
    """

    def __init__(self):
        self._rooms: dict[str, RoomData] = {}
        self._operations: dict[str, list[Operation]] = {}
        self._presence: dict[str, dict[str, PresenceData]] = {}

    async def connect(self) -> None:
        """No-op for memory storage."""
        pass

    async def disconnect(self) -> None:
        """No-op for memory storage."""
        pass

    async def get_room(self, room_id: str) -> RoomData | None:
        return self._rooms.get(room_id)

    async def save_room(self, room: RoomData) -> None:
        self._rooms[room.id] = room

    async def delete_room(self, room_id: str) -> bool:
        if room_id in self._rooms:
            del self._rooms[room_id]
            self._operations.pop(room_id, None)
            self._presence.pop(room_id, None)
            return True
        return False

    async def list_rooms(self, limit: int = 100, offset: int = 0) -> list[RoomData]:
        rooms = list(self._rooms.values())
        return rooms[offset:offset + limit]

    async def save_operation(self, room_id: str, op: Operation) -> None:
        if room_id not in self._operations:
            self._operations[room_id] = []
        self._operations[room_id].append(op)

    async def get_operations(
        self,
        room_id: str,
        since: float,
        limit: int = 1000,
    ) -> list[Operation]:
        ops = self._operations.get(room_id, [])
        filtered = [op for op in ops if op.timestamp > since]
        filtered.sort(key=lambda op: op.timestamp)
        return filtered[:limit]

    async def prune_operations(self, room_id: str, before: float) -> int:
        if room_id not in self._operations:
            return 0
        original_count = len(self._operations[room_id])
        self._operations[room_id] = [
            op for op in self._operations[room_id]
            if op.timestamp >= before
        ]
        return original_count - len(self._operations[room_id])

    async def save_presence(self, presence: PresenceData) -> None:
        if presence.room_id not in self._presence:
            self._presence[presence.room_id] = {}
        self._presence[presence.room_id][presence.connection_id] = presence

    async def get_presence(self, room_id: str) -> list[PresenceData]:
        return list(self._presence.get(room_id, {}).values())

    async def delete_presence(self, room_id: str, connection_id: str) -> bool:
        if room_id in self._presence and connection_id in self._presence[room_id]:
            del self._presence[room_id][connection_id]
            return True
        return False

    async def cleanup_stale_presence(self, older_than: float) -> int:
        count = 0
        for room_id in list(self._presence.keys()):
            for conn_id, presence in list(self._presence[room_id].items()):
                if presence.last_seen < older_than:
                    del self._presence[room_id][conn_id]
                    count += 1
        return count
