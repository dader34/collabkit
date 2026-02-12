# CollabKit

A real-time collaboration toolkit for building multiplayer applications. CollabKit provides a TypeScript client library with React hooks and a Python server built on FastAPI, connected via WebSockets. State synchronization is handled automatically through CRDTs (Conflict-free Replicated Data Types), so concurrent edits from multiple users merge without conflicts.

## Table of Contents

- [Features](#features)
- [Project Structure](#project-structure)
- [Quick Start](#quick-start)
- [Client Library (`@collabkit/client`)](#client-library-collabkitclient)
  - [Installation](#installation)
  - [Basic Setup](#basic-setup)
  - [React Hooks](#react-hooks)
  - [Vanilla Client API](#vanilla-client-api)
  - [Screen Sharing](#screen-sharing)
  - [Offline Support](#offline-support)
- [Server (`collabkit`)](#server-collabkit)
  - [Installation](#server-installation)
  - [Basic Setup](#server-basic-setup)
  - [Server Functions](#server-functions)
  - [Authentication](#authentication)
  - [Permissions](#permissions)
  - [Storage Backends](#storage-backends)
  - [Configuration](#server-configuration)
- [CRDT Types](#crdt-types)
- [Protocol Reference](#protocol-reference)
- [Examples](#examples)
- [Security](#security)

---

## Features

- **Real-time state synchronization** -- CRDT-based conflict resolution with Last-Writer-Wins semantics
- **React hooks** -- `useCollabState`, `usePresence`, `useRoom`, `useCollabFunction`, `useScreenShare`
- **Presence tracking** -- Cursors, selections, typing indicators, and arbitrary user metadata
- **Server-side functions** -- Register custom functions callable from the client with auth and permission checks
- **Screen sharing** -- WebRTC-based screen capture with remote control, annotations, and cursor tracking
- **Offline support** -- Operations queued in localStorage and replayed on reconnect
- **Authentication** -- Pluggable auth providers with a built-in JWT implementation
- **Permissions** -- Role-based access control (RBAC) with optional field-level rules
- **Persistent storage** -- In-memory storage for development, PostgreSQL for production
- **Auto-reconnection** -- Exponential backoff with automatic room rejoin

## Project Structure

```
collabkit/
  js/                          # TypeScript client library (@collabkit/client)
    src/
      client.ts                # Core WebSocket client
      protocol.ts              # Message type definitions
      screenshare.ts           # WebRTC screen sharing manager
      offline.ts               # Offline operation queue
      crdt/
        types.ts               # Operation, VersionVector, base classes
        map.ts                 # LWWMap (Last-Writer-Wins Map)
        register.ts            # LWWRegister (Last-Writer-Wins Register)
      react/
        provider.tsx           # CollabkitProvider component
        context.ts             # React context
        hooks.ts               # All React hooks
      index.ts                 # Public exports
    package.json
    tsconfig.json

  python/                      # Python server library (collabkit)
    collabkit/
      server.py                # CollabkitServer (FastAPI + WebSocket)
      room.py                  # Room and RoomManager
      protocol.py              # Message parsing and validation
      presence.py              # PresenceManager
      crdt/
        base.py                # Operation, VersionVector, base classes
        map.py                 # LWWMap
        register.py            # LWWRegister
        counter.py             # GCounter, PNCounter
        set.py                 # ORSet (Observed-Remove Set)
      auth/
        __init__.py            # AuthProvider, AuthUser, NoAuth
        base.py                # Extended base classes
        jwt.py                 # JWTAuthProvider
      permissions/
        __init__.py            # Simple permission manager
        rbac.py                # Role-based access control
        field_level.py         # Field-level permission rules
      storage/
        __init__.py            # MemoryStorage
        base.py                # StorageBackend interface
        postgres.py            # PostgresStorage
    pyproject.toml

  examples/
    todo-app/                  # Collaborative todo list
    chat-app/                  # Real-time chat
    text-editor/               # Collaborative text editing
    combined-demo/             # Full-featured demo (all capabilities)
```

---

## Quick Start

### 1. Start the server

```bash
cd examples/todo-app/backend
pip install -e ../../../python
python main.py
# Server running on http://127.0.0.1:8000
```

### 2. Start the frontend

```bash
cd examples/todo-app/frontend
npm install
npm run dev
# Frontend running on http://localhost:5173
```

### 3. Open multiple browser tabs

Navigate to `http://localhost:5173` in two or more tabs. Changes made in one tab appear instantly in all others.

---

## Client Library (`@collabkit/client`)

### Installation

```bash
npm install @collabkit/client
```

Peer dependency: React 18.0.0+

### Basic Setup

Wrap your app with `CollabkitProvider`:

```tsx
import { CollabkitProvider } from "@collabkit/client";

function App() {
  return (
    <CollabkitProvider
      url="ws://localhost:8000/ws"
      getToken={async () => {
        const res = await fetch("/api/auth/token");
        const { token } = await res.json();
        return token;
      }}
    >
      <MyCollaborativeApp />
    </CollabkitProvider>
  );
}
```

The provider creates a `CollabkitClient` instance, connects on mount, and disconnects on unmount. The `getToken` callback is called on every connection and reconnection to fetch a fresh auth token.

### React Hooks

#### `useRoom(roomId)` -- Join a room

```tsx
import { useRoom } from "@collabkit/client";

function MyRoom() {
  const { status, error, state, users } = useRoom("my-room");

  if (status === "connecting") return <p>Connecting...</p>;
  if (status === "error") return <p>Error: {error?.message}</p>;

  return <p>Connected with {users.length} users</p>;
}
```

Automatically joins the room on mount and leaves on unmount. Returns the current connection status, room state, and list of connected users.

#### `useCollabState(roomId, path)` -- Shared state

```tsx
import { useCollabState } from "@collabkit/client";

function Counter() {
  const [count, setCount] = useCollabState<number>("my-room", "counter");

  return (
    <div>
      <p>Count: {count ?? 0}</p>
      <button onClick={() => setCount((prev) => (prev ?? 0) + 1)}>
        Increment
      </button>
    </div>
  );
}
```

Works like `useState` but the value is synchronized across all connected clients. Supports:
- **Dot-separated paths**: `"user.name"` or `"settings.theme"`
- **Array paths**: `["user", "name"]`
- **Root state**: omit the path to get/set the entire room state
- **Functional updates**: `setCount(prev => prev + 1)`

All updates use CRDT operations under the hood, so concurrent writes from different users are resolved automatically.

#### `usePresence(roomId)` -- User presence

```tsx
import { usePresence } from "@collabkit/client";

interface MyPresence {
  cursor: { x: number; y: number };
  isTyping: boolean;
}

function Cursors() {
  const { users, myPresence, updatePresence } = usePresence<MyPresence>("my-room");

  const handleMouseMove = (e: React.MouseEvent) => {
    updatePresence({ cursor: { x: e.clientX, y: e.clientY } });
  };

  return (
    <div onMouseMove={handleMouseMove}>
      {users.map((user) => (
        user.presence?.cursor && (
          <div
            key={user.id}
            style={{
              position: "absolute",
              left: user.presence.cursor.x,
              top: user.presence.cursor.y,
            }}
          >
            {user.name}
          </div>
        )
      ))}
    </div>
  );
}
```

Presence data is ephemeral (not persisted) and is used for transient information like cursor positions, typing indicators, selections, and online status. `updatePresence` performs a shallow merge with the existing presence data.

#### `useCollabFunction(roomId, functionName)` -- Server functions

```tsx
import { useCollabFunction } from "@collabkit/client";

function ClearButton() {
  const { call, loading, error, result } = useCollabFunction(
    "my-room",
    "clear_completed"
  );

  return (
    <button onClick={() => call()} disabled={loading}>
      {loading ? "Clearing..." : "Clear Completed"}
    </button>
  );
}
```

Calls a function registered on the server. The call has a 30-second timeout. Loading state and errors are tracked automatically.

#### `useScreenShare(roomId)` -- Screen sharing

```tsx
import { useScreenShare } from "@collabkit/client";

function ScreenSharePanel() {
  const {
    state,
    isSharing,
    hasActiveShare,
    annotations,
    startSharing,
    stopSharing,
    requestRemoteControl,
    grantRemoteControl,
    denyRemoteControl,
    revokeRemoteControl,
    sendAnnotation,
    clearAnnotations,
    error,
  } = useScreenShare("my-room");

  return (
    <div>
      {!hasActiveShare && (
        <button onClick={() => startSharing()}>Share Screen</button>
      )}
      {isSharing && (
        <button onClick={() => stopSharing()}>Stop Sharing</button>
      )}
      {state.role === "viewer" && state.remoteStreams.size > 0 && (
        <video
          autoPlay
          ref={(el) => {
            if (el) {
              const stream = state.remoteStreams.values().next().value;
              if (stream) el.srcObject = stream;
            }
          }}
        />
      )}
    </div>
  );
}
```

Screen sharing uses WebRTC for peer-to-peer video streaming. Features include:
- Multiple simultaneous viewers
- Remote control requests (viewer requests, sharer grants/denies)
- Freehand annotations over the shared screen via a data channel
- Cursor position broadcasting

### Vanilla Client API

For use outside React, instantiate `CollabkitClient` directly:

```typescript
import { CollabkitClient } from "@collabkit/client";

const client = new CollabkitClient({
  url: "ws://localhost:8000/ws",
  getToken: () => "my-auth-token",
  user: { id: "user-1", name: "Alice" },
});

// Connect
await client.connect();

// Join a room
client.joinRoom("my-room");

// Read and write state
client.setStateAtPath("my-room", "counter", 1);
const counter = client.getStateAtPath<number>("my-room", "counter");

// Subscribe to state changes
const unsub = client.subscribeToState("my-room", (state) => {
  console.log("State changed:", state);
});

// Presence
client.updatePresence("my-room", { cursor: { x: 100, y: 200 } });

const unsubPresence = client.subscribeToPresence("my-room", ({ users, presenceMap }) => {
  console.log("Users online:", users);
});

// Call server function
const result = await client.callFunction("my-room", "clear_completed", {});

// Connection state
client.subscribeToConnection((state) => {
  console.log("Connection:", state); // "disconnected" | "connecting" | "connected" | "error"
});

// Cleanup
client.leaveRoom("my-room");
client.disconnect();
```

### Offline Support

When the client is disconnected, operations are automatically queued in `localStorage` and replayed when the connection is restored.

```typescript
import { OfflineQueue } from "@collabkit/client";

const queue = new OfflineQueue("my-app"); // namespace for localStorage keys

// Queue is managed automatically by CollabkitClient, but can be used directly:
queue.enqueue("my-room", operation);
const pending = queue.peek("my-room");
const drained = queue.drain("my-room");

console.log(queue.size);     // Total queued operations
console.log(queue.isEmpty);  // Whether queue is empty

queue.pruneOld(24 * 60 * 60 * 1000); // Remove operations older than 24 hours
```

Constraints:
- Maximum 1000 queued operations
- Operations older than 24 hours are pruned automatically
- Queue is validated on load to prevent tampering

---

## Server (`collabkit`)

### Server Installation

```bash
cd python
pip install -e .
```

Requires Python 3.9+.

Dependencies: FastAPI, Uvicorn, WebSockets, Pydantic 2.0+, asyncpg (for PostgreSQL storage).

### Server Basic Setup

```python
from collabkit import CollabkitServer
from collabkit.auth import NoAuth
from collabkit.storage import MemoryStorage

storage = MemoryStorage()
server = CollabkitServer(
    auth_provider=NoAuth(),
    storage_backend=storage,
)

app = server.app  # FastAPI application

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8000)
```

Or mount onto an existing FastAPI app:

```python
from fastapi import FastAPI

app = FastAPI()
server = CollabkitServer(auth_provider=NoAuth(), storage_backend=MemoryStorage())
server.mount(app, prefix="/api/collab")
```

### Server Functions

Register functions that clients can call via `useCollabFunction` or `client.callFunction()`:

```python
@server.register_function("clear_completed")
async def clear_completed(room, user, args):
    """Remove all completed todos from the room state."""
    state = room.state.value()
    todos = state.get("todos", [])
    active = [t for t in todos if not t.get("completed")]
    room.state.set(["todos"], active, user.id)
    return {"removed": len(todos) - len(active)}

@server.register_function("get_word_count")
async def get_word_count(room, user, args):
    """Count words in the document."""
    state = room.state.value()
    text = state.get("document", {}).get("text", "")
    return {"words": len(text.split())}
```

Functions receive:
- `room` -- the `Room` instance (access `room.state` for the CRDT)
- `user` -- the authenticated user
- `args` -- arguments passed from the client

Functions can also be registered with auth and permission requirements:

```python
@server.register_function(
    name="delete_room",
    requires_auth=True,
    required_permissions=["admin"]
)
async def delete_room(room, user, args):
    ...
```

### Authentication

#### NoAuth (Development Only)

```python
from collabkit.auth import NoAuth

server = CollabkitServer(auth_provider=NoAuth())
```

Issues a warning on startup. Assigns a generated user ID to each connection.

#### JWT Authentication

```python
from collabkit.auth.jwt import JWTAuthProvider, create_token

auth = JWTAuthProvider(secret_key="your-secret-key")

# Create tokens for users
token = create_token(
    secret_key="your-secret-key",
    user_id="user-1",
    name="Alice",
    roles=["editor"],
    expires_in=3600,  # seconds
)

server = CollabkitServer(
    auth_provider=auth,
    require_auth=True,
)
```

Expected JWT payload:
```json
{
  "sub": "user-id",
  "name": "Alice",
  "roles": ["editor"],
  "exp": 1700000000
}
```

Supports HS256, RS256, and other algorithms supported by PyJWT.

#### Custom Auth Provider

```python
from collabkit.auth import AuthProvider, AuthUser

class MyAuthProvider(AuthProvider):
    async def authenticate(self, token: str) -> AuthUser:
        # Validate token against your auth system
        user_data = await verify_with_my_service(token)
        return AuthUser(id=user_data["id"], name=user_data["name"])
```

### Permissions

#### Simple RBAC

```python
from collabkit.permissions import PermissionManager, Permission, Role

perms = PermissionManager()

# Define roles
viewer = Role("viewer", {Permission.READ})
editor = Role("editor", {Permission.READ, Permission.WRITE})
admin = Role("admin", {Permission.READ, Permission.WRITE, Permission.DELETE, Permission.ADMIN})

# Assign roles to users per resource
perms.assign_role("user-1", "room-1", editor)
perms.assign_role("user-2", "room-1", viewer)

server = CollabkitServer(
    auth_provider=auth,
    permission_manager=perms,
)
```

#### Advanced RBAC with Flag-based Permissions

```python
from collabkit.permissions.rbac import RBACManager, Permission

rbac = RBACManager()

# Permission flags can be combined with bitwise OR
rbac.define_role("moderator", Permission.READ | Permission.WRITE | Permission.DELETE)

# Check permissions
rbac.check("moderator", Permission.WRITE)  # True
rbac.check("moderator", Permission.ADMIN)  # False
```

Built-in permission combinations: `VIEWER`, `EDITOR`, `MODERATOR`, `OWNER`.

#### Field-Level Permissions

```python
from collabkit.permissions.field_level import FieldRule, FieldPermissions, PermissionChecker

field_perms = FieldPermissions()

# Allow editors to modify user profiles
field_perms.add_rule(FieldRule(
    path_pattern="users.*.profile",
    allowed_roles=["editor", "admin"],
))

# Deny all roles from modifying system fields
field_perms.add_rule(FieldRule(
    path_pattern="settings.**",
    denied_roles=["viewer", "editor"],
))

# Conditional rules
field_perms.add_rule(FieldRule(
    path_pattern="users.{id}.profile",
    allowed_roles=["editor"],
    condition=lambda user, path: user.id == path.split(".")[1],  # Only own profile
))

checker = PermissionChecker(rbac=rbac, field_permissions=field_perms)
```

Rule evaluation order: field deny rules > field allow rules > RBAC fallback.

### Storage Backends

#### MemoryStorage (Development)

```python
from collabkit.storage import MemoryStorage

storage = MemoryStorage()
```

In-memory only. State is lost when the server restarts.

#### PostgresStorage (Production)

```python
from collabkit.storage.postgres import PostgresStorage

storage = PostgresStorage(
    host="localhost",
    port=5432,
    database="collabkit",
    user="postgres",
    password="secret",
)
```

Automatically creates the following tables on connect:
- `collabkit_rooms` -- Room state (JSONB), metadata, timestamps
- `collabkit_operations` -- Operation log for sync
- `collabkit_presence` -- User presence data

Connection pooling is configured with min=2, max=10 connections.

#### Custom Storage Backend

```python
from collabkit.storage.base import StorageBackend

class MyStorage(StorageBackend):
    async def save(self, key: str, data: dict) -> None: ...
    async def load(self, key: str) -> dict | None: ...
    async def delete(self, key: str) -> None: ...
    async def exists(self, key: str) -> bool: ...
    async def list_keys(self, prefix: str = "") -> list[str]: ...
```

### Server Configuration

All configuration is passed to the `CollabkitServer` constructor:

| Parameter | Default | Description |
|---|---|---|
| `auth_provider` | None | Authentication provider instance |
| `permission_manager` | None | Permission manager instance |
| `storage_backend` | None | Persistent storage backend |
| `path` | `"/ws"` | WebSocket endpoint path |
| `require_auth` | `False` | Require authentication for all connections |
| `allow_anonymous` | `False` | Allow unauthenticated users |
| `auto_create_rooms` | `True` | Create rooms on first join |
| `save_on_operation` | `False` | Persist state after every CRDT operation |
| `rate_limit` | `100` | Maximum messages per second per connection |
| `max_message_size` | `1048576` | Maximum message size in bytes (1 MB) |
| `message_timeout` | `60.0` | Idle timeout in seconds (sends ping, not disconnect) |
| `function_timeout` | `30.0` | Maximum server function execution time in seconds |
| `max_connections_per_user` | `10` | Maximum concurrent WebSocket connections per user |

---

## CRDT Types

CollabKit includes CRDT implementations on both client and server for conflict-free state synchronization.

### LWWMap (Last-Writer-Wins Map)

The primary data structure for shared state. Stores nested key-value pairs where concurrent writes to the same key are resolved by timestamp (highest wins), with node ID as a tiebreaker.

```typescript
// Client
import { LWWMap } from "@collabkit/client";

const map = new LWWMap("node-1", { counter: 0, user: { name: "Alice" } });
map.set(["counter"], 1);
map.set(["user", "name"], "Bob");
map.delete(["user", "name"]);
console.log(map.value()); // { counter: 1, user: {} }
```

```python
# Server
from collabkit.crdt.map import LWWMap

m = LWWMap("node-1", {"counter": 0})
m.set(["counter"], 1)
print(m.value())  # {"counter": 1}
```

### LWWRegister (Last-Writer-Wins Register)

Holds a single value. Useful when you need atomic replacement semantics.

```typescript
import { LWWRegister } from "@collabkit/client";

const reg = new LWWRegister<string>("node-1", "hello");
reg.set("world");
console.log(reg.value()); // "world"
```

### GCounter / PNCounter (Server only)

```python
from collabkit.crdt.counter import GCounter, PNCounter

# Grow-only counter
gc = GCounter("node-1")
gc.increment(5)
print(gc.value())  # 5

# Counter that supports increment and decrement
pn = PNCounter("node-1")
pn.increment(10)
pn.decrement(3)
print(pn.value())  # 7
```

### ORSet (Observed-Remove Set, Server only)

Add-wins semantics. Concurrent add and remove of the same element results in the element being present.

```python
from collabkit.crdt.set import ORSet

s = ORSet("node-1")
s.add("item-1")
s.add("item-2")
s.remove("item-1")
print(s.value())  # {"item-2"}
```

---

## Protocol Reference

Communication between client and server uses JSON messages over WebSocket. The full protocol is defined in `js/src/protocol.ts` (client) and `python/collabkit/protocol.py` (server).

### Connection Flow

1. Client opens WebSocket to `ws://host/ws`
2. Client sends `{ "type": "auth", "token": "<jwt>" }`
3. Server responds `{ "type": "authenticated", "user_id": "<id>" }`
4. Client sends `{ "type": "join", "roomId": "<room>" }` for each room
5. Server responds `{ "type": "joined", "roomId": "<room>", "state": {...}, "users": [...] }`
6. Bidirectional messages flow (operations, presence, function calls, etc.)
7. Client sends `ping` every 30 seconds to keep the connection alive

### Client-to-Server Messages

| Type | Purpose |
|---|---|
| `auth` | Authenticate with token |
| `join` | Join a room |
| `leave` | Leave a room |
| `operation` | Send a CRDT operation |
| `sync_request` | Request state synchronization |
| `call` | Call a server-side function |
| `presence` | Update presence data |
| `ping` | Keep-alive |
| `screenshare_start` | Start screen sharing |
| `screenshare_stop` | Stop screen sharing |
| `rtc_offer` / `rtc_answer` / `rtc_ice_candidate` | WebRTC signaling |
| `remote_control_request` / `remote_control_response` | Remote control |

### Server-to-Client Messages

| Type | Purpose |
|---|---|
| `authenticated` | Auth confirmation |
| `joined` | Room join confirmation with initial state |
| `operation` | Broadcast CRDT operation |
| `sync` | Full state synchronization |
| `call_result` | Function call result |
| `presence` | Broadcast presence update |
| `user_joined` / `user_left` | User lifecycle |
| `error` | Error response (with code and message) |
| `pong` | Keep-alive response |
| `screenshare_started` / `screenshare_stopped` | Screen share events |
| `rtc_offer` / `rtc_answer` / `rtc_ice_candidate` | WebRTC signaling relay |

### Error Codes

| Code | Description |
|---|---|
| `AUTHENTICATION_FAILED` | Invalid or expired token |
| `PERMISSION_DENIED` | User lacks required permissions |
| `ROOM_NOT_FOUND` | Room does not exist (when `auto_create_rooms` is false) |
| `INVALID_MESSAGE` | Malformed message |
| `INVALID_OPERATION` | Invalid CRDT operation |
| `FUNCTION_NOT_FOUND` | Called function is not registered |
| `FUNCTION_ERROR` | Function raised an exception |
| `RATE_LIMITED` | Too many messages per second |
| `INTERNAL_ERROR` | Unexpected server error |

---

## Examples

The `examples/` directory contains four complete demo applications, each with a React frontend and Python backend:

### Todo App (`examples/todo-app/`)
Collaborative todo list with real-time sync. Demonstrates `useCollabState` for shared state and `useCollabFunction` for server-side operations like clearing completed items.

**Backend port:** 8000

### Chat App (`examples/chat-app/`)
Real-time chat with message history, input validation (1000 char limit), and presence-based user badges. Enforces a 500 message limit.

**Backend port:** 8002

### Text Editor (`examples/text-editor/`)
Collaborative document editing with character/word/line counts, last editor tracking, and server-side word count function.

**Backend port:** 8001

### Combined Demo (`examples/combined-demo/`)
Comprehensive showcase of all library features in a single app with five rooms:
- **Todos** -- Shared todo list
- **Editor** -- Collaborative text editing
- **Chat** -- Real-time messaging
- **Screen Share** -- Screen capture with remote control and annotations
- **Lobby** -- Global presence and user tracking

**Backend port:** 8010

### Running an Example

```bash
# Terminal 1: Start the backend
cd examples/todo-app/backend
pip install -e ../../../python
python main.py

# Terminal 2: Start the frontend
cd examples/todo-app/frontend
npm install
npm run dev
```

The frontend Vite config proxies `/ws` to the backend server and aliases `@collabkit/client` to the local source for development.

---

## Security

CollabKit includes several security measures:

### Prototype Pollution Prevention
All CRDT paths and values are validated to reject dangerous keys (`__proto__`, `constructor`, `prototype`, `__class__`). Underscore-prefixed keys are also rejected. Validation is applied on both client and server.

### Token Security
Auth tokens are sent in the WebSocket message body (not in the URL query string) to prevent exposure in server logs and browser history.

### Rate Limiting
The server enforces per-connection rate limits (default: 100 messages/second) using a token bucket algorithm. Authentication attempts are also rate-limited to prevent brute force attacks (5 failed attempts triggers a 5-minute lockout).

### Message Validation
All incoming messages are validated with Pydantic on the server side:
- Maximum message size: 1 MB
- Maximum nesting depth: 5 levels
- Maximum value size: 100 KB
- Function names must match `^[a-zA-Z_][a-zA-Z0-9_]*$`

### Offline Queue Validation
The client validates all operations loaded from localStorage on startup, discarding any corrupted or tampered entries.

### Server-Side Timestamps
The server can override client-provided timestamps on CRDT operations (`use_server_timestamp=True`) to prevent clock manipulation.

---

## License

See [LICENSE](LICENSE) for details.
