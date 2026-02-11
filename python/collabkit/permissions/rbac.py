"""
Role-Based Access Control (RBAC) implementation.

Defines roles with permissions and checks user access.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Flag, auto
from typing import Any


class Permission(Flag):
    """
    Permission flags that can be combined.

    Example:
        editor_perms = Permission.READ | Permission.WRITE
        admin_perms = Permission.READ | Permission.WRITE | Permission.DELETE | Permission.ADMIN
    """
    NONE = 0
    READ = auto()      # Can read state
    WRITE = auto()     # Can modify state
    DELETE = auto()    # Can delete entries
    ADMIN = auto()     # Can manage room settings
    CALL = auto()      # Can call server functions
    PRESENCE = auto()  # Can see/update presence

    # Convenience combinations
    @classmethod
    @property
    def VIEWER(cls) -> "Permission":
        """Read-only access with presence."""
        return cls.READ | cls.PRESENCE

    @classmethod
    @property
    def EDITOR(cls) -> "Permission":
        """Can read and write."""
        return cls.READ | cls.WRITE | cls.CALL | cls.PRESENCE

    @classmethod
    @property
    def MODERATOR(cls) -> "Permission":
        """Can read, write, and delete."""
        return cls.READ | cls.WRITE | cls.DELETE | cls.CALL | cls.PRESENCE

    @classmethod
    @property
    def OWNER(cls) -> "Permission":
        """Full access."""
        return cls.READ | cls.WRITE | cls.DELETE | cls.ADMIN | cls.CALL | cls.PRESENCE


@dataclass
class Role:
    """
    A named role with associated permissions.

    Example:
        editor = Role(
            name="editor",
            permissions=Permission.READ | Permission.WRITE,
            description="Can view and edit content",
        )
    """
    name: str
    permissions: Permission
    description: str = ""

    def has_permission(self, permission: Permission) -> bool:
        """Check if this role has a specific permission."""
        return bool(self.permissions & permission)

    def to_dict(self) -> dict[str, Any]:
        """Serialize role to dictionary."""
        return {
            "name": self.name,
            "permissions": self.permissions.value,
            "description": self.description,
        }


# Predefined roles
ROLES = {
    "viewer": Role(
        name="viewer",
        permissions=Permission.VIEWER,
        description="Can view content and see presence",
    ),
    "editor": Role(
        name="editor",
        permissions=Permission.EDITOR,
        description="Can view, edit, and call functions",
    ),
    "moderator": Role(
        name="moderator",
        permissions=Permission.MODERATOR,
        description="Can view, edit, delete, and call functions",
    ),
    "admin": Role(
        name="admin",
        permissions=Permission.OWNER,
        description="Full access including admin functions",
    ),
}


class RBACManager:
    """
    Manages role-based access control.

    Example:
        rbac = RBACManager()

        # Define custom role
        rbac.define_role("commenter", Permission.READ | Permission.PRESENCE)

        # Check access
        if rbac.check("editor", Permission.WRITE):
            # Allow write operation
            ...
    """

    def __init__(self):
        self._roles: dict[str, Role] = dict(ROLES)

    def define_role(
        self,
        name: str,
        permissions: Permission,
        description: str = "",
    ) -> Role:
        """
        Define a new role or update an existing one.

        Args:
            name: Role name (e.g., "editor", "viewer")
            permissions: Permission flags for this role
            description: Human-readable description

        Returns:
            The created/updated Role
        """
        role = Role(name=name, permissions=permissions, description=description)
        self._roles[name] = role
        return role

    def get_role(self, name: str) -> Role | None:
        """Get a role by name."""
        return self._roles.get(name)

    def check(self, role_name: str, permission: Permission) -> bool:
        """
        Check if a role has a specific permission.

        Args:
            role_name: Name of the role to check
            permission: Permission to check for

        Returns:
            True if the role has the permission
        """
        role = self._roles.get(role_name)
        if role is None:
            return False
        return role.has_permission(permission)

    def check_any(self, role_names: list[str], permission: Permission) -> bool:
        """
        Check if any of the given roles has a permission.

        Args:
            role_names: List of role names to check
            permission: Permission to check for

        Returns:
            True if any role has the permission
        """
        return any(self.check(name, permission) for name in role_names)

    def get_permissions(self, role_name: str) -> Permission:
        """
        Get all permissions for a role.

        Args:
            role_name: Name of the role

        Returns:
            Combined Permission flags, or NONE if role doesn't exist
        """
        role = self._roles.get(role_name)
        if role is None:
            return Permission.NONE
        return role.permissions

    def get_combined_permissions(self, role_names: list[str]) -> Permission:
        """
        Get combined permissions from multiple roles.

        Args:
            role_names: List of role names

        Returns:
            Combined Permission flags from all roles
        """
        combined = Permission.NONE
        for name in role_names:
            combined |= self.get_permissions(name)
        return combined

    def list_roles(self) -> list[Role]:
        """Get all defined roles."""
        return list(self._roles.values())
