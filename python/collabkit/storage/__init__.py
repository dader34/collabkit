"""
Storage module for CollabKit.

Provides storage backends for persisting collaborative data.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any, Dict, List, Optional


class StorageBackend(ABC):
    """Abstract base class for storage backends."""

    @abstractmethod
    async def connect(self) -> None:
        """Establish connection to the storage backend."""
        pass

    @abstractmethod
    async def disconnect(self) -> None:
        """Close connection to the storage backend."""
        pass

    @abstractmethod
    async def save(self, key: str, data: Dict[str, Any]) -> bool:
        """Save data to storage."""
        pass

    @abstractmethod
    async def load(self, key: str) -> Optional[Dict[str, Any]]:
        """Load data from storage."""
        pass

    @abstractmethod
    async def delete(self, key: str) -> bool:
        """Delete data from storage."""
        pass

    @abstractmethod
    async def exists(self, key: str) -> bool:
        """Check if a key exists in storage."""
        pass

    @abstractmethod
    async def list_keys(self, prefix: str = "") -> List[str]:
        """List all keys with optional prefix filter."""
        pass


class MemoryStorage(StorageBackend):
    """In-memory storage backend for development and testing."""

    def __init__(self) -> None:
        self._data: Dict[str, Dict[str, Any]] = {}
        self._connected: bool = False

    async def connect(self) -> None:
        """Establish connection (no-op for memory storage)."""
        self._connected = True

    async def disconnect(self) -> None:
        """Close connection (no-op for memory storage)."""
        self._connected = False

    async def save(self, key: str, data: Dict[str, Any]) -> bool:
        """Save data to memory."""
        self._data[key] = data.copy()
        return True

    async def load(self, key: str) -> Optional[Dict[str, Any]]:
        """Load data from memory."""
        data = self._data.get(key)
        return data.copy() if data else None

    async def delete(self, key: str) -> bool:
        """Delete data from memory."""
        if key in self._data:
            del self._data[key]
            return True
        return False

    async def exists(self, key: str) -> bool:
        """Check if a key exists in memory."""
        return key in self._data

    async def list_keys(self, prefix: str = "") -> List[str]:
        """List all keys with optional prefix filter."""
        if not prefix:
            return list(self._data.keys())
        return [k for k in self._data.keys() if k.startswith(prefix)]


class PostgresStorage(StorageBackend):
    """PostgreSQL storage backend for production use."""

    def __init__(
        self,
        host: str = "localhost",
        port: int = 5432,
        database: str = "collabkit",
        user: str = "postgres",
        password: str = "",
    ) -> None:
        self._host = host
        self._port = port
        self._database = database
        self._user = user
        self._password = password
        self._pool: Any = None

    async def connect(self) -> None:
        """Establish connection to PostgreSQL."""
        import asyncpg

        self._pool = await asyncpg.create_pool(
            host=self._host,
            port=self._port,
            database=self._database,
            user=self._user,
            password=self._password,
        )
        # Create table if not exists
        async with self._pool.acquire() as conn:
            await conn.execute("""
                CREATE TABLE IF NOT EXISTS collabkit_storage (
                    key TEXT PRIMARY KEY,
                    data JSONB NOT NULL,
                    created_at TIMESTAMP DEFAULT NOW(),
                    updated_at TIMESTAMP DEFAULT NOW()
                )
            """)

    async def disconnect(self) -> None:
        """Close connection to PostgreSQL."""
        if self._pool:
            await self._pool.close()
            self._pool = None

    async def save(self, key: str, data: Dict[str, Any]) -> bool:
        """Save data to PostgreSQL."""
        import json

        if not self._pool:
            raise RuntimeError("Not connected to database")

        async with self._pool.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO collabkit_storage (key, data, updated_at)
                VALUES ($1, $2, NOW())
                ON CONFLICT (key) DO UPDATE SET data = $2, updated_at = NOW()
                """,
                key,
                json.dumps(data),
            )
        return True

    async def load(self, key: str) -> Optional[Dict[str, Any]]:
        """Load data from PostgreSQL."""
        import json

        if not self._pool:
            raise RuntimeError("Not connected to database")

        async with self._pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT data FROM collabkit_storage WHERE key = $1", key
            )
            if row:
                return json.loads(row["data"])
            return None

    async def delete(self, key: str) -> bool:
        """Delete data from PostgreSQL."""
        if not self._pool:
            raise RuntimeError("Not connected to database")

        async with self._pool.acquire() as conn:
            result = await conn.execute(
                "DELETE FROM collabkit_storage WHERE key = $1", key
            )
            return result == "DELETE 1"

    async def exists(self, key: str) -> bool:
        """Check if a key exists in PostgreSQL."""
        if not self._pool:
            raise RuntimeError("Not connected to database")

        async with self._pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT 1 FROM collabkit_storage WHERE key = $1", key
            )
            return row is not None

    async def list_keys(self, prefix: str = "") -> List[str]:
        """List all keys with optional prefix filter."""
        if not self._pool:
            raise RuntimeError("Not connected to database")

        async with self._pool.acquire() as conn:
            if prefix:
                rows = await conn.fetch(
                    "SELECT key FROM collabkit_storage WHERE key LIKE $1",
                    f"{prefix}%",
                )
            else:
                rows = await conn.fetch("SELECT key FROM collabkit_storage")
            return [row["key"] for row in rows]


__all__ = [
    "StorageBackend",
    "MemoryStorage",
    "PostgresStorage",
]
