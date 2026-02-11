"""
Room management for CollabKit.

Provides Room class for managing collaborative state and RoomManager
for creating and managing multiple rooms.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from typing import Any, Callable, Awaitable
import uuid

from .crdt.base import Operation
from .crdt.map import LWWMap
from .protocol import User, OperationBroadcast
from .presence import PresenceManager

logger = logging.getLogger(__name__)


# Type alias for server function signature
ServerFunction = Callable[..., Awaitable[Any]]


@dataclass
class RegisteredFunction:
    """A registered server function that can be called by clients."""

    name: str
    func: ServerFunction
    requires_auth: bool = True
    required_permissions: list[str] = field(default_factory=list)


class Room:
    """
    Represents a collaborative room with shared state.

    Manages:
    - CRDT state (LWWMap)
    - Connected users and their WebSocket connections
    - Registered server functions
    - Operation broadcasting
    """

    def __init__(
        self,
        room_id: str,
        node_id: str | None = None,
        initial_state: dict[str, Any] | None = None,
    ):
        """
        Initialize a room.

        Args:
            room_id: Unique identifier for the room.
            node_id: Node ID for CRDT operations (defaults to room_id).
            initial_state: Optional initial state for the room.
        """
        self.room_id = room_id
        self.node_id = node_id or f"server-{room_id}"

        # CRDT state
        self._state = LWWMap(self.node_id, initial_state)

        # Connected users: user_id -> (User, WebSocket)
        self._connections: dict[str, tuple[User, Any]] = {}

        # Registered functions (local to this room)
        self._functions: dict[str, RegisteredFunction] = {}

        # Lock for thread-safe operations
        self._lock = asyncio.Lock()

        # Metadata
        self._created_at: float = 0.0
        self._metadata: dict[str, Any] = {}

    @property
    def state(self) -> LWWMap:
        """Get the room's CRDT state."""
        return self._state

    @property
    def value(self) -> dict[str, Any]:
        """Get the current state value."""
        return self._state.value()

    @property
    def users(self) -> list[User]:
        """Get list of connected users."""
        return [user for user, _ in self._connections.values()]

    @property
    def user_count(self) -> int:
        """Get number of connected users."""
        return len(self._connections)

    @property
    def is_empty(self) -> bool:
        """Check if room has no connected users."""
        return len(self._connections) == 0

    @property
    def metadata(self) -> dict[str, Any]:
        """Get room metadata."""
        return self._metadata.copy()

    def set_metadata(self, key: str, value: Any) -> None:
        """Set a metadata value."""
        self._metadata[key] = value

    async def add_user(self, user: User, websocket: Any) -> None:
        """
        Add a user connection to the room.

        Args:
            user: The user joining.
            websocket: The user's WebSocket connection.
        """
        async with self._lock:
            self._connections[user.id] = (user, websocket)

    async def remove_user(self, user_id: str) -> User | None:
        """
        Remove a user from the room.

        Args:
            user_id: The user's ID.

        Returns:
            The removed user, or None if not found.
        """
        async with self._lock:
            connection = self._connections.pop(user_id, None)
            return connection[0] if connection else None

    def get_user(self, user_id: str) -> User | None:
        """Get a user by ID."""
        connection = self._connections.get(user_id)
        return connection[0] if connection else None

    def get_websocket(self, user_id: str) -> Any | None:
        """Get a user's WebSocket connection."""
        connection = self._connections.get(user_id)
        return connection[1] if connection else None

    def has_user(self, user_id: str) -> bool:
        """Check if a user is in the room."""
        return user_id in self._connections

    def apply_operation(self, operation: Operation) -> bool:
        """
        Apply a CRDT operation to the room state.

        Args:
            operation: The operation to apply.

        Returns:
            True if the operation was applied (not a duplicate).
        """
        return self._state.apply(operation)

    def get_operations_since(self, timestamp: float) -> list[Operation]:
        """
        Get all operations since a timestamp.

        Args:
            timestamp: The timestamp to get operations after.

        Returns:
            List of operations.
        """
        return self._state.operations_since(timestamp)

    def get_all_operations(self) -> list[Operation]:
        """Get all operations."""
        return self._state.all_operations()

    def get_state_dict(self) -> dict[str, Any]:
        """Get the full state as a serializable dictionary."""
        return self._state.state()

    def register_function(
        self,
        name: str,
        func: ServerFunction,
        requires_auth: bool = True,
        required_permissions: list[str] | None = None,
    ) -> None:
        """
        Register a server function for this room.

        Args:
            name: The function name clients will use to call it.
            func: The async function to execute.
            requires_auth: Whether authentication is required.
            required_permissions: List of required permissions.
        """
        self._functions[name] = RegisteredFunction(
            name=name,
            func=func,
            requires_auth=requires_auth,
            required_permissions=required_permissions or [],
        )

    def get_function(self, name: str) -> RegisteredFunction | None:
        """Get a registered function by name."""
        return self._functions.get(name)

    def has_function(self, name: str) -> bool:
        """Check if a function is registered."""
        return name in self._functions

    async def call_function(
        self,
        name: str,
        args: list[Any],
        kwargs: dict[str, Any],
        user: User | None = None,
    ) -> Any:
        """
        Call a registered function.

        Args:
            name: The function name.
            args: Positional arguments.
            kwargs: Keyword arguments.
            user: The calling user (for context).

        Returns:
            The function result.

        Raises:
            KeyError: If the function is not registered.
        """
        func_info = self._functions.get(name)
        if not func_info:
            raise KeyError(f"Function '{name}' not registered")

        # Inject context if function accepts it
        kwargs["_room"] = self
        kwargs["_user"] = user

        return await func_info.func(*args, **kwargs)

    async def broadcast(
        self,
        message: Any,
        exclude_user: str | None = None,
        exclude_ws: Any | None = None,
    ) -> None:
        """
        Broadcast a message to all connected users.

        Args:
            message: The message to send (will be JSON serialized).
            exclude_user: Optional user ID to exclude from broadcast.
            exclude_ws: Optional WebSocket to exclude from broadcast.
        """
        if hasattr(message, "model_dump"):
            data = message.model_dump()
        elif hasattr(message, "to_dict"):
            data = message.to_dict()
        else:
            data = message

        failed_users: list[str] = []

        async with self._lock:
            tasks = []
            user_ids = []
            for user_id, (_, websocket) in self._connections.items():
                if user_id != exclude_user and websocket != exclude_ws:
                    tasks.append(self._send_to_websocket(websocket, data))
                    user_ids.append(user_id)

            if tasks:
                results = await asyncio.gather(*tasks, return_exceptions=True)
                for user_id, result in zip(user_ids, results):
                    if isinstance(result, Exception):
                        logger.warning(f"Failed to send to user {user_id}: {result}")
                        failed_users.append(user_id)

        # Clean up failed connections outside the lock
        for user_id in failed_users:
            await self.remove_user(user_id)

    async def _send_to_websocket(self, websocket: Any, data: Any) -> None:
        """Send data to a WebSocket connection."""
        await websocket.send_json(data)


