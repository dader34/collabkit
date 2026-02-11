"""
Field-level permission system.

Allows fine-grained access control on specific paths within documents.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from fnmatch import fnmatch
from typing import Any, Callable

from .rbac import Permission
from ..auth.base import AuthUser


@dataclass
class FieldRule:
    """
    A permission rule for a specific field path pattern.

    Attributes:
        path_pattern: Glob-like pattern for matching paths
                     (e.g., "users.*", "settings.**", "users.{user_id}.profile")
        permission: The permission this rule controls
        allowed_roles: Roles that are allowed (if any match, access granted)
        denied_roles: Roles that are denied (checked first, overrides allowed)
        condition: Optional function for dynamic checks
    """
    path_pattern: str
    permission: Permission
    allowed_roles: list[str] = field(default_factory=list)
    denied_roles: list[str] = field(default_factory=list)
    condition: Callable[[AuthUser, list[str]], bool] | None = None

    def matches_path(self, path: list[str]) -> bool:
        """
        Check if a path matches this rule's pattern.

        Pattern syntax:
        - "*" matches a single path segment
        - "**" matches zero or more segments
        - "{user_id}" is a placeholder (matches any single segment)
        - Literal strings match exactly
        """
        path_str = ".".join(path)
        pattern = self.path_pattern

        # Handle {placeholder} syntax - convert to *
        import re
        pattern = re.sub(r'\{[^}]+\}', '*', pattern)

        # Handle ** for recursive matching
        if "**" in pattern:
            # Convert ** to a regex pattern
            regex_pattern = pattern.replace(".", r"\.").replace("**", ".*").replace("*", "[^.]*")
            return bool(re.match(f"^{regex_pattern}$", path_str))

        return fnmatch(path_str, pattern)

    def check(self, user: AuthUser, path: list[str]) -> bool | None:
        """
        Check if this rule allows access.

        Returns:
            True if explicitly allowed
            False if explicitly denied
            None if rule doesn't apply
        """
        if not self.matches_path(path):
            return None

        # Check denied roles first
        for role in user.roles:
            if role in self.denied_roles:
                return False

        # Check condition if present
        if self.condition is not None:
            if not self.condition(user, path):
                return False

        # Check allowed roles
        if self.allowed_roles:
            for role in user.roles:
                if role in self.allowed_roles:
                    return True
            return False

        # No explicit allow/deny, rule matches but doesn't decide
        return None


class FieldPermissions:
    """
    Manages field-level permissions.

    Combines with RBAC to provide fine-grained access control.

    Example:
        field_perms = FieldPermissions()

        # Only admins can modify settings
        field_perms.add_rule(
            path_pattern="settings.**",
            permission=Permission.WRITE,
            allowed_roles=["admin"],
        )

        # Users can only edit their own profile
        field_perms.add_rule(
            path_pattern="users.*.profile",
            permission=Permission.WRITE,
            condition=lambda user, path: path[1] == user.id,
        )

        # Check access
        if field_perms.check(user, ["users", "123", "profile"], Permission.WRITE):
            # Allow edit
            ...
    """

    def __init__(self):
        self._rules: list[FieldRule] = []

    def add_rule(
        self,
        path_pattern: str,
        permission: Permission,
        allowed_roles: list[str] | None = None,
        denied_roles: list[str] | None = None,
        condition: Callable[[AuthUser, list[str]], bool] | None = None,
    ) -> FieldRule:
        """
        Add a field-level permission rule.

        Args:
            path_pattern: Glob pattern for matching paths
            permission: Permission this rule controls
            allowed_roles: Roles that are explicitly allowed
            denied_roles: Roles that are explicitly denied
            condition: Function (user, path) -> bool for dynamic checks

        Returns:
            The created rule
        """
        rule = FieldRule(
            path_pattern=path_pattern,
            permission=permission,
            allowed_roles=allowed_roles or [],
            denied_roles=denied_roles or [],
            condition=condition,
        )
        self._rules.append(rule)
        return rule

    def check(
        self,
        user: AuthUser,
        path: list[str],
        permission: Permission,
    ) -> bool | None:
        """
        Check field-level permissions.

        Args:
            user: The user to check
            path: The field path being accessed
            permission: The permission being requested

        Returns:
            True if explicitly allowed by a field rule
            False if explicitly denied by a field rule
            None if no field rules apply (fall back to RBAC)
        """
        result = None

        for rule in self._rules:
            # Only check rules for the requested permission
            if not (rule.permission & permission):
                continue

            rule_result = rule.check(user, path)
            if rule_result is False:
                # Explicit deny takes precedence
                return False
            if rule_result is True:
                result = True

        return result

    def clear_rules(self) -> None:
        """Remove all field-level rules."""
        self._rules.clear()


class PermissionChecker:
    """
    Combined permission checker using RBAC and field-level rules.

    This is the main class to use for checking permissions.

    Example:
        from collabkit.permissions import PermissionChecker, Permission

        checker = PermissionChecker()

        # Define roles
        checker.rbac.define_role("custom", Permission.READ | Permission.WRITE)

        # Add field rules
        checker.field.add_rule(
            "private.**",
            Permission.READ,
            allowed_roles=["admin"],
        )

        # Check permissions
        can_read = checker.check(user, ["data", "public"], Permission.READ)
        can_write_private = checker.check(user, ["private", "config"], Permission.WRITE)
    """

    def __init__(self):
        from .rbac import RBACManager
        self.rbac = RBACManager()
        self.field = FieldPermissions()

    def check(
        self,
        user: AuthUser,
        path: list[str],
        permission: Permission,
    ) -> bool:
        """
        Check if a user has permission to access a path.

        Order of checks:
        1. Field-level rules (if any match and deny, return False)
        2. Field-level rules (if any match and allow, return True)
        3. Fall back to RBAC check

        Args:
            user: The user requesting access
            path: The field path being accessed
            permission: The permission being requested

        Returns:
            True if access is allowed, False otherwise
        """
        # Check field-level rules first
        field_result = self.field.check(user, path, permission)
        if field_result is not None:
            return field_result

        # Fall back to RBAC
        return self.rbac.check_any(user.roles, permission)

    def check_operation(
        self,
        user: AuthUser,
        op_type: str,
        path: list[str],
    ) -> bool:
        """
        Check if a user can perform an operation.

        Maps operation types to permissions:
        - 'set' -> WRITE
        - 'delete' -> DELETE
        - 'increment', 'decrement' -> WRITE
        - 'add', 'remove' -> WRITE

        Args:
            user: The user performing the operation
            op_type: The operation type
            path: The field path

        Returns:
            True if operation is allowed
        """
        permission_map = {
            "set": Permission.WRITE,
            "delete": Permission.DELETE,
            "increment": Permission.WRITE,
            "decrement": Permission.WRITE,
            "add": Permission.WRITE,
            "remove": Permission.WRITE,
        }

        permission = permission_map.get(op_type, Permission.WRITE)
        return self.check(user, list(path), permission)
