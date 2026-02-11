"""
WebSocket protocol message types for CollabKit.

Defines all client and server message types using Pydantic models
for validation and serialization.
"""

from __future__ import annotations

from enum import Enum
from typing import Any, Dict, List, Literal, Optional, Union
from pydantic import BaseModel, Field, field_validator, ConfigDict

# Maximum lengths for string fields to prevent DoS
MAX_ID_LENGTH = 256
MAX_NAME_LENGTH = 512
MAX_PATH_LENGTH = 1024
MAX_ARGS_COUNT = 100
MAX_METADATA_DEPTH = 5  # Reduced from 10 to prevent deep recursion
MAX_VALUE_SIZE = 1024 * 100  # 100KB max for individual values
MAX_PRESENCE_DATA_SIZE = 1024 * 10  # 10KB max for presence data


# =============================================================================
# User Model
# =============================================================================


import json as _json


def _estimate_size(v: Any) -> int:
    """Estimate the serialized size of a value."""
    try:
        return len(_json.dumps(v))
    except (TypeError, ValueError):
        return 0


def _validate_no_prototype_pollution(
    v: Any, field_name: str = "value", depth: int = 0, max_size: int = MAX_VALUE_SIZE
) -> Any:
    """Recursively validate that no prototype pollution keys exist and check size limits."""
    if depth > MAX_METADATA_DEPTH:
        raise ValueError(f"Maximum nesting depth ({MAX_METADATA_DEPTH}) exceeded in {field_name}")

    # Check size at top level only to avoid repeated serialization
    if depth == 0 and max_size > 0:
        size = _estimate_size(v)
        if size > max_size:
            raise ValueError(f"Value too large ({size} bytes, max {max_size}) in {field_name}")

    DANGEROUS_KEYS = {"__proto__", "constructor", "prototype", "__class__", "__init__", "__new__", "__dict__"}

    if isinstance(v, dict):
        for key in v.keys():
            if not isinstance(key, str):
                raise ValueError(f"Non-string key not allowed in {field_name}")
            if key in DANGEROUS_KEYS:
                raise ValueError(f"Dangerous key '{key}' not allowed in {field_name}")
            if key.startswith("_"):
                raise ValueError(f"Keys starting with underscore not allowed in {field_name}")
            _validate_no_prototype_pollution(v[key], f"{field_name}.{key}", depth + 1, max_size=0)
    elif isinstance(v, list):
        for i, item in enumerate(v):
            _validate_no_prototype_pollution(item, f"{field_name}[{i}]", depth + 1, max_size=0)
    return v


class User(BaseModel):
    """Represents a user in a collaborative session."""

    model_config = ConfigDict(str_max_length=MAX_NAME_LENGTH)

    id: str = Field(..., max_length=MAX_ID_LENGTH)
    name: str = Field(..., max_length=MAX_NAME_LENGTH)
    metadata: Dict[str, Any] = Field(default_factory=dict)

    @field_validator("metadata")
    @classmethod
    def validate_metadata(cls, v: Dict[str, Any]) -> Dict[str, Any]:
        return _validate_no_prototype_pollution(v, "metadata")


# =============================================================================
# Client Message Types
# =============================================================================


