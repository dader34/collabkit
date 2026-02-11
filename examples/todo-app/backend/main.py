"""
Collaborative Todo App - Backend

A simple example demonstrating the collabkit framework.
Run with: uvicorn main:app --reload

Environment variables:
  POSTGRES_HOST     - Database host (default: localhost)
  POSTGRES_PORT     - Database port (default: 5432)
  POSTGRES_DB       - Database name (default: collabkit)
  POSTGRES_USER     - Database user (default: postgres)
  POSTGRES_PASSWORD - Database password (required)
"""

import sys
import os

# Load environment variables from .env file if present
try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass  # python-dotenv not installed, rely on system environment variables

# Add the parent package to path for development
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "..", "python"))

from collabkit import CollabkitServer
from collabkit.auth import NoAuth
from collabkit.storage import PostgresStorage

# Create server with PostgreSQL storage
# Tables are created automatically on first connect
storage = PostgresStorage(
    host=os.environ.get("POSTGRES_HOST", "localhost"),
    port=int(os.environ.get("POSTGRES_PORT", "5432")),
    database=os.environ.get("POSTGRES_DB", "collabkit"),
    user=os.environ.get("POSTGRES_USER", "postgres"),
    password=os.environ.get("POSTGRES_PASSWORD", ""),
)
server = CollabkitServer(auth_provider=NoAuth(), storage_backend=storage)


@server.register_function("clear_completed")
async def clear_completed(room, user, args):
    """
    Server-side function to clear all completed todos.
    This demonstrates custom server functions.
    """
    state = room.state.value()
    todos = state.get("todos", [])

    # Count how many were cleared
    original_count = len(todos)
    active_todos = [t for t in todos if not t.get("done", False)]
    cleared_count = original_count - len(active_todos)

    # Update the state
    room.state.set(["todos"], active_todos, user.id)

    return {"cleared": cleared_count}


@server.register_function("toggle_all")
async def toggle_all(room, user, args):
    """
    Toggle all todos to done or not done.
    """
    state = room.state.value()
    todos = state.get("todos", [])

    # If all are done, mark all as not done; otherwise mark all as done
    all_done = all(t.get("done", False) for t in todos) if todos else False
    target_state = not all_done

    updated_todos = [
        {**t, "done": target_state}
        for t in todos
    ]

    room.state.set(["todos"], updated_todos, user.id)

    return {"all_done": target_state}


# Create FastAPI app
app = server.app


if __name__ == "__main__":
    import uvicorn
    # SECURITY: Bind to localhost by default. Set BIND_HOST=0.0.0.0 for network access.
    bind_host = os.environ.get("BIND_HOST", "127.0.0.1")
    bind_port = int(os.environ.get("BIND_PORT", "8000"))
    uvicorn.run(app, host=bind_host, port=bind_port)
