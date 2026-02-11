"""
JWT-based authentication provider implementation.

Example implementation showing how to integrate JWT authentication.
"""

from __future__ import annotations

from typing import Any
import time

from .base import AuthProvider, AuthUser


class JWTAuthProvider(AuthProvider):
    """
    JWT-based authentication provider.

    This is a reference implementation. You can use it directly or as
    a template for your own JWT integration.

    Example:
        auth = JWTAuthProvider(
            secret_key="your-secret-key",
            algorithm="HS256",
        )
        server = CollabkitServer(auth=auth, storage=storage)
    """

    def __init__(
        self,
        secret_key: str,
        algorithm: str = "HS256",
        issuer: str | None = None,
        audience: str | None = None,
        leeway: int = 0,
    ):
        """
        Initialize JWT auth provider.

        Args:
            secret_key: Secret key for verifying JWT signatures
            algorithm: JWT algorithm (HS256, RS256, etc.)
            issuer: Expected token issuer (optional)
            audience: Expected token audience (optional)
            leeway: Seconds of leeway for expiration checks
        """
        self.secret_key = secret_key
        self.algorithm = algorithm
        self.issuer = issuer
        self.audience = audience
        self.leeway = leeway

    async def authenticate(self, token: str) -> AuthUser | None:
        """
        Authenticate a user from a JWT token.

        Expected JWT payload:
        {
            "sub": "user-id",
            "name": "User Name",
            "email": "user@example.com",  # optional
            "roles": ["editor"],           # optional
            "exp": 1234567890,             # expiration time
            "iat": 1234567890,             # issued at
        }
        """
        try:
            import jwt
        except ImportError:
            raise ImportError(
                "PyJWT is required for JWTAuthProvider. "
                "Install it with: pip install PyJWT"
            )

        try:
            options = {}
            if self.issuer:
                options["require"] = ["exp", "iat", "sub"]

            payload = jwt.decode(
                token,
                self.secret_key,
                algorithms=[self.algorithm],
                issuer=self.issuer,
                audience=self.audience,
                leeway=self.leeway,
                options=options,
            )

            return AuthUser(
                id=payload["sub"],
                name=payload.get("name", f"User {payload['sub'][:8]}"),
                email=payload.get("email"),
                roles=payload.get("roles", []),
                metadata=payload.get("metadata", {}),
            )

        except jwt.ExpiredSignatureError:
            return None
        except jwt.InvalidTokenError:
            return None

    def create_token(
        self,
        user_id: str,
        name: str,
        email: str | None = None,
        roles: list[str] | None = None,
        expires_in: int = 3600,
        metadata: dict[str, Any] | None = None,
    ) -> str:
        """
        Create a JWT token for a user.

        This is a helper method for testing and development.
        In production, tokens should be created by your auth service.

        Args:
            user_id: Unique user identifier
            name: Display name
            email: Optional email
            roles: List of role names
            expires_in: Token lifetime in seconds (default 1 hour)
            metadata: Additional claims

        Returns:
            Signed JWT token string
        """
        try:
            import jwt
        except ImportError:
            raise ImportError(
                "PyJWT is required for JWTAuthProvider. "
                "Install it with: pip install PyJWT"
            )

        now = int(time.time())
        payload: dict[str, Any] = {
            "sub": user_id,
            "name": name,
            "iat": now,
            "exp": now + expires_in,
        }

        if email:
            payload["email"] = email
        if roles:
            payload["roles"] = roles
        if metadata:
            payload["metadata"] = metadata
        if self.issuer:
            payload["iss"] = self.issuer
        if self.audience:
            payload["aud"] = self.audience

        return jwt.encode(payload, self.secret_key, algorithm=self.algorithm)
