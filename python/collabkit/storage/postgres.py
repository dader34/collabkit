"""
PostgreSQL storage provider implementation.

Uses asyncpg for async database access.
"""

from __future__ import annotations

import json
import time
from typing import Any

from .base import StorageProvider, RoomData, PresenceData
from ..crdt.base import Operation


class PostgresStorage(StorageProvider):
    """
    PostgreSQL storage provider.

    Example:
        storage = PostgresStorage(
            host="localhost",
            port=5432,
            database="collabkit",
            user="postgres",
            password="secret",
        )
        await storage.connect()

        server = CollabkitServer(auth=auth, storage=storage)
    """

    def __init__(
        self,
        host: str = "localhost",
        port: int = 5432,
        database: str = "collabkit",
        user: str = "postgres",
        password: str = "",
        min_connections: int = 2,
        max_connections: int = 10,
    ):
        """
        Initialize PostgreSQL storage.

        Args:
            host: Database host
            port: Database port
            database: Database name
            user: Database user
            password: Database password
            min_connections: Minimum pool connections
            max_connections: Maximum pool connections
        """
        self._host = host
        self._port = port
        self._database = database
        self._user = user
        self._password = password
        self._min_connections = min_connections
        self._max_connections = max_connections
        self._pool: Any = None

    async def connect(self) -> None:
        """Initialize connection pool and create tables."""
        try:
            import asyncpg
        except ImportError:
            raise ImportError(
                "asyncpg is required for PostgresStorage. "
                "Install it with: pip install asyncpg"
            )

        self._pool = await asyncpg.create_pool(
            host=self._host,
            port=self._port,
            database=self._database,
            user=self._user,
            password=self._password,
            min_size=self._min_connections,
            max_size=self._max_connections,
        )

        await self._create_tables()

    async def _create_tables(self) -> None:
        """Create required tables if they don't exist."""
        async with self._pool.acquire() as conn:
            await conn.execute("""
                CREATE TABLE IF NOT EXISTS collabkit_rooms (
                    id VARCHAR(255) PRIMARY KEY,
                    state JSONB NOT NULL DEFAULT '{}',
                    metadata JSONB NOT NULL DEFAULT '{}',
                    created_at DOUBLE PRECISION NOT NULL,
                    updated_at DOUBLE PRECISION NOT NULL
                )
            """)

            await conn.execute("""
                CREATE TABLE IF NOT EXISTS collabkit_operations (
                    id VARCHAR(255) PRIMARY KEY,
                    room_id VARCHAR(255) NOT NULL REFERENCES collabkit_rooms(id) ON DELETE CASCADE,
                    timestamp DOUBLE PRECISION NOT NULL,
                    node_id VARCHAR(255) NOT NULL,
                    path TEXT[] NOT NULL,
                    op_type VARCHAR(50) NOT NULL,
                    value JSONB,
                    created_at DOUBLE PRECISION NOT NULL
                )
            """)

            await conn.execute("""
                CREATE INDEX IF NOT EXISTS idx_operations_room_timestamp
                ON collabkit_operations(room_id, timestamp)
            """)

            await conn.execute("""
                CREATE TABLE IF NOT EXISTS collabkit_presence (
                    room_id VARCHAR(255) NOT NULL REFERENCES collabkit_rooms(id) ON DELETE CASCADE,
                    user_id VARCHAR(255) NOT NULL,
                    connection_id VARCHAR(255) NOT NULL,
                    data JSONB NOT NULL DEFAULT '{}',
                    last_seen DOUBLE PRECISION NOT NULL,
                    PRIMARY KEY (room_id, connection_id)
                )
            """)

            await conn.execute("""
                CREATE INDEX IF NOT EXISTS idx_presence_last_seen
                ON collabkit_presence(last_seen)
            """)

    async def disconnect(self) -> None:
        """Close connection pool."""
        if self._pool:
            await self._pool.close()
            self._pool = None

    def _ensure_connected(self) -> None:
        """Raise error if not connected."""
        if self._pool is None:
            raise RuntimeError("Not connected to database. Call connect() first.")

    # Room operations

    async def get_room(self, room_id: str) -> RoomData | None:
        self._ensure_connected()
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT * FROM collabkit_rooms WHERE id = $1",
                room_id,
            )
            if row is None:
                return None
            return RoomData(
                id=row["id"],
                state=json.loads(row["state"]),
                metadata=json.loads(row["metadata"]),
                created_at=row["created_at"],
                updated_at=row["updated_at"],
            )

    async def save_room(self, room: RoomData) -> None:
        self._ensure_connected()
        async with self._pool.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO collabkit_rooms (id, state, metadata, created_at, updated_at)
                VALUES ($1, $2, $3, $4, $5)
                ON CONFLICT (id) DO UPDATE SET
                    state = EXCLUDED.state,
                    metadata = EXCLUDED.metadata,
                    updated_at = EXCLUDED.updated_at
                """,
                room.id,
                json.dumps(room.state),
                json.dumps(room.metadata),
                room.created_at,
                room.updated_at,
            )

    async def delete_room(self, room_id: str) -> bool:
        self._ensure_connected()
        async with self._pool.acquire() as conn:
            result = await conn.execute(
                "DELETE FROM collabkit_rooms WHERE id = $1",
                room_id,
            )
            return result == "DELETE 1"

    async def list_rooms(self, limit: int = 100, offset: int = 0) -> list[RoomData]:
        self._ensure_connected()
        async with self._pool.acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT * FROM collabkit_rooms
                ORDER BY created_at DESC
                LIMIT $1 OFFSET $2
                """,
                limit,
                offset,
            )
            return [
                RoomData(
                    id=row["id"],
                    state=json.loads(row["state"]),
                    metadata=json.loads(row["metadata"]),
                    created_at=row["created_at"],
                    updated_at=row["updated_at"],
                )
                for row in rows
            ]

    # Operation log

    async def save_operation(self, room_id: str, op: Operation) -> None:
        self._ensure_connected()
        async with self._pool.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO collabkit_operations
                (id, room_id, timestamp, node_id, path, op_type, value, created_at)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                ON CONFLICT (id) DO NOTHING
                """,
                op.id,
                room_id,
                op.timestamp,
                op.node_id,
                list(op.path),
                op.op_type,
                json.dumps(op.value) if op.value is not None else None,
                time.time(),
            )

    async def get_operations(
        self,
        room_id: str,
        since: float,
        limit: int = 1000,
    ) -> list[Operation]:
        self._ensure_connected()
        async with self._pool.acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT * FROM collabkit_operations
                WHERE room_id = $1 AND timestamp > $2
                ORDER BY timestamp ASC
                LIMIT $3
                """,
                room_id,
                since,
                limit,
            )
            return [
                Operation(
                    id=row["id"],
                    timestamp=row["timestamp"],
                    node_id=row["node_id"],
                    path=tuple(row["path"]),
                    op_type=row["op_type"],
                    value=json.loads(row["value"]) if row["value"] else None,
                )
                for row in rows
            ]

    async def prune_operations(self, room_id: str, before: float) -> int:
        self._ensure_connected()
        async with self._pool.acquire() as conn:
            result = await conn.execute(
                """
                DELETE FROM collabkit_operations
                WHERE room_id = $1 AND timestamp < $2
                """,
                room_id,
                before,
            )
            # Parse "DELETE N" to get count
            try:
                return int(result.split()[1])
            except (IndexError, ValueError):
                return 0

    # Presence

    async def save_presence(self, presence: PresenceData) -> None:
        self._ensure_connected()
        async with self._pool.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO collabkit_presence
                (room_id, user_id, connection_id, data, last_seen)
                VALUES ($1, $2, $3, $4, $5)
                ON CONFLICT (room_id, connection_id) DO UPDATE SET
                    data = EXCLUDED.data,
                    last_seen = EXCLUDED.last_seen
                """,
                presence.room_id,
                presence.user_id,
                presence.connection_id,
                json.dumps(presence.data),
                presence.last_seen,
            )

    async def get_presence(self, room_id: str) -> list[PresenceData]:
        self._ensure_connected()
        async with self._pool.acquire() as conn:
            rows = await conn.fetch(
                "SELECT * FROM collabkit_presence WHERE room_id = $1",
                room_id,
            )
            return [
                PresenceData(
                    room_id=row["room_id"],
                    user_id=row["user_id"],
                    connection_id=row["connection_id"],
                    data=json.loads(row["data"]),
                    last_seen=row["last_seen"],
                )
                for row in rows
            ]

    async def delete_presence(self, room_id: str, connection_id: str) -> bool:
        self._ensure_connected()
        async with self._pool.acquire() as conn:
            result = await conn.execute(
                """
                DELETE FROM collabkit_presence
                WHERE room_id = $1 AND connection_id = $2
                """,
                room_id,
                connection_id,
            )
            return result == "DELETE 1"

    async def cleanup_stale_presence(self, older_than: float) -> int:
        self._ensure_connected()
        async with self._pool.acquire() as conn:
            result = await conn.execute(
                "DELETE FROM collabkit_presence WHERE last_seen < $1",
                older_than,
            )
            try:
                return int(result.split()[1])
            except (IndexError, ValueError):
                return 0
