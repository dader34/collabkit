"""
Presence tracking for CollabKit.

Tracks connected users per room and their presence data
(cursor position, status, custom data).
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Awaitable

from .protocol import User, PresenceBroadcast


@dataclass
class PresenceData:
    """Presence data for a single user in a room."""

    user: User
    data: dict[str, Any] = field(default_factory=dict)
    last_updated: float = field(default_factory=time.time)

    def update(self, data: dict[str, Any]) -> None:
        """Update presence data."""
        self.data.update(data)
        self.last_updated = time.time()

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary representation."""
        return {
            "user": self.user.model_dump(),
            "data": self.data,
            "last_updated": self.last_updated,
        }


class RoomPresence:
    """
    Tracks presence for all users in a single room.

    Attributes:
        room_id: The room identifier.
        users: Mapping of user_id to PresenceData.
    """

    def __init__(self, room_id: str):
        self.room_id = room_id
        self._users: dict[str, PresenceData] = {}
        self._lock = asyncio.Lock()

    @property
    def users(self) -> dict[str, PresenceData]:
        """Get all user presence data."""
        return self._users.copy()

    @property
    def user_count(self) -> int:
        """Get the number of users in the room."""
        return len(self._users)

    @property
    def user_list(self) -> list[User]:
        """Get list of all users in the room."""
        return [pd.user for pd in self._users.values()]

    async def add_user(self, user: User, initial_data: dict[str, Any] | None = None) -> None:
        """
        Add a user to the room presence.

        Args:
            user: The user to add.
            initial_data: Optional initial presence data.
        """
        async with self._lock:
            self._users[user.id] = PresenceData(
                user=user,
                data=initial_data or {},
            )

    async def remove_user(self, user_id: str) -> User | None:
        """
        Remove a user from the room presence.

        Args:
            user_id: The ID of the user to remove.

        Returns:
            The removed user, or None if not found.
        """
        async with self._lock:
            presence = self._users.pop(user_id, None)
            return presence.user if presence else None

    async def update_presence(self, user_id: str, data: dict[str, Any]) -> bool:
        """
        Update a user's presence data.

        Args:
            user_id: The user's ID.
            data: The presence data to merge.

        Returns:
            True if the user was found and updated, False otherwise.
        """
        async with self._lock:
            if user_id in self._users:
                self._users[user_id].update(data)
                return True
            return False

    def get_presence(self, user_id: str) -> PresenceData | None:
        """
        Get a user's presence data.

        Args:
            user_id: The user's ID.

        Returns:
            The presence data, or None if user not found.
        """
        return self._users.get(user_id)

    def has_user(self, user_id: str) -> bool:
        """Check if a user is in the room."""
        return user_id in self._users

    def is_empty(self) -> bool:
        """Check if the room has no users."""
        return len(self._users) == 0

    def get_all_presence(self) -> dict[str, dict[str, Any]]:
        """
        Get all presence data as a dictionary.

        Returns:
            Mapping of user_id to presence data dict.
        """
        return {user_id: pd.to_dict() for user_id, pd in self._users.items()}


# Type alias for presence broadcast callback
PresenceBroadcastCallback = Callable[[str, PresenceBroadcast], Awaitable[None]]