class JoinMessage(BaseModel):
    """Client requests to join a room."""

    type: Literal["join"] = "join"
    room_id: str = Field(..., min_length=1, max_length=MAX_ID_LENGTH)
    token: Optional[str] = Field(None, max_length=MAX_ID_LENGTH * 4)
    user_info: Optional[Dict[str, Any]] = None

    @field_validator("user_info")
    @classmethod
    def validate_user_info(cls, v: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
        if v is not None:
            return _validate_no_prototype_pollution(v, "user_info")
        return v


class LeaveMessage(BaseModel):
    """Client requests to leave a room."""

    type: Literal["leave"] = "leave"
    room_id: str = Field(..., min_length=1, max_length=MAX_ID_LENGTH)


class OperationMessage(BaseModel):
    """Client sends a CRDT operation."""

    type: Literal["operation"] = "operation"
    room_id: str = Field(..., min_length=1, max_length=MAX_ID_LENGTH)
    operation: Dict[str, Any]

    @field_validator("operation")
    @classmethod
    def validate_operation(cls, v: Dict[str, Any]) -> Dict[str, Any]:
        # Validate path if present
        if "path" in v:
            path = v["path"]
            if isinstance(path, list):
                DANGEROUS_KEYS = {"__proto__", "constructor", "prototype", "__class__"}
                for segment in path:
                    if isinstance(segment, str) and segment in DANGEROUS_KEYS:
                        raise ValueError(f"Dangerous path segment '{segment}' not allowed")
        return _validate_no_prototype_pollution(v, "operation")


class SyncRequestMessage(BaseModel):
    """Client requests state synchronization."""

    type: Literal["sync_request"] = "sync_request"
    room_id: str = Field(..., min_length=1, max_length=MAX_ID_LENGTH)
    since_timestamp: float = 0.0
    version_vector: Optional[Dict[str, float]] = None


class CallMessage(BaseModel):
    """Client calls a registered server function."""

    type: Literal["call"] = "call"
    room_id: str = Field(..., min_length=1, max_length=MAX_ID_LENGTH)
    call_id: str = Field(..., min_length=1, max_length=MAX_ID_LENGTH)
    function_name: str = Field(..., min_length=1, max_length=MAX_NAME_LENGTH, pattern=r"^[a-zA-Z_][a-zA-Z0-9_]*$")
    args: List[Any] = Field(default_factory=list, max_length=MAX_ARGS_COUNT)
    kwargs: Dict[str, Any] = Field(default_factory=dict)

    @field_validator("args")
    @classmethod
    def validate_args(cls, v: List[Any]) -> List[Any]:
        return _validate_no_prototype_pollution(v, "args")

    @field_validator("kwargs")
    @classmethod
    def validate_kwargs(cls, v: Dict[str, Any]) -> Dict[str, Any]:
        return _validate_no_prototype_pollution(v, "kwargs")


class PresenceMessage(BaseModel):
    """Client sends presence update."""

    type: Literal["presence"] = "presence"
    room_id: str = Field(..., min_length=1, max_length=MAX_ID_LENGTH)
    data: Dict[str, Any]

    @field_validator("data")
    @classmethod
    def validate_data(cls, v: Dict[str, Any]) -> Dict[str, Any]:
        return _validate_no_prototype_pollution(v, "data", max_size=MAX_PRESENCE_DATA_SIZE)


class PingMessage(BaseModel):
    """Client sends ping to keep connection alive."""

    type: Literal["ping"] = "ping"
    timestamp: Optional[float] = None


class AuthMessage(BaseModel):
    """Client sends authentication token (alternative to URL query param)."""

    type: Literal["auth"] = "auth"
    token: str = Field(..., max_length=MAX_ID_LENGTH * 4)


class StateUpdateMessage(BaseModel):
    """Client sends a direct state update (legacy non-CRDT mode)."""

    model_config = ConfigDict(populate_by_name=True)

    type: Literal["state_update"] = "state_update"
    room_id: str = Field(..., alias="roomId", min_length=1, max_length=MAX_ID_LENGTH)
    path: Optional[str] = Field(None, max_length=MAX_PATH_LENGTH)
    value: Any = None

    @field_validator("path")
    @classmethod
    def validate_path(cls, v: Optional[str]) -> Optional[str]:
        if v is not None:
            DANGEROUS_KEYS = {"__proto__", "constructor", "prototype", "__class__"}
            for segment in v.split("."):
                if segment in DANGEROUS_KEYS:
                    raise ValueError(f"Dangerous path segment '{segment}' not allowed")
        return v

    @field_validator("value")
    @classmethod
    def validate_value(cls, v: Any) -> Any:
        return _validate_no_prototype_pollution(v, "value")


# =============================================================================
# Screen Share / WebRTC Signaling - Client Messages
# =============================================================================


class ScreenShareStartMessage(BaseModel):
    """Client starts sharing screen in a room."""

    type: Literal["screenshare_start"] = "screenshare_start"
    room_id: str = Field(..., min_length=1, max_length=MAX_ID_LENGTH)
    share_name: Optional[str] = Field(None, max_length=MAX_NAME_LENGTH)


class ScreenShareStopMessage(BaseModel):
    """Client stops sharing screen."""

    type: Literal["screenshare_stop"] = "screenshare_stop"
    room_id: str = Field(..., min_length=1, max_length=MAX_ID_LENGTH)


class RtcOfferMessage(BaseModel):
    """Client sends WebRTC SDP offer to a specific user."""

    type: Literal["rtc_offer"] = "rtc_offer"
    room_id: str = Field(..., min_length=1, max_length=MAX_ID_LENGTH)
    target_user_id: str = Field(..., min_length=1, max_length=MAX_ID_LENGTH)
    sdp: str = Field(..., max_length=65536)


class RtcAnswerMessage(BaseModel):
    """Client sends WebRTC SDP answer to a specific user."""

    type: Literal["rtc_answer"] = "rtc_answer"
    room_id: str = Field(..., min_length=1, max_length=MAX_ID_LENGTH)
    target_user_id: str = Field(..., min_length=1, max_length=MAX_ID_LENGTH)
    sdp: str = Field(..., max_length=65536)


class RtcIceCandidateMessage(BaseModel):
    """Client sends ICE candidate to a specific user."""

    type: Literal["rtc_ice_candidate"] = "rtc_ice_candidate"
    room_id: str = Field(..., min_length=1, max_length=MAX_ID_LENGTH)
    target_user_id: str = Field(..., min_length=1, max_length=MAX_ID_LENGTH)
    candidate: str = Field(..., max_length=4096)
    sdp_mid: Optional[str] = Field(None, max_length=256)
    sdp_m_line_index: Optional[int] = None


class RemoteControlRequestMessage(BaseModel):
    """Client requests remote control of another user's screen."""

    type: Literal["remote_control_request"] = "remote_control_request"
    room_id: str = Field(..., min_length=1, max_length=MAX_ID_LENGTH)
    target_user_id: str = Field(..., min_length=1, max_length=MAX_ID_LENGTH)


class RemoteControlResponseMessage(BaseModel):
    """Client responds to a remote control request."""

    type: Literal["remote_control_response"] = "remote_control_response"
    room_id: str = Field(..., min_length=1, max_length=MAX_ID_LENGTH)
    target_user_id: str = Field(..., min_length=1, max_length=MAX_ID_LENGTH)
    granted: bool


# Union of all client message types
ClientMessage = Union[
    JoinMessage,
    LeaveMessage,
    OperationMessage,
    SyncRequestMessage,
    CallMessage,
    PresenceMessage,
    PingMessage,
    AuthMessage,
    StateUpdateMessage,
    ScreenShareStartMessage,
    ScreenShareStopMessage,
    RtcOfferMessage,
    RtcAnswerMessage,
    RtcIceCandidateMessage,
    RemoteControlRequestMessage,
    RemoteControlResponseMessage,
]


# =============================================================================
# Server Message Types
# =============================================================================


class JoinedMessage(BaseModel):
    """Server confirms client joined a room."""

    type: Literal["joined"] = "joined"
    room_id: str
    user_id: str
    users: List[User]
    state: Dict[str, Any]


class OperationBroadcast(BaseModel):
    """Server broadcasts an operation to room members."""

    type: Literal["operation"] = "operation"
    room_id: str
    user_id: str
    operation: Dict[str, Any]


class SyncMessage(BaseModel):
    """Server sends state sync data."""

    type: Literal["sync"] = "sync"
    room_id: str
    state: Dict[str, Any]
    operations: List[Dict[str, Any]] = Field(default_factory=list)
    version_vector: Dict[str, float] = Field(default_factory=dict)


class CallResultMessage(BaseModel):
    """Server sends result of a function call."""

    type: Literal["call_result"] = "call_result"
    call_id: str
    success: bool
    result: Optional[Any] = None
    error: Optional[str] = None


class PresenceBroadcast(BaseModel):
    """Server broadcasts presence update to room members."""

    type: Literal["presence"] = "presence"
    room_id: str
    user_id: str
    data: Dict[str, Any]


class UserJoinedMessage(BaseModel):
    """Server notifies that a user joined the room."""

    type: Literal["user_joined"] = "user_joined"
    room_id: str
    user: User


class UserLeftMessage(BaseModel):
    """Server notifies that a user left the room."""

    type: Literal["user_left"] = "user_left"
    room_id: str
    user_id: str


class ErrorMessage(BaseModel):
    """Server sends an error message."""

    type: Literal["error"] = "error"
    code: str
    message: str
    details: Optional[Dict[str, Any]] = None


class PongMessage(BaseModel):
    """Server responds to ping."""

    type: Literal["pong"] = "pong"
    timestamp: float


# =============================================================================
# Screen Share / WebRTC Signaling - Server Messages
# =============================================================================


class ScreenShareStartedBroadcast(BaseModel):
    """Server broadcasts that a user started sharing."""

    type: Literal["screenshare_started"] = "screenshare_started"
    room_id: str
    user_id: str
    share_name: Optional[str] = None


class ScreenShareStoppedBroadcast(BaseModel):
    """Server broadcasts that a user stopped sharing."""

    type: Literal["screenshare_stopped"] = "screenshare_stopped"
    room_id: str
    user_id: str


# Union of all server message types
ServerMessage = Union[
    JoinedMessage,
    OperationBroadcast,
    SyncMessage,
    CallResultMessage,
    PresenceBroadcast,
    UserJoinedMessage,
    UserLeftMessage,
    ErrorMessage,
    PongMessage,
    ScreenShareStartedBroadcast,
    ScreenShareStoppedBroadcast,
]


# =============================================================================
# Error Codes
# =============================================================================


class ErrorCode(str, Enum):
    """Standard error codes for the protocol."""

    AUTHENTICATION_FAILED = "authentication_failed"
    PERMISSION_DENIED = "permission_denied"
    ROOM_NOT_FOUND = "room_not_found"
    INVALID_MESSAGE = "invalid_message"
    INVALID_OPERATION = "invalid_operation"
    FUNCTION_NOT_FOUND = "function_not_found"
    FUNCTION_ERROR = "function_error"
    INTERNAL_ERROR = "internal_error"
    RATE_LIMITED = "rate_limited"


# =============================================================================
# Message Parsing
# =============================================================================


def parse_client_message(data: Dict[str, Any]) -> ClientMessage:
    """
    Parse a raw dictionary into a typed client message.

    Raises:
        ValueError: If the message type is unknown or invalid.
    """
    msg_type = data.get("type")

    type_map = {
        "join": JoinMessage,
        "leave": LeaveMessage,
        "operation": OperationMessage,
        "sync_request": SyncRequestMessage,
        "call": CallMessage,
        "presence": PresenceMessage,
        "ping": PingMessage,
        "auth": AuthMessage,
        "state_update": StateUpdateMessage,
        "screenshare_start": ScreenShareStartMessage,
        "screenshare_stop": ScreenShareStopMessage,
        "rtc_offer": RtcOfferMessage,
        "rtc_answer": RtcAnswerMessage,
        "rtc_ice_candidate": RtcIceCandidateMessage,
        "remote_control_request": RemoteControlRequestMessage,
        "remote_control_response": RemoteControlResponseMessage,
    }

    if msg_type not in type_map:
        raise ValueError(f"Unknown message type: {msg_type}")

    return type_map[msg_type](**data)


def parse_server_message(data: Dict[str, Any]) -> ServerMessage:
    """
    Parse a raw dictionary into a typed server message.

    Raises:
        ValueError: If the message type is unknown or invalid.
    """
    msg_type = data.get("type")

    type_map = {
        "joined": JoinedMessage,
        "operation": OperationBroadcast,
        "sync": SyncMessage,
        "call_result": CallResultMessage,
        "presence": PresenceBroadcast,
        "user_joined": UserJoinedMessage,
        "user_left": UserLeftMessage,
        "error": ErrorMessage,
        "pong": PongMessage,
    }

    if msg_type not in type_map:
        raise ValueError(f"Unknown message type: {msg_type}")

    return type_map[msg_type](**data)


__all__ = [
    # User model
    "User",
    # Client messages
    "JoinMessage",
    "LeaveMessage",
    "OperationMessage",
    "SyncRequestMessage",
    "CallMessage",
    "PresenceMessage",
    "PingMessage",
    "AuthMessage",
    "StateUpdateMessage",
    "ClientMessage",
    # Screen share / WebRTC client messages
    "ScreenShareStartMessage",
    "ScreenShareStopMessage",
    "RtcOfferMessage",
    "RtcAnswerMessage",
    "RtcIceCandidateMessage",
    "RemoteControlRequestMessage",
    "RemoteControlResponseMessage",
    # Server messages
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
    # Screen share / WebRTC server messages
    "ScreenShareStartedBroadcast",
    "ScreenShareStoppedBroadcast",
    # Error codes
    "ErrorCode",
    # Parsing functions
    "parse_client_message",
    "parse_server_message",
]
