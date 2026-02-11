"""
Authentication module for CollabKit.

Provides authentication primitives for securing collaborative sessions.
"""

from __future__ import annotations

import warnings
from abc import ABC, abstractmethod
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional
import uuid


@dataclass
class AuthUser:
    """Represents an authenticated user."""

    id: str
    name: str
    email: Optional[str] = None
    metadata: Optional[Dict[str, Any]] = None

    def __post_init__(self) -> None:
        if self.metadata is None:
            self.metadata = {}


@dataclass
class AuthToken:
    """Represents an authentication token."""

    token: str
    user_id: str
    expires_at: datetime
    scopes: Optional[List[str]] = None

    def __post_init__(self) -> None:
        if self.scopes is None:
            self.scopes = []

    def is_expired(self) -> bool:
        """Check if the token has expired."""
        return datetime.now(timezone.utc) > self.expires_at

    def has_scope(self, scope: str) -> bool:
        """Check if the token has a specific scope."""
        return self.scopes is not None and scope in self.scopes


class AuthProvider(ABC):
    """Abstract base class for authentication providers."""

    @abstractmethod
    async def authenticate(self, credentials: Dict[str, Any]) -> Optional[AuthToken]:
        """Authenticate a user and return a token."""
        pass

    @abstractmethod
    async def validate_token(self, token: str) -> Optional[AuthUser]:
        """Validate a token and return the associated user."""
        pass

    @abstractmethod
    async def revoke_token(self, token: str) -> bool:
        """Revoke an authentication token."""
        pass

    @abstractmethod
    async def refresh_token(self, token: str) -> Optional[AuthToken]:
        """Refresh an authentication token."""
        pass


class NoAuth(AuthProvider):
    """No authentication provider for demos and development ONLY.

    WARNING: This provider accepts ANY token and grants full access.
    DO NOT use in production environments.

    Automatically generates anonymous users and always allows access.
    """

    _warned = False

    def __init__(self) -> None:
        """Initialize NoAuth with a security warning."""
        if not NoAuth._warned:
            warnings.warn(
                "NoAuth provider is being used. This accepts ANY token and should "
                "NEVER be used in production. Use JWTAuthProvider or implement a "
                "custom AuthProvider for production deployments.",
                UserWarning,
                stacklevel=2,
            )
            NoAuth._warned = True

    async def authenticate(self, credentials: Dict[str, Any]) -> Optional[AuthToken]:
        """Create a token for any credentials."""
        user_id = credentials.get("user_id", str(uuid.uuid4()))
        return AuthToken(
            token=str(uuid.uuid4()),
            user_id=user_id,
            expires_at=datetime.now(timezone.utc) + timedelta(days=365),
            scopes=["*"],
        )

    async def validate_token(self, token: str) -> Optional[AuthUser]:
        """Accept any token and return a user derived from it."""
        if not token:
            return None
        return AuthUser(
            id=token,
            name=f"User {token[:8]}",
            email=None,
            metadata={},
        )

    async def revoke_token(self, token: str) -> bool:
        """Always succeed since there's nothing to revoke."""
        return True

    async def refresh_token(self, token: str) -> Optional[AuthToken]:
        """Generate a new token."""
        return AuthToken(
            token=str(uuid.uuid4()),
            user_id=str(uuid.uuid4()),
            expires_at=datetime.now(timezone.utc) + timedelta(days=365),
            scopes=["*"],
        )


__all__ = [
    "AuthUser",
    "AuthToken",
    "AuthProvider",
    "NoAuth",
]