class PresenceManager:
    """
    Manages presence tracking across all rooms.

    Provides methods for:
    - Adding/removing users from rooms
    - Updating presence data
    - Broadcasting presence updates
    - Cleaning up stale presence data
    """

    def __init__(
        self,
        stale_timeout: float = 60.0,
        cleanup_interval: float = 30.0,
    ):
        """
        Initialize the presence manager.

        Args:
            stale_timeout: Seconds before presence data is considered stale.
            cleanup_interval: Seconds between cleanup runs.
        """
        self._rooms: dict[str, RoomPresence] = {}
        self._lock = asyncio.Lock()
        self._stale_timeout = stale_timeout
        self._cleanup_interval = cleanup_interval
        self._cleanup_task: asyncio.Task | None = None
        self._broadcast_callback: PresenceBroadcastCallback | None = None

    def set_broadcast_callback(self, callback: PresenceBroadcastCallback) -> None:
        """Set the callback for broadcasting presence updates."""
        self._broadcast_callback = callback

    async def start(self) -> None:
        """Start the presence manager and cleanup task."""
        if self._cleanup_task is None:
            self._cleanup_task = asyncio.create_task(self._cleanup_loop())

    async def stop(self) -> None:
        """Stop the presence manager and cleanup task."""
        if self._cleanup_task:
            self._cleanup_task.cancel()
            try:
                await self._cleanup_task
            except asyncio.CancelledError:
                pass
            self._cleanup_task = None

    async def _cleanup_loop(self) -> None:
        """Periodically clean up stale presence data."""
        while True:
            await asyncio.sleep(self._cleanup_interval)
            await self._cleanup_stale()

    async def _cleanup_stale(self) -> None:
        """Remove stale presence entries."""
        now = time.time()
        stale_threshold = now - self._stale_timeout

        async with self._lock:
            for room_id, room in list(self._rooms.items()):
                stale_users = [
                    user_id
                    for user_id, pd in room.users.items()
                    if pd.last_updated < stale_threshold
                ]

                for user_id in stale_users:
                    await room.remove_user(user_id)

                # Remove empty rooms
                if room.is_empty():
                    del self._rooms[room_id]

    def _get_or_create_room(self, room_id: str) -> RoomPresence:
        """Get or create a room presence tracker."""
        if room_id not in self._rooms:
            self._rooms[room_id] = RoomPresence(room_id)
        return self._rooms[room_id]

    async def join_room(
        self,
        room_id: str,
        user: User,
        initial_data: dict[str, Any] | None = None,
    ) -> list[User]:
        """
        Add a user to a room.

        Args:
            room_id: The room to join.
            user: The user joining.
            initial_data: Optional initial presence data.

        Returns:
            List of all users currently in the room.
        """
        async with self._lock:
            room = self._get_or_create_room(room_id)

        await room.add_user(user, initial_data)
        return room.user_list

    async def leave_room(self, room_id: str, user_id: str) -> User | None:
        """
        Remove a user from a room.

        Args:
            room_id: The room to leave.
            user_id: The user's ID.

        Returns:
            The removed user, or None if not found.
        """
        async with self._lock:
            room = self._rooms.get(room_id)
            if not room:
                return None

            user = await room.remove_user(user_id)

            # Clean up empty rooms
            if room.is_empty():
                del self._rooms[room_id]

            return user

    async def update_presence(
        self,
        room_id: str,
        user_id: str,
        data: dict[str, Any],
        broadcast: bool = True,
    ) -> bool:
        """
        Update a user's presence data.

        Args:
            room_id: The room ID.
            user_id: The user's ID.
            data: The presence data to merge.
            broadcast: Whether to broadcast the update.

        Returns:
            True if the update was successful, False otherwise.
        """
        room = self._rooms.get(room_id)
        if not room:
            return False

        updated = await room.update_presence(user_id, data)

        if updated and broadcast and self._broadcast_callback:
            message = PresenceBroadcast(
                room_id=room_id,
                user_id=user_id,
                data=data,
            )
            await self._broadcast_callback(room_id, message)

        return updated

    def get_room_users(self, room_id: str) -> list[User]:
        """
        Get all users in a room.

        Args:
            room_id: The room ID.

        Returns:
            List of users in the room.
        """
        room = self._rooms.get(room_id)
        return room.user_list if room else []

    def get_room_presence(self, room_id: str) -> dict[str, dict[str, Any]]:
        """
        Get all presence data for a room.

        Args:
            room_id: The room ID.

        Returns:
            Dictionary mapping user_id to presence data.
        """
        room = self._rooms.get(room_id)
        return room.get_all_presence() if room else {}

    def get_user_presence(self, room_id: str, user_id: str) -> PresenceData | None:
        """
        Get a specific user's presence data.

        Args:
            room_id: The room ID.
            user_id: The user's ID.

        Returns:
            The presence data, or None if not found.
        """
        room = self._rooms.get(room_id)
        return room.get_presence(user_id) if room else None

    def is_user_in_room(self, room_id: str, user_id: str) -> bool:
        """
        Check if a user is in a room.

        Args:
            room_id: The room ID.
            user_id: The user's ID.

        Returns:
            True if the user is in the room, False otherwise.
        """
        room = self._rooms.get(room_id)
        return room.has_user(user_id) if room else False

    def get_user_rooms(self, user_id: str) -> list[str]:
        """
        Get all rooms a user is in.

        Args:
            user_id: The user's ID.

        Returns:
            List of room IDs.
        """
        return [
            room_id
            for room_id, room in self._rooms.items()
            if room.has_user(user_id)
        ]

    @property
    def room_count(self) -> int:
        """Get the number of active rooms."""
        return len(self._rooms)

    @property
    def total_users(self) -> int:
        """Get the total number of users across all rooms."""
        return sum(room.user_count for room in self._rooms.values())


__all__ = [
    "PresenceData",
    "RoomPresence",
    "PresenceManager",
    "PresenceBroadcastCallback",
]
