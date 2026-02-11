"""
Collaborative Text Editor - Backend

A simple example demonstrating the collabkit framework.
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


@server.register_function("clear_document")
async def clear_document(room, user, args):
    """
    Server-side function to clear the document.
    """
    state = room.state.value()
    document = state.get("document", {})

    previous_length = len(document.get("text", ""))

    # Clear the document
    room.state.set(["document"], {
        "text": "",
        "lastEditedBy": user.id,
        "lastEditedAt": int(__import__("time").time() * 1000),
    }, user.id)

    return {"cleared_characters": previous_length}


@server.register_function("get_word_count")
async def get_word_count(room, user, args):
    """
    Get the current word count of the document.
    """
    state = room.state.value()
    document = state.get("document", {})
    text = document.get("text", "")

    words = text.split() if text.strip() else []

    return {
        "word_count": len(words),
        "char_count": len(text),
        "line_count": len(text.split("\n")) if text else 0,
    }


# Create FastAPI app
app = server.app


if __name__ == "__main__":
    import uvicorn
    bind_host = os.environ.get("BIND_HOST", "127.0.0.1")
    bind_port = int(os.environ.get("BIND_PORT", "8001"))
    uvicorn.run(app, host=bind_host, port=bind_port)
