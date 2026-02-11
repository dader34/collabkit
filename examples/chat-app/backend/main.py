"""
Collaborative Chat App - Backend

A simple example demonstrating the collabkit framework for real-time chat.
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


@server.register_function("clear_messages")
async def clear_messages(room, user, args):
    """
    Server-side function to clear all messages.
    """
    state = room.state.value()
    messages = state.get("messages", [])

    # Count how many were cleared
    cleared_count = len(messages)

    # Clear all messages
    room.state.set(["messages"], [], user.id)

    return {"cleared": cleared_count}


# Create FastAPI app
app = server.app


if __name__ == "__main__":
    import uvicorn
    bind_host = os.environ.get("BIND_HOST", "127.0.0.1")
    bind_port = int(os.environ.get("BIND_PORT", "8002"))
    uvicorn.run(app, host=bind_host, port=bind_port)
