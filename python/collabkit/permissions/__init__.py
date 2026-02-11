"""
Permissions module for CollabKit.

Provides role-based access control for collaborative resources.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any


class Permission(str, Enum):
    """Standard permissions for collaborative resources."""

    READ = "read"
    WRITE = "write"
    DELETE = "delete"
    ADMIN = "admin"
    SHARE = "share"
    COMMENT = "comment"


@dataclass
class Role:
    """Represents a role with a set of permissions."""

    name: str
    permissions: set[Permission] = field(default_factory=set)
    description: str | None = None

    def has_permission(self, permission: Permission) -> bool:
        """Check if the role has a specific permission."""
        return permission in self.permissions

    def add_permission(self, permission: Permission) -> None:
        """Add a permission to the role."""
        self.permissions.add(permission)

    def remove_permission(self, permission: Permission) -> None:
        """Remove a permission from the role."""
        self.permissions.discard(permission)


# Predefined roles
VIEWER_ROLE = Role(
    name="viewer",
    permissions={Permission.READ, Permission.COMMENT},
    description="Can view and comment on resources",
)

EDITOR_ROLE = Role(
    name="editor",
    permissions={Permission.READ, Permission.WRITE, Permission.COMMENT},
    description="Can view, edit, and comment on resources",
)

ADMIN_ROLE = Role(
    name="admin",
    permissions={
        Permission.READ,
        Permission.WRITE,
        Permission.DELETE,
        Permission.ADMIN,
        Permission.SHARE,
        Permission.COMMENT,
    },
    description="Full access to resources",
)


class PermissionManager:
    """Manages permissions for users and resources."""

    def __init__(self) -> None:
        self._user_roles: dict[str, dict[str, Role]] = {}
        self._resource_permissions: dict[str, dict[str, set[Permission]]] = {}

    def assign_role(self, user_id: str, resource_id: str, role: Role) -> None:
        """Assign a role to a user for a specific resource."""
        if user_id not in self._user_roles:
            self._user_roles[user_id] = {}
        self._user_roles[user_id][resource_id] = role

    def get_role(self, user_id: str, resource_id: str) -> Role | None:
        """Get the role assigned to a user for a resource."""
        return self._user_roles.get(user_id, {}).get(resource_id)

    def check_permission(
        self, user_id: str, resource_id: str, permission: Permission
    ) -> bool:
        """Check if a user has a specific permission on a resource."""
        role = self.get_role(user_id, resource_id)
        if role is None:
            return False
        return role.has_permission(permission)

    def revoke_access(self, user_id: str, resource_id: str) -> bool:
        """Revoke a user's access to a resource."""
        if user_id in self._user_roles:
            if resource_id in self._user_roles[user_id]:
                del self._user_roles[user_id][resource_id]
                return True
        return False

    def list_user_resources(self, user_id: str) -> dict[str, Role]:
        """List all resources a user has access to."""
        return self._user_roles.get(user_id, {}).copy()


__all__ = [
    "Permission",
    "Role",
    "PermissionManager",
    "VIEWER_ROLE",
    "EDITOR_ROLE",
    "ADMIN_ROLE",
]
