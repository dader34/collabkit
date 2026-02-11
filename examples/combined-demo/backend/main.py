"""
Combined Demo - Backend

A unified backend serving all demo rooms (todos, editor, chat).
Run with: python main.py

Uses in-memory storage for simplicity (data is not persisted).
"""

import sys
import os

# Add the parent package to path for development
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "..", "python"))

from collabkit import CollabkitServer
from collabkit.auth import NoAuth
from collabkit.storage import MemoryStorage

# Create server with in-memory storage (no database required)
storage = MemoryStorage()
server = CollabkitServer(auth_provider=NoAuth(), storage_backend=storage)


# ============================================================================
# Todo Functions
# ============================================================================

@server.register_function("clear_completed")
async def clear_completed(room, user, args):
    """Clear all completed todos."""
    state = room.state.value()
    todos = state.get("todos", [])

    original_count = len(todos)
    active_todos = [t for t in todos if not t.get("done", False)]
    cleared_count = original_count - len(active_todos)

    room.state.set(["todos"], active_todos, user.id)

    return {"cleared": cleared_count}


@server.register_function("toggle_all")
async def toggle_all(room, user, args):
    """Toggle all todos to done or not done."""
    state = room.state.value()
    todos = state.get("todos", [])

    all_done = all(t.get("done", False) for t in todos) if todos else False
    target_state = not all_done

    updated_todos = [{**t, "done": target_state} for t in todos]

    room.state.set(["todos"], updated_todos, user.id)

    return {"all_done": target_state}


# ============================================================================
# Editor Functions
# ============================================================================

@server.register_function("clear_document")
async def clear_document(room, user, args):
    """Clear the document."""
    state = room.state.value()
    document = state.get("document", {})

    previous_length = len(document.get("text", ""))

    room.state.set(["document"], {
        "text": "",
        "lastEditedBy": user.id,
        "lastEditedAt": int(__import__("time").time() * 1000),
    }, user.id)

    return {"cleared_characters": previous_length}


# ============================================================================
# Chat Functions
# ============================================================================

@server.register_function("clear_messages")
async def clear_messages(room, user, args):
    """Clear all messages."""
    state = room.state.value()
    messages = state.get("messages", [])

    cleared_count = len(messages)
    room.state.set(["messages"], [], user.id)

    return {"cleared": cleared_count}


# Create FastAPI app
app = server.app


if __name__ == "__main__":
    import uvicorn
    bind_host = os.environ.get("BIND_HOST", "127.0.0.1")
    bind_port = int(os.environ.get("BIND_PORT", "8010"))
    uvicorn.run(app, host=bind_host, port=bind_port)
