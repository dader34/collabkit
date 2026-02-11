import React, { useState, useCallback } from 'react';
import {
  useRoom,
  useCollabState,
  usePresence,
  useCollabFunction,
} from '@collabkit/client/react';
import { Button, Input, Checkbox } from '@dader34/stylekit-ui';

interface Todo {
  id: string;
  text: string;
  done: boolean;
  createdBy: string;
}

// Input validation constants
const MAX_TODO_TEXT_LENGTH = 500;
const MAX_TODOS_COUNT = 100;

interface AppProps {
  userId: string;
}

const ROOM_ID = 'shared-todos';

export default function App({ userId }: AppProps) {
  const { status, error } = useRoom(ROOM_ID);

  if (status === 'connecting') {
    return <div className="loading">Connecting to collaboration server...</div>;
  }

  if (status === 'error') {
    // Don't expose raw error messages to users
    return <div className="error">Connection error. Please try refreshing the page.</div>;
  }

  return (
    <div className="app">
      <header>
        <h1>Collaborative Todos</h1>
        <p className="subtitle">
          Open this page in multiple tabs to see real-time sync!
        </p>
      </header>
      <OnlineUsers roomId={ROOM_ID} currentUserId={userId} />
      <TodoList roomId={ROOM_ID} userId={userId} />
    </div>
  );
}

function OnlineUsers({
  roomId,
  currentUserId,
}: {
  roomId: string;
  currentUserId: string;
}) {
  const { users, updatePresence } = usePresence(roomId);

  // Update presence with user color on mount
  React.useEffect(() => {
    const colors = ['#e74c3c', '#3498db', '#2ecc71', '#f39c12', '#9b59b6'];
    const color = colors[Math.floor(Math.random() * colors.length)];
    updatePresence({ color, name: currentUserId });
  }, [currentUserId, updatePresence]);

  return (
    <div className="online-users">
      <span className="label">Online:</span>
      {users.map((user) => (
        <span
          key={user.id}
          className="user-badge"
          style={{ backgroundColor: (user.presence as any)?.color || '#888' }}
          title={user.id}
        >
          {user.id === currentUserId ? 'You' : user.id.slice(0, 8)}
        </span>
      ))}
    </div>
  );
}

function TodoList({ roomId, userId }: { roomId: string; userId: string }) {
  const [todos, setTodos] = useCollabState<Todo[]>(roomId, ['todos']);
  const [newTodoText, setNewTodoText] = useState('');

  const { call: clearCompleted, loading: clearingCompleted } =
    useCollabFunction<void, { cleared: number }>(roomId, 'clear_completed');

  const { call: toggleAll, loading: togglingAll } =
    useCollabFunction<void, { all_done: boolean }>(roomId, 'toggle_all');

  const handleAddTodo = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const trimmedText = newTodoText.trim();

      // Input validation
      if (!trimmedText) return;
      if (trimmedText.length > MAX_TODO_TEXT_LENGTH) {
        alert(`Todo text must be ${MAX_TODO_TEXT_LENGTH} characters or less`);
        return;
      }
      if ((todos || []).length >= MAX_TODOS_COUNT) {
        alert(`Maximum ${MAX_TODOS_COUNT} todos allowed`);
        return;
      }

      const newTodo: Todo = {
        // Use crypto.randomUUID for secure, non-predictable IDs
        id: `todo-${crypto.randomUUID()}`,
        text: trimmedText,
        done: false,
        createdBy: userId,
      };

      setTodos([...(todos || []), newTodo]);
      setNewTodoText('');
    },
    [newTodoText, todos, setTodos, userId]
  );

  const handleToggle = useCallback(
    (id: string) => {
      if (!todos) return;
      setTodos(
        todos.map((t) => (t.id === id ? { ...t, done: !t.done } : t))
      );
    },
    [todos, setTodos]
  );

  const handleDelete = useCallback(
    (id: string) => {
      if (!todos) return;
      setTodos(todos.filter((t) => t.id !== id));
    },
    [todos, setTodos]
  );

  const handleClearCompleted = useCallback(async () => {
    try {
      await clearCompleted(undefined);
    } catch {
      // Handle error silently in production
      // In a real app, show a user-friendly error message
    }
  }, [clearCompleted]);

  const handleToggleAll = useCallback(async () => {
    try {
      await toggleAll(undefined);
    } catch {
      // Handle error silently in production
      // In a real app, show a user-friendly error message
    }
  }, [toggleAll]);

  const todoList = todos || [];
  const completedCount = todoList.filter((t) => t.done).length;
  const activeCount = todoList.length - completedCount;

  return (
    <div className="todo-container">
      <form onSubmit={handleAddTodo} className="add-todo-form">
        <Input
          value={newTodoText}
          onChange={(e) => setNewTodoText(e.target.value)}
          placeholder="What needs to be done?"
          className="todo-input"
        />
        <Button type="submit" variant="primary" className="add-btn">
          Add
        </Button>
      </form>

      {todoList.length > 0 && (
        <>
          <div className="todo-actions">
            <Button
              onClick={handleToggleAll}
              disabled={togglingAll}
              variant="secondary"
              className="action-btn"
            >
              {togglingAll ? 'Toggling...' : 'Toggle All'}
            </Button>
            {completedCount > 0 && (
              <Button
                onClick={handleClearCompleted}
                disabled={clearingCompleted}
                variant="destructive"
                className="action-btn danger"
              >
                {clearingCompleted
                  ? 'Clearing...'
                  : `Clear Completed (${completedCount})`}
              </Button>
            )}
          </div>

          <ul className="todo-list">
            {todoList.map((todo) => (
              <li key={todo.id} className={`todo-item ${todo.done ? 'done' : ''}`}>
                <Checkbox
                  checked={todo.done}
                  onChange={() => handleToggle(todo.id)}
                  className="todo-checkbox"
                />
                <span className="todo-text">{todo.text}</span>
                <span className="todo-author">by {todo.createdBy.slice(0, 8)}</span>
                <Button
                  onClick={() => handleDelete(todo.id)}
                  variant="destructive"
                  className="delete-btn"
                  title="Delete"
                >
                  ×
                </Button>
              </li>
            ))}
          </ul>

          <div className="todo-footer">
            <span>
              {activeCount} item{activeCount !== 1 ? 's' : ''} left
            </span>
          </div>
        </>
      )}

      {todoList.length === 0 && (
        <p className="empty-state">No todos yet. Add one above!</p>
      )}
    </div>
  );
}
