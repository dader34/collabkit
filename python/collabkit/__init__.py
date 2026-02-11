"""
CollabKit - A collaborative toolkit for real-time applications.
"""

from collabkit.crdt import CRDT, LWWMap, LWWRegister, ORSet, GCounter, PNCounter
from collabkit.auth import AuthProvider, AuthToken, AuthUser
from collabkit.permissions import Permission, PermissionManager, Role
from collabkit.storage import StorageBackend, PostgresStorage, MemoryStorage

# Protocol message types
from collabkit.protocol import (
    User,
    # Client messages
    JoinMessage,
    LeaveMessage,
    OperationMessage,
    SyncRequestMessage,
    CallMessage,
    PresenceMessage,
    PingMessage,
    ClientMessage,
    # Server messages
    JoinedMessage,
    OperationBroadcast,
    SyncMessage,
    CallResultMessage,
    PresenceBroadcast,
    UserJoinedMessage,
    UserLeftMessage,
    ErrorMessage,
    PongMessage,
    ServerMessage,
    ErrorCode,
    parse_client_message,
    parse_server_message,
)

# Presence tracking
from collabkit.presence import (
    PresenceData,
    RoomPresence,
    PresenceManager,
)

# Room management
from collabkit.room import (
    Room,
    RoomManager,
    RegisteredFunction,
)

# Server
from collabkit.server import CollabkitServer

__version__ = "0.1.0"

__all__ = [
    # CRDT types
    "CRDT",
    "LWWMap",
    "LWWRegister",
    "ORSet",
    "GCounter",
    "PNCounter",
    # Auth classes
    "AuthProvider",
    "AuthToken",
    "AuthUser",
    # Permission classes
    "Permission",
    "PermissionManager",
    "Role",
    # Storage classes
    "StorageBackend",
    "PostgresStorage",
    "MemoryStorage",
    # Protocol - User
    "User",
    # Protocol - Client messages
    "JoinMessage",
    "LeaveMessage",
    "OperationMessage",
    "SyncRequestMessage",
    "CallMessage",
    "PresenceMessage",
    "PingMessage",
    "ClientMessage",
    # Protocol - Server messages
    "JoinedMessage",
    "OperationBroadcast",
    "SyncMessage",
    "CallResultMessage",
    "PresenceBroadcast",
    "UserJoinedMessage",
    "UserLeftMessage",
    "ErrorMessage",
    "PongMessage",
    "ServerMessage",
    "ErrorCode",
    # Protocol - Parsing
    "parse_client_message",
    "parse_server_message",
    # Presence
    "PresenceData",
    "RoomPresence",
    "PresenceManager",
    # Room
    "Room",
    "RoomManager",
    "RegisteredFunction",
    # Server
    "CollabkitServer",
]