class RoomManager:
    """
    Manages multiple collaborative rooms.

    Provides:
    - Room creation and retrieval
    - Global function registration
    - Operation broadcasting
    - Integration with presence manager
    """

    def __init__(
        self,
        presence_manager: PresenceManager | None = None,
    ):
        """
        Initialize the room manager.

        Args:
            presence_manager: Optional presence manager for tracking users.
        """
        self._rooms: dict[str, Room] = {}
        self._lock = asyncio.Lock()
        self._presence = presence_manager or PresenceManager()

        # Global registered functions (available in all rooms)
        self._global_functions: dict[str, RegisteredFunction] = {}

        # Callbacks
        self._on_room_created: list[Callable[[Room], Awaitable[None]]] = []
        self._on_room_deleted: list[Callable[[str], Awaitable[None]]] = []

    @property
    def presence(self) -> PresenceManager:
        """Get the presence manager."""
        return self._presence

    @property
    def room_count(self) -> int:
        """Get the number of active rooms."""
        return len(self._rooms)

    @property
    def room_ids(self) -> list[str]:
        """Get list of active room IDs."""
        return list(self._rooms.keys())

    async def create_room(
        self,
        room_id: str | None = None,
        initial_state: dict[str, Any] | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> Room:
        """
        Create a new room.

        Args:
            room_id: Optional room ID (generated if not provided).
            initial_state: Optional initial CRDT state.
            metadata: Optional room metadata.

        Returns:
            The created room.
        """
        room_id = room_id or str(uuid.uuid4())

        async with self._lock:
            if room_id in self._rooms:
                return self._rooms[room_id]

            room = Room(room_id, initial_state=initial_state)

            # Copy global functions to room
            for name, func_info in self._global_functions.items():
                room.register_function(
                    name,
                    func_info.func,
                    func_info.requires_auth,
                    func_info.required_permissions,
                )

            if metadata:
                for key, value in metadata.items():
                    room.set_metadata(key, value)

            self._rooms[room_id] = room

        # Notify callbacks
        for callback in self._on_room_created:
            await callback(room)

        return room

    async def get_room(self, room_id: str) -> Room | None:
        """
        Get a room by ID.

        Args:
            room_id: The room ID.

        Returns:
            The room, or None if not found.
        """
        return self._rooms.get(room_id)

    async def get_or_create_room(
        self,
        room_id: str,
        initial_state: dict[str, Any] | None = None,
    ) -> Room:
        """
        Get an existing room or create a new one.

        Args:
            room_id: The room ID.
            initial_state: Optional initial state for new rooms.

        Returns:
            The room.
        """
        room = self._rooms.get(room_id)
        if room:
            return room
        return await self.create_room(room_id, initial_state)

    async def delete_room(self, room_id: str) -> bool:
        """
        Delete a room.

        Args:
            room_id: The room ID.

        Returns:
            True if the room was deleted, False if not found.
        """
        async with self._lock:
            if room_id not in self._rooms:
                return False

            del self._rooms[room_id]

        # Notify callbacks
        for callback in self._on_room_deleted:
            await callback(room_id)

        return True

    def has_room(self, room_id: str) -> bool:
        """Check if a room exists."""
        return room_id in self._rooms

    def register_function(
        self,
        name: str,
        func: ServerFunction,
        requires_auth: bool = True,
        required_permissions: list[str] | None = None,
    ) -> None:
        """
        Register a global server function (available in all rooms).

        Args:
            name: The function name.
            func: The async function.
            requires_auth: Whether authentication is required.
            required_permissions: List of required permissions.
        """
        self._global_functions[name] = RegisteredFunction(
            name=name,
            func=func,
            requires_auth=requires_auth,
            required_permissions=required_permissions or [],
        )

        # Add to existing rooms
        for room in self._rooms.values():
            room.register_function(
                name,
                func,
                requires_auth,
                required_permissions or [],
            )

    def get_function(self, name: str) -> RegisteredFunction | None:
        """Get a global function by name."""
        return self._global_functions.get(name)

    async def broadcast_operation(
        self,
        room_id: str,
        operation: Operation,
        sender_id: str,
        exclude_sender: bool = True,
    ) -> None:
        """
        Broadcast an operation to all users in a room.

        Args:
            room_id: The room ID.
            operation: The operation to broadcast.
            sender_id: The user who sent the operation.
            exclude_sender: Whether to exclude the sender from the broadcast.
        """
        room = self._rooms.get(room_id)
        if not room:
            return

        message = OperationBroadcast(
            room_id=room_id,
            user_id=sender_id,
            operation=operation.to_dict(),
        )

        await room.broadcast(
            message,
            exclude_user=sender_id if exclude_sender else None,
        )

    async def cleanup_empty_rooms(self) -> int:
        """
        Remove all empty rooms.

        Returns:
            Number of rooms removed.
        """
        async with self._lock:
            empty_rooms = [
                room_id
                for room_id, room in self._rooms.items()
                if room.is_empty
            ]

            for room_id in empty_rooms:
                del self._rooms[room_id]

            return len(empty_rooms)

    def on_room_created(self, callback: Callable[[Room], Awaitable[None]]) -> None:
        """Register a callback for room creation events."""
        self._on_room_created.append(callback)

    def on_room_deleted(self, callback: Callable[[str], Awaitable[None]]) -> None:
        """Register a callback for room deletion events."""
        self._on_room_deleted.append(callback)


__all__ = [
    "ServerFunction",
    "RegisteredFunction",
    "Room",
    "RoomManager",
]
