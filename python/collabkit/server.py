"""
FastAPI WebSocket server for CollabKit.

Provides CollabkitServer class for handling real-time collaborative
sessions over WebSocket connections.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from collections import defaultdict
from contextlib import asynccontextmanager
from typing import Any, Callable, Awaitable, Dict, List, Optional, Set, Union

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.routing import APIRouter
from pydantic import ValidationError

from .auth import AuthProvider, AuthUser
from .crdt.base import Operation
from .permissions import Permission, PermissionManager
from .presence import PresenceManager
from .protocol import (
    User,
    JoinMessage,
    LeaveMessage,
    OperationMessage,
    SyncRequestMessage,
    CallMessage,
    PresenceMessage,
    PingMessage,
    AuthMessage,
    StateUpdateMessage,
    JoinedMessage,
    OperationBroadcast,
    SyncMessage,
    CallResultMessage,
    PresenceBroadcast,
    UserJoinedMessage,
    UserLeftMessage,
    ErrorMessage,
    PongMessage,
    ErrorCode,
    parse_client_message,
    ScreenShareStartMessage,
    ScreenShareStopMessage,
    RtcOfferMessage,
    RtcAnswerMessage,
    RtcIceCandidateMessage,
    RemoteControlRequestMessage,
    RemoteControlResponseMessage,
    ScreenShareStartedBroadcast,
    ScreenShareStoppedBroadcast,
)
from .room import RoomManager, ServerFunction
from .storage import StorageBackend

logger = logging.getLogger(__name__)

# Security constants
MAX_MESSAGE_SIZE = 1024 * 1024  # 1MB max message size
DEFAULT_RATE_LIMIT = 100  # messages per second
DEFAULT_RATE_WINDOW = 1.0  # seconds
DEFAULT_MESSAGE_TIMEOUT = 60.0  # seconds
DEFAULT_FUNCTION_TIMEOUT = 30.0  # seconds - max time for function execution
MAX_CONNECTIONS_PER_USER = 10  # max concurrent connections per user
MAX_AUTH_ATTEMPTS = 5  # max failed auth attempts before lockout
AUTH_LOCKOUT_SECONDS = 300  # 5 minute lockout after max failed attempts


class RateLimiter:
    """Simple token bucket rate limiter per WebSocket connection."""

    def __init__(self, rate: float = DEFAULT_RATE_LIMIT, window: float = DEFAULT_RATE_WINDOW):
        self.rate = rate
        self.window = window
        self._tokens: Dict[int, float] = defaultdict(lambda: rate)
        self._last_update: Dict[int, float] = defaultdict(time.time)

    def is_allowed(self, ws_id: int) -> bool:
        """Check if a request is allowed and consume a token."""
        now = time.time()
        elapsed = now - self._last_update[ws_id]
        self._last_update[ws_id] = now

        self._tokens[ws_id] = min(
            self.rate, self._tokens[ws_id] + elapsed * (self.rate / self.window)
        )

        if self._tokens[ws_id] >= 1:
            self._tokens[ws_id] -= 1
            return True
        return False

    def cleanup(self, ws_id: int) -> None:
        """Clean up state for a disconnected WebSocket."""
        self._tokens.pop(ws_id, None)
        self._last_update.pop(ws_id, None)


class AuthRateLimiter:
    """Rate limiter for authentication attempts to prevent brute force attacks."""

    def __init__(self, max_attempts: int = MAX_AUTH_ATTEMPTS, lockout_seconds: float = AUTH_LOCKOUT_SECONDS):
        self._max_attempts = max_attempts
        self._lockout_seconds = lockout_seconds
        self._attempts: Dict[int, int] = defaultdict(int)
        self._lockout_until: Dict[int, float] = {}

    def is_allowed(self, ws_id: int) -> bool:
        """Check if auth attempt is allowed."""
        now = time.time()
        if ws_id in self._lockout_until:
            if now < self._lockout_until[ws_id]:
                return False
            del self._lockout_until[ws_id]
            self._attempts[ws_id] = 0
        return self._attempts[ws_id] < self._max_attempts

    def record_failure(self, ws_id: int) -> None:
        """Record a failed auth attempt."""
        self._attempts[ws_id] += 1
        if self._attempts[ws_id] >= self._max_attempts:
            self._lockout_until[ws_id] = time.time() + self._lockout_seconds

    def record_success(self, ws_id: int) -> None:
        """Reset attempts on successful auth."""
        self._attempts.pop(ws_id, None)
        self._lockout_until.pop(ws_id, None)

    def cleanup(self, ws_id: int) -> None:
        """Clean up state for a disconnected WebSocket."""
        self._attempts.pop(ws_id, None)
        self._lockout_until.pop(ws_id, None)


class CollabkitServer:
    """
    FastAPI WebSocket server for real-time collaboration.

    Handles:
    - WebSocket connections and message routing
    - Room management (join/leave)
    - CRDT operation synchronization
    - Custom server function calls
    - Presence updates
    - Authentication and authorization
    """

    def __init__(
        self,
        auth_provider: Optional[AuthProvider] = None,
        permission_manager: Optional[PermissionManager] = None,
        storage_backend: Optional[StorageBackend] = None,
        room_manager: Optional[RoomManager] = None,
        presence_manager: Optional[PresenceManager] = None,
        path: str = "/ws",
        require_auth: bool = False,
        allow_anonymous: bool = False,
        auto_create_rooms: bool = True,
        save_on_operation: bool = False,
        rate_limit: float = DEFAULT_RATE_LIMIT,
        max_message_size: int = MAX_MESSAGE_SIZE,
        message_timeout: float = DEFAULT_MESSAGE_TIMEOUT,
        function_timeout: float = DEFAULT_FUNCTION_TIMEOUT,
        max_connections_per_user: int = MAX_CONNECTIONS_PER_USER,
    ):
        self._auth = auth_provider
        self._permissions = permission_manager
        self._storage = storage_backend
        self._presence = presence_manager or PresenceManager()
        self._rooms = room_manager or RoomManager(self._presence)
        self._path = path
        self._require_auth = require_auth
        self._allow_anonymous = allow_anonymous
        self._auto_create_rooms = auto_create_rooms
        self._save_on_operation = save_on_operation
        self._max_message_size = max_message_size
        self._message_timeout = message_timeout
        self._function_timeout = function_timeout
        self._max_connections_per_user = max_connections_per_user

        self._router = APIRouter()
        self._app: Optional[FastAPI] = None
        self._rate_limiter = RateLimiter(rate=rate_limit)
        self._auth_rate_limiter = AuthRateLimiter()

        # Track WebSocket -> User mappings (protected by lock)
        self._ws_lock = asyncio.Lock()
        self._ws_users: Dict[WebSocket, Union[AuthUser, User]] = {}
        self._ws_rooms: Dict[WebSocket, Set[str]] = {}
        self._user_connections: Dict[str, Set[WebSocket]] = defaultdict(set)

        # Track screen share state: room_id -> sharer_user_id
        self._screen_sharers: Dict[str, str] = {}

        self._presence.set_broadcast_callback(self._broadcast_presence)
        self._setup_routes()

    @property
    def app(self) -> FastAPI:
        """Get the FastAPI application with WebSocket routes configured."""
        if self._app is None:
            self._app = FastAPI(lifespan=self._lifespan)
            self._app.include_router(self._router)
        return self._app

    @asynccontextmanager
    async def _lifespan(self, app: FastAPI):
        """Lifespan handler for startup/shutdown events."""
        # Startup: connect storage if available
        if self._storage and hasattr(self._storage, "connect"):
            await self._storage.connect()

        yield

        # Shutdown: disconnect storage if available
        if self._storage and hasattr(self._storage, "disconnect"):
            await self._storage.disconnect()

    @property
    def rooms(self) -> RoomManager:
        """Get the room manager."""
        return self._rooms

    @property
    def presence(self) -> PresenceManager:
        """Get the presence manager."""
        return self._presence

    def _setup_routes(self) -> None:
        """Setup WebSocket route."""
        @self._router.websocket(self._path)
        async def websocket_endpoint(websocket: WebSocket):
            await self._handle_connection(websocket)

    def mount(self, app: FastAPI, prefix: str = "") -> None:
        """Mount the CollabKit server on a FastAPI application."""
        self._app = app
        app.include_router(self._router, prefix=prefix)

    def register_function(
        self,
        name: Optional[str] = None,
        requires_auth: bool = True,
        required_permissions: Optional[List[str]] = None,
    ) -> Callable[[ServerFunction], ServerFunction]:
        """Decorator to register a server function."""
        def decorator(func: ServerFunction) -> ServerFunction:
            self._rooms.register_function(
                name or func.__name__, func, requires_auth, required_permissions
            )
            return func
        return decorator

    def _get_user_id(self, user: Union[AuthUser, User]) -> str:
        """Get user ID from either AuthUser or User."""
        return user.id if isinstance(user, AuthUser) else user.id

    def _auth_user_to_protocol_user(self, user: Union[AuthUser, User]) -> User:
        """Convert AuthUser to protocol User."""
        if isinstance(user, AuthUser):
            return User(id=user.id, name=user.name, metadata=user.metadata or {})
        return user

    async def _handle_connection(self, websocket: WebSocket) -> None:
        """Handle a new WebSocket connection."""
        await websocket.accept()

        async with self._ws_lock:
            self._ws_rooms[websocket] = set()

        ws_id = id(websocket)

        try:
            while True:
                if not self._rate_limiter.is_allowed(ws_id):
                    await self._send_error(websocket, ErrorCode.RATE_LIMITED, "Rate limit exceeded.")
                    continue

                try:
                    raw_data = await asyncio.wait_for(
                        websocket.receive_text(), timeout=self._message_timeout
                    )
                except asyncio.TimeoutError:
                    # Send a ping to check if the connection is still alive
                    try:
                        await websocket.send_json({"type": "ping"})
                    except Exception:
                        break
                    continue

                if len(raw_data) > self._max_message_size:
                    await self._send_error(websocket, ErrorCode.INVALID_MESSAGE, "Message too large.")
                    continue

                try:
                    data = json.loads(raw_data)
                except json.JSONDecodeError:
                    await self._send_error(websocket, ErrorCode.INVALID_MESSAGE, "Invalid JSON.")
                    continue

                await self._handle_message(websocket, data)

        except WebSocketDisconnect:
            pass
        except Exception:
            logger.exception("WebSocket error")
            await self._send_error(websocket, ErrorCode.INTERNAL_ERROR, "Internal error.")
        finally:
            self._rate_limiter.cleanup(ws_id)
            self._auth_rate_limiter.cleanup(ws_id)
            await self._cleanup_connection(websocket)

    async def _handle_message(self, websocket: WebSocket, data: Dict[str, Any]) -> None:
        """Handle an incoming message."""
        try:
            message = parse_client_message(data)
        except (ValueError, ValidationError):
            await self._send_error(websocket, ErrorCode.INVALID_MESSAGE, "Invalid message format.")
            return

        handlers = {
            "join": self._handle_join,
            "leave": self._handle_leave,
            "operation": self._handle_operation,
            "state_update": self._handle_state_update,
            "sync_request": self._handle_sync_request,
            "call": self._handle_call,
            "presence": self._handle_presence,
            "ping": self._handle_ping,
            "auth": self._handle_auth,
            "screenshare_start": self._handle_screenshare_start,
            "screenshare_stop": self._handle_screenshare_stop,
            "rtc_offer": self._handle_rtc_offer,
            "rtc_answer": self._handle_rtc_answer,
            "rtc_ice_candidate": self._handle_rtc_ice_candidate,
            "remote_control_request": self._handle_remote_control_request,
            "remote_control_response": self._handle_remote_control_response,
        }

        handler = handlers.get(message.type)
        if handler:
            await handler(websocket, message)
        else:
            await self._send_error(websocket, ErrorCode.INVALID_MESSAGE, f"Unknown message type: {message.type}")

    async def _handle_join(self, websocket: WebSocket, message: JoinMessage) -> None:
        """Handle join room request."""
        room_id = message.room_id
        ws_id = id(websocket)

        async with self._ws_lock:
            user: Optional[Union[AuthUser, User]] = self._ws_users.get(websocket)

        # Authenticate with provided token
        if message.token and self._auth:
            if not self._auth_rate_limiter.is_allowed(ws_id):
                await self._send_error(websocket, ErrorCode.RATE_LIMITED, "Too many auth attempts. Try again later.")
                return

            auth_user = await self._auth.validate_token(message.token)
            if auth_user:
                self._auth_rate_limiter.record_success(ws_id)
                user = auth_user
            else:
                # Token was provided but invalid - reject (don't fall through to anonymous)
                self._auth_rate_limiter.record_failure(ws_id)
                await self._send_error(websocket, ErrorCode.AUTHENTICATION_FAILED, "Invalid authentication token.")
                return

        # If auth is required but user not authenticated, reject
        if self._require_auth and not isinstance(user, AuthUser):
            await self._send_error(websocket, ErrorCode.AUTHENTICATION_FAILED, "Authentication required.")
            return

        # Create anonymous user only if explicitly allowed
        if not user:
            if not self._allow_anonymous:
                await self._send_error(websocket, ErrorCode.AUTHENTICATION_FAILED, "Authentication required.")
                return
            # Use secure random UUID instead of predictable id(websocket)
            anon_id = f"anon-{uuid.uuid4().hex[:16]}"
            user = User(id=anon_id, name="Anonymous")

        user_id = self._get_user_id(user)

        # Check connection limit (atomic check-and-add)
        async with self._ws_lock:
            if len(self._user_connections[user_id]) >= self._max_connections_per_user:
                await self._send_error(websocket, ErrorCode.RATE_LIMITED, "Too many connections.")
                return
            self._ws_users[websocket] = user
            self._user_connections[user_id].add(websocket)

        # Check permissions (default deny if no permission manager and require_auth is set)
        if self._permissions:
            if not self._permissions.check_permission(user_id, room_id, Permission.READ):
                await self._send_error(websocket, ErrorCode.PERMISSION_DENIED, "Permission denied to join room.")
                return

        # Get or create room
        room = await self._rooms.get_room(room_id)
        if not room:
            if self._auto_create_rooms:
                initial_state = None
                if self._storage:
                    stored = await self._storage.load(f"room:{room_id}")
                    if stored:
                        initial_state = stored.get("state")
                room = await self._rooms.create_room(room_id, initial_state)
            else:
                await self._send_error(websocket, ErrorCode.ROOM_NOT_FOUND, f"Room '{room_id}' not found.")
                return

        protocol_user = self._auth_user_to_protocol_user(user)

        await room.add_user(protocol_user, websocket)
        async with self._ws_lock:
            self._ws_rooms[websocket].add(room_id)
        await self._presence.join_room(room_id, protocol_user)

        response = JoinedMessage(
            room_id=room_id, user_id=protocol_user.id, users=room.users, state=room.value
        )
        await websocket.send_json(response.model_dump())

        broadcast = UserJoinedMessage(room_id=room_id, user=protocol_user)
        await room.broadcast(broadcast, exclude_user=protocol_user.id)

    async def _handle_leave(self, websocket: WebSocket, message: LeaveMessage) -> None:
        """Handle leave room request."""
        room_id = message.room_id

        async with self._ws_lock:
            user = self._ws_users.get(websocket)
        if not user:
            return

        user_id = self._get_user_id(user)
        await self._leave_room(websocket, room_id, user_id)

    async def _leave_room(self, websocket: WebSocket, room_id: str, user_id: str) -> None:
        """Leave a room and broadcast the departure."""
        room = await self._rooms.get_room(room_id)
        if room:
            await room.remove_user(user_id)
            await self._presence.leave_room(room_id, user_id)
            await room.broadcast(UserLeftMessage(room_id=room_id, user_id=user_id))

            if self._storage:
                await self._storage.save(
                    f"room:{room_id}",
                    {"state": room.value, "operations": [op.to_dict() for op in room.get_all_operations()]},
                )

        async with self._ws_lock:
            if websocket in self._ws_rooms:
                self._ws_rooms[websocket].discard(room_id)

    async def _handle_operation(self, websocket: WebSocket, message: OperationMessage) -> None:
        """Handle CRDT operation."""
        room_id = message.room_id

        async with self._ws_lock:
            user = self._ws_users.get(websocket)
        if not user:
            await self._send_error(websocket, ErrorCode.AUTHENTICATION_FAILED, "Not authenticated.")
            return

        user_id = self._get_user_id(user)

        if self._permissions and not self._permissions.check_permission(user_id, room_id, Permission.WRITE):
            await self._send_error(websocket, ErrorCode.PERMISSION_DENIED, "Permission denied to write.")
            return

        room = await self._rooms.get_room(room_id)
        if not room:
            await self._send_error(websocket, ErrorCode.ROOM_NOT_FOUND, f"Room '{room_id}' not found.")
            return

        try:
            operation = Operation.from_dict(message.operation)
            if room.apply_operation(operation):
                await self._rooms.broadcast_operation(room_id, operation, user_id, exclude_sender=True)
                if self._save_on_operation and self._storage:
                    await self._storage.save(
                        f"room:{room_id}",
                        {"state": room.value, "operations": [op.to_dict() for op in room.get_all_operations()]},
                    )
        except Exception:
            logger.exception("Operation error")
            await self._send_error(websocket, ErrorCode.INVALID_OPERATION, "Invalid operation.")

    async def _handle_state_update(self, websocket: WebSocket, message: StateUpdateMessage) -> None:
        """Handle direct state update (legacy non-CRDT mode)."""
        room_id = message.room_id

        async with self._ws_lock:
            user = self._ws_users.get(websocket)
        if not user:
            await self._send_error(websocket, ErrorCode.AUTHENTICATION_FAILED, "Not authenticated.")
            return

        user_id = self._get_user_id(user)

        if self._permissions and not self._permissions.check_permission(user_id, room_id, Permission.WRITE):
            await self._send_error(websocket, ErrorCode.PERMISSION_DENIED, "Permission denied to write.")
            return

        room = await self._rooms.get_room(room_id)
        if not room:
            await self._send_error(websocket, ErrorCode.ROOM_NOT_FOUND, f"Room '{room_id}' not found.")
            return

        path = message.path.split(".") if message.path else []
        operation = room.state.set(path, message.value, user_id)

        broadcast = OperationBroadcast(room_id=room_id, user_id=user_id, operation=operation.to_dict())
        await room.broadcast(broadcast, exclude_ws=websocket)

        if self._storage:
            await self._storage.save(
                f"room:{room_id}",
                {"state": room.value, "operations": [op.to_dict() for op in room.get_all_operations()]},
            )

    async def _handle_sync_request(self, websocket: WebSocket, message: SyncRequestMessage) -> None:
        """Handle sync request."""
        room_id = message.room_id

        async with self._ws_lock:
            user = self._ws_users.get(websocket)
            user_rooms = self._ws_rooms.get(websocket, set())

        if not user:
            await self._send_error(websocket, ErrorCode.AUTHENTICATION_FAILED, "Not authenticated.")
            return

        user_id = self._get_user_id(user)

        if self._permissions and not self._permissions.check_permission(user_id, room_id, Permission.READ):
            await self._send_error(websocket, ErrorCode.PERMISSION_DENIED, "Permission denied to read room.")
            return

        if room_id not in user_rooms:
            await self._send_error(websocket, ErrorCode.PERMISSION_DENIED, "Must join room before requesting sync.")
            return

        room = await self._rooms.get_room(room_id)
        if not room:
            await self._send_error(websocket, ErrorCode.ROOM_NOT_FOUND, f"Room '{room_id}' not found.")
            return

        operations = room.get_operations_since(message.since_timestamp)
        response = SyncMessage(
            room_id=room_id,
            state=room.value,
            operations=[op.to_dict() for op in operations],
            version_vector=room.state._version_vector.to_dict(),
        )
        await websocket.send_json(response.model_dump())

    async def _handle_call(self, websocket: WebSocket, message: CallMessage) -> None:
        """Handle function call."""
        room_id = message.room_id

        async with self._ws_lock:
            user = self._ws_users.get(websocket)
            user_rooms = self._ws_rooms.get(websocket, set())

        # Must be in room to call functions
        if room_id not in user_rooms:
            await websocket.send_json(CallResultMessage(
                call_id=message.call_id, success=False, error="Must join room before calling functions."
            ).model_dump())
            return

        room = await self._rooms.get_room(room_id)
        if not room:
            await websocket.send_json(CallResultMessage(
                call_id=message.call_id, success=False, error=f"Room '{room_id}' not found."
            ).model_dump())
            return

        func_info = room.get_function(message.function_name)
        if not func_info:
            await websocket.send_json(CallResultMessage(
                call_id=message.call_id, success=False, error=f"Function '{message.function_name}' not found."
            ).model_dump())
            return

        # Check auth requirement - requires authenticated user (AuthUser), not just any user
        if func_info.requires_auth and not isinstance(user, AuthUser):
            await websocket.send_json(CallResultMessage(
                call_id=message.call_id, success=False, error="Authentication required."
            ).model_dump())
            return

        if func_info.required_permissions and self._permissions and user:
            user_id = self._get_user_id(user)
            for perm in func_info.required_permissions:
                if not self._permissions.check_permission(user_id, room_id, Permission(perm)):
                    await websocket.send_json(CallResultMessage(
                        call_id=message.call_id, success=False, error=f"Permission denied: {perm}"
                    ).model_dump())
                    return

        try:
            protocol_user = self._auth_user_to_protocol_user(user) if user else None
            # Add timeout to prevent hanging functions
            result = await asyncio.wait_for(
                room.call_function(message.function_name, message.args, message.kwargs, protocol_user),
                timeout=self._function_timeout
            )
            response = CallResultMessage(call_id=message.call_id, success=True, result=result)
        except asyncio.TimeoutError:
            logger.warning(f"Function call timeout: {message.function_name}")
            response = CallResultMessage(call_id=message.call_id, success=False, error="Function execution timeout.")
        except Exception:
            logger.exception(f"Function call error: {message.function_name}")
            response = CallResultMessage(call_id=message.call_id, success=False, error="Function execution failed.")

        await websocket.send_json(response.model_dump())

    async def _handle_presence(self, websocket: WebSocket, message: PresenceMessage) -> None:
        """Handle presence update."""
        async with self._ws_lock:
            user = self._ws_users.get(websocket)
            user_rooms = self._ws_rooms.get(websocket, set())

        if not user:
            return

        # Only allow presence updates in rooms the user has joined
        if message.room_id not in user_rooms:
            await self._send_error(websocket, ErrorCode.PERMISSION_DENIED, "Must join room before updating presence.")
            return

        await self._presence.update_presence(message.room_id, self._get_user_id(user), message.data)

    async def _handle_ping(self, websocket: WebSocket, message: PingMessage) -> None:
        """Handle ping message."""
        await websocket.send_json(PongMessage(timestamp=time.time()).model_dump())

    async def _handle_auth(self, websocket: WebSocket, message: AuthMessage) -> None:
        """Handle authentication message (preferred over URL token for security)."""
        if not self._auth:
            await self._send_error(websocket, ErrorCode.AUTHENTICATION_FAILED, "Authentication not configured.")
            return

        ws_id = id(websocket)

        # Rate limit auth attempts to prevent brute force
        if not self._auth_rate_limiter.is_allowed(ws_id):
            await self._send_error(websocket, ErrorCode.RATE_LIMITED, "Too many auth attempts. Try again later.")
            return

        user = await self._auth.validate_token(message.token)
        if user:
            self._auth_rate_limiter.record_success(ws_id)
            user_id = self._get_user_id(user)

            # Atomic check-and-add for connection limit
            async with self._ws_lock:
                if len(self._user_connections[user_id]) >= self._max_connections_per_user:
                    await self._send_error(websocket, ErrorCode.RATE_LIMITED, "Too many connections.")
                    return
                self._ws_users[websocket] = user
                self._user_connections[user_id].add(websocket)

            await websocket.send_json({"type": "authenticated", "user_id": user_id})
        else:
            self._auth_rate_limiter.record_failure(ws_id)
            await self._send_error(websocket, ErrorCode.AUTHENTICATION_FAILED, "Invalid authentication token.")

    # =========================================================================
    # Screen Share / WebRTC Signaling Handlers
    # =========================================================================

    async def _handle_screenshare_start(
        self, websocket: WebSocket, message: ScreenShareStartMessage
    ) -> None:
        """Handle screen share start request."""
        room_id = message.room_id

        async with self._ws_lock:
            user = self._ws_users.get(websocket)
            user_rooms = self._ws_rooms.get(websocket, set())
        if not user:
            await self._send_error(websocket, ErrorCode.AUTHENTICATION_FAILED, "Not authenticated.")
            return
        if room_id not in user_rooms:
            await self._send_error(websocket, ErrorCode.PERMISSION_DENIED, "Must join room first.")
            return

        user_id = self._get_user_id(user)

        # Only one sharer per room
        if room_id in self._screen_sharers:
            existing = self._screen_sharers[room_id]
            if existing != user_id:
                await self._send_error(
                    websocket, ErrorCode.PERMISSION_DENIED,
                    "Another user is already sharing in this room."
                )
                return

        self._screen_sharers[room_id] = user_id

        room = await self._rooms.get_room(room_id)
        if room:
            broadcast = ScreenShareStartedBroadcast(
                room_id=room_id,
                user_id=user_id,
                share_name=message.share_name,
            )
            await room.broadcast(broadcast)

    async def _handle_screenshare_stop(
        self, websocket: WebSocket, message: ScreenShareStopMessage
    ) -> None:
        """Handle screen share stop request."""
        room_id = message.room_id

        async with self._ws_lock:
            user = self._ws_users.get(websocket)
        if not user:
            return

        user_id = self._get_user_id(user)

        # Only the current sharer can stop
        if self._screen_sharers.get(room_id) != user_id:
            return

        del self._screen_sharers[room_id]

        room = await self._rooms.get_room(room_id)
        if room:
            broadcast = ScreenShareStoppedBroadcast(
                room_id=room_id,
                user_id=user_id,
            )
            await room.broadcast(broadcast)

    async def _handle_rtc_offer(
        self, websocket: WebSocket, message: RtcOfferMessage
    ) -> None:
        """Relay WebRTC offer to target user."""
        room_id = message.room_id

        async with self._ws_lock:
            user = self._ws_users.get(websocket)
        if not user:
            return

        user_id = self._get_user_id(user)

        room = await self._rooms.get_room(room_id)
        if not room:
            return

        target_ws = room.get_websocket(message.target_user_id)
        if target_ws:
            try:
                await target_ws.send_json({
                    "type": "rtc_offer",
                    "room_id": room_id,
                    "from_user_id": user_id,
                    "sdp": message.sdp,
                })
            except Exception:
                logger.debug(f"Failed to relay rtc_offer to {message.target_user_id}")

    async def _handle_rtc_answer(
        self, websocket: WebSocket, message: RtcAnswerMessage
    ) -> None:
        """Relay WebRTC answer to target user."""
        room_id = message.room_id

        async with self._ws_lock:
            user = self._ws_users.get(websocket)
        if not user:
            return

        user_id = self._get_user_id(user)

        room = await self._rooms.get_room(room_id)
        if not room:
            return

        target_ws = room.get_websocket(message.target_user_id)
        if target_ws:
            try:
                await target_ws.send_json({
                    "type": "rtc_answer",
                    "room_id": room_id,
                    "from_user_id": user_id,
                    "sdp": message.sdp,
                })
            except Exception:
                logger.debug(f"Failed to relay rtc_answer to {message.target_user_id}")

    async def _handle_rtc_ice_candidate(
        self, websocket: WebSocket, message: RtcIceCandidateMessage
    ) -> None:
        """Relay ICE candidate to target user."""
        room_id = message.room_id

        async with self._ws_lock:
            user = self._ws_users.get(websocket)
        if not user:
            return

        user_id = self._get_user_id(user)

        room = await self._rooms.get_room(room_id)
        if not room:
            return

        target_ws = room.get_websocket(message.target_user_id)
        if target_ws:
            try:
                await target_ws.send_json({
                    "type": "rtc_ice_candidate",
                    "room_id": room_id,
                    "from_user_id": user_id,
                    "candidate": message.candidate,
                    "sdp_mid": message.sdp_mid,
                    "sdp_m_line_index": message.sdp_m_line_index,
                })
            except Exception:
                logger.debug(f"Failed to relay ice candidate to {message.target_user_id}")

    async def _handle_remote_control_request(
        self, websocket: WebSocket, message: RemoteControlRequestMessage
    ) -> None:
        """Relay remote control request to target user."""
        room_id = message.room_id

        async with self._ws_lock:
            user = self._ws_users.get(websocket)
        if not user:
            return

        user_id = self._get_user_id(user)
        room = await self._rooms.get_room(room_id)
        if not room:
            return

        target_ws = room.get_websocket(message.target_user_id)
        if target_ws:
            try:
                await target_ws.send_json({
                    "type": "remote_control_request",
                    "room_id": room_id,
                    "from_user_id": user_id,
                })
            except Exception:
                pass

    async def _handle_remote_control_response(
        self, websocket: WebSocket, message: RemoteControlResponseMessage
    ) -> None:
        """Relay remote control response to target user."""
        room_id = message.room_id

        async with self._ws_lock:
            user = self._ws_users.get(websocket)
        if not user:
            return

        user_id = self._get_user_id(user)
        room = await self._rooms.get_room(room_id)
        if not room:
            return

        target_ws = room.get_websocket(message.target_user_id)
        if target_ws:
            try:
                await target_ws.send_json({
                    "type": "remote_control_response",
                    "room_id": room_id,
                    "from_user_id": user_id,
                    "granted": message.granted,
                })
            except Exception:
                pass

    async def _broadcast_presence(self, room_id: str, message: PresenceBroadcast) -> None:
        """Broadcast presence update to room."""
        room = await self._rooms.get_room(room_id)
        if room:
            await room.broadcast(message, exclude_user=message.user_id)

    async def _send_error(
        self, websocket: WebSocket, code: ErrorCode, message: str, details: Optional[Dict[str, Any]] = None
    ) -> None:
        """Send an error message to a WebSocket."""
        try:
            await websocket.send_json(ErrorMessage(code=code.value, message=message, details=details).model_dump())
        except Exception:
            logger.debug("Failed to send error message to WebSocket")

    async def _cleanup_connection(self, websocket: WebSocket) -> None:
        """Clean up a disconnected WebSocket."""
        async with self._ws_lock:
            user = self._ws_users.pop(websocket, None)
            rooms = self._ws_rooms.pop(websocket, set())

            if user:
                user_id = self._get_user_id(user)
                self._user_connections[user_id].discard(websocket)
                if not self._user_connections[user_id]:
                    del self._user_connections[user_id]

        if not user:
            return

        user_id = self._get_user_id(user)
        for room_id in rooms:
            # Clean up screen share state if this user was sharing
            if self._screen_sharers.get(room_id) == user_id:
                del self._screen_sharers[room_id]
                room = await self._rooms.get_room(room_id)
                if room:
                    await room.broadcast(
                        ScreenShareStoppedBroadcast(room_id=room_id, user_id=user_id)
                    )

            await self._leave_room(websocket, room_id, user_id)

    async def start(self) -> None:
        """Start background tasks."""
        await self._presence.start()

    async def stop(self) -> None:
        """Stop background tasks and cleanup."""
        await self._presence.stop()


__all__ = ["CollabkitServer"]
