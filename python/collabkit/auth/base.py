"""
Abstract authentication provider interface.

Implement this interface to integrate your own authentication system.
"""

from __future__ import annotations

import logging
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any

logger = logging.getLogger(__name__)


@dataclass
class AuthUser:
    """
    Represents an authenticated user.

    Attributes:
        id: Unique user identifier
        name: Display name
        email: Optional email address
        roles: List of role names for RBAC
        metadata: Additional user data
    """
    id: str
    name: str
    email: str | None = None
    roles: list[str] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)

    def has_role(self, role: str) -> bool:
        """Check if user has a specific role."""
        return role in self.roles

    def to_dict(self) -> dict[str, Any]:
        """Serialize user to dictionary."""
        return {
            "id": self.id,
            "name": self.name,
            "email": self.email,
            "roles": self.roles,
            "metadata": self.metadata,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "AuthUser":
        """Deserialize user from dictionary."""
        return cls(
            id=data["id"],
            name=data["name"],
            email=data.get("email"),
            roles=data.get("roles", []),
            metadata=data.get("metadata", {}),
        )


class AuthProvider(ABC):
    """
    Abstract base class for authentication providers.

    Implement this interface to integrate with your authentication system
    (JWT, sessions, API keys, OAuth, etc.).

    Example:
        class MyJWTAuth(AuthProvider):
            async def authenticate(self, token: str) -> AuthUser | None:
                try:
                    payload = jwt.decode(token, SECRET_KEY)
                    return AuthUser(
                        id=payload["sub"],
                        name=payload["name"],
                        roles=payload.get("roles", []),
                    )
                except jwt.InvalidTokenError:
                    return None
    """

    @abstractmethod
    async def authenticate(self, token: str) -> AuthUser | None:
        """
        Authenticate a user from a token.

        Args:
            token: Authentication token (JWT, session ID, API key, etc.)

        Returns:
            AuthUser if authentication succeeds, None otherwise
        """
        ...

    async def validate_token(self, token: str) -> AuthUser | None:
        """Alias for authenticate() for backward compatibility."""
        return await self.authenticate(token)

    async def get_user_roles(self, user_id: str, room_id: str) -> list[str]:
        """
        Get user's roles for a specific room.

        Override this to implement room-specific roles.
        Default implementation returns empty list with a warning.

        Args:
            user_id: The user's ID
            room_id: The room ID

        Returns:
            List of role names
        """
        logger.debug(f"get_user_roles not implemented - returning empty roles for user {user_id} in room {room_id}")
        return []

    async def on_connect(self, user: AuthUser) -> None:
        """
        Called when a user connects.

        Override to perform actions on user connect (logging, etc.)
        """
        pass

    async def on_disconnect(self, user: AuthUser) -> None:
        """
        Called when a user disconnects.

        Override to perform actions on user disconnect (cleanup, etc.)
        """
        pass


class NoAuth(AuthProvider):
    """
    No-op authentication provider for development/testing.

    Accepts any token and creates a user from it.
    DO NOT use in production! This gives all users editor role.
    """

    _warned = False

    async def authenticate(self, token: str) -> AuthUser | None:
        """Accept any token as user ID."""
        if not NoAuth._warned:
            logger.warning(
                "NoAuth provider is enabled - this is insecure and should only be used for development. "
                "All users will have 'editor' role."
            )
            NoAuth._warned = True

        if not token:
            return None
        return AuthUser(
            id=token,
            name=f"User {token[:8]}",
            roles=[],  # No default roles - require explicit permission grants
        )
