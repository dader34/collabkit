import React, { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import {
  useRoom,
  useCollabState,
  usePresence,
  useScreenShare,
} from '@collabkit/client/react';
import type { Annotation } from '@collabkit/client';
import { Button, Input, Checkbox } from '@dader34/stylekit-ui';

// ============================================================================
// Types
// ============================================================================

interface Todo {
  id: string;
  text: string;
  done: boolean;
  createdBy: string;
}

interface Document {
  text: string;
  lastEditedBy: string;
  lastEditedAt: number;
}

interface Message {
  id: string;
  text: string;
  author: string;
  timestamp: number;
}

type DemoType = 'todos' | 'editor' | 'chat' | 'users' | 'screenshare';

interface AppProps {
  userId: string;
}

// ============================================================================
// Constants
// ============================================================================

const MAX_TODO_TEXT_LENGTH = 500;
const MAX_DOCUMENT_LENGTH = 50000;
const MAX_MESSAGE_LENGTH = 1000;
const MAX_MESSAGES_COUNT = 500;

const DEMOS: { id: DemoType; label: string; room: string }[] = [
  { id: 'todos', label: 'Todos', room: 'demo-todos' },
  { id: 'editor', label: 'Text Editor', room: 'demo-editor' },
  { id: 'chat', label: 'Chat', room: 'demo-chat' },
  { id: 'screenshare', label: 'Screen Share', room: 'demo-screenshare' },
  { id: 'users', label: 'Users', room: 'demo-lobby' },
];

// ============================================================================
// Global Presence - Join all rooms at app level
// ============================================================================

function GlobalPresence({ userId }: { userId: string }) {
  const userColor = getUserColor(userId);
  const presenceData = { color: userColor, name: userId };

  // usePresence joins rooms automatically
  const { updatePresence: updateTodos } = usePresence('demo-todos');
  const { updatePresence: updateEditor } = usePresence('demo-editor');
  const { updatePresence: updateChat } = usePresence('demo-chat');
  const { updatePresence: updateLobby } = usePresence('demo-lobby');
  const { updatePresence: updateScreenshare } = usePresence('demo-screenshare');

  // Set presence immediately on mount and keep it updated
  useEffect(() => {
    // Set immediately
    updateTodos(presenceData);
    updateEditor(presenceData);
    updateChat(presenceData);
    updateLobby(presenceData);
    updateScreenshare(presenceData);

    // Keep alive with interval
    const interval = setInterval(() => {
      updateTodos(presenceData);
      updateEditor(presenceData);
      updateChat(presenceData);
      updateLobby(presenceData);
      updateScreenshare(presenceData);
    }, 2000);

    return () => clearInterval(interval);
  }, [userId, userColor, updateTodos, updateEditor, updateChat, updateLobby, updateScreenshare]);

  return null;
}

// ============================================================================
// Main App
// ============================================================================

export default function App({ userId }: AppProps) {
  const [activeDemo, setActiveDemo] = useState<DemoType>(() => {
    const saved = localStorage.getItem('activeDemo');
    return (saved as DemoType) || 'todos';
  });

  // Persist active tab
  useEffect(() => {
    localStorage.setItem('activeDemo', activeDemo);
  }, [activeDemo]);

  const currentDemo = DEMOS.find(d => d.id === activeDemo)!;

  return (
    <div className="app-wrapper">
      {/* Join all rooms and set presence globally */}
      <GlobalPresence userId={userId} />

      <nav className="main-nav">
        <div className="nav-brand">
          <h1>Collabkit</h1>
          <span className="nav-tagline">Real-time Collaboration</span>
        </div>
        <div className="nav-tabs">
          {DEMOS.map((demo) => (
            <Button
              key={demo.id}
              variant={activeDemo === demo.id ? 'secondary' : 'ghost'}
              className={`nav-tab ${activeDemo === demo.id ? 'active' : ''}`}
              onClick={() => setActiveDemo(demo.id)}
            >
              {demo.label}
            </Button>
          ))}
        </div>
        <div className="nav-user">
          <span className="user-id">{userId.slice(0, 12)}</span>
        </div>
      </nav>

      <main className="main-content">
        <DemoRoom
          key={currentDemo.room}
          roomId={currentDemo.room}
          demoType={activeDemo}
          userId={userId}
        />
      </main>
    </div>
  );
}

// ============================================================================
// Demo Room Wrapper
// ============================================================================

function DemoRoom({
  roomId,
  demoType,
  userId,
}: {
  roomId: string;
  demoType: DemoType;
  userId: string;
}) {
  const { status } = useRoom(roomId);

  if (status === 'connecting') {
    return <div className="loading">Connecting to collaboration server...</div>;
  }

  if (status === 'error') {
    return <div className="error">Connection error. Please try refreshing the page.</div>;
  }

  return (
    <div className="demo-container">
      <OnlineUsers roomId={roomId} currentUserId={userId} />
      {demoType === 'todos' && <TodoList roomId={roomId} userId={userId} />}
      {demoType === 'editor' && <TextEditor roomId={roomId} userId={userId} />}
      {demoType === 'chat' && <ChatRoom roomId={roomId} userId={userId} />}
      {demoType === 'screenshare' && <ScreenShareDemo roomId={roomId} userId={userId} />}
      {demoType === 'users' && <UsersPanel roomId={roomId} userId={userId} />}
    </div>
  );
}

// ============================================================================
// Shared Utilities
// ============================================================================

const USER_COLORS = ['#e74c3c', '#3498db', '#2ecc71', '#f39c12', '#9b59b6'];

function getUserColor(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = ((hash << 5) - hash) + userId.charCodeAt(i);
    hash |= 0;
  }
  return USER_COLORS[Math.abs(hash) % USER_COLORS.length];
}

// ============================================================================
// Online Users Component (Shared)
// ============================================================================

function OnlineUsers({
  roomId,
  currentUserId,
}: {
  roomId: string;
  currentUserId: string;
}) {
  const { users, myPresence } = usePresence(roomId);
  const userColor = useMemo(() => getUserColor(currentUserId), [currentUserId]);

  // Filter out users without presence data (ghost connections)
  // but always include current user
  const visibleUsers = useMemo(() => {
    const currentUserPresence = myPresence as { color?: string; name?: string } | undefined;

    // Create a list starting with current user (to show "You" immediately)
    const result: Array<{
      id: string;
      isCurrentUser: boolean;
      displayName: string;
      color: string;
    }> = [{
      id: 'self',
      isCurrentUser: true,
      displayName: currentUserId,
      color: currentUserPresence?.color || userColor,
    }];

    // Add other users in the room
    users.forEach((user) => {
      const presence = user.presence as { color?: string; name?: string } | undefined;
      // Skip if it's the current user (check both presence name and user id patterns)
      if (presence?.name === currentUserId) return;
      // Also skip if user id contains the current user's id (token-based matching)
      if (user.id.includes(currentUserId)) return;

      const displayName = presence?.name || user.id;
      result.push({
        id: user.id,
        isCurrentUser: false,
        displayName,
        color: presence?.color || getUserColor(displayName),
      });
    });

    return result;
  }, [users, myPresence, currentUserId, userColor]);

  return (
    <div className="online-users">
      <span className="label">Online:</span>
      {visibleUsers.map((user) => (
        <span
          key={user.id}
          className="user-badge"
          style={{ backgroundColor: user.color }}
          title={user.displayName}
        >
          {user.isCurrentUser ? 'You' : user.displayName.slice(5, 13)}
        </span>
      ))}
    </div>
  );
}

// ============================================================================
// Todo List Demo
// ============================================================================

function TodoList({ roomId, userId }: { roomId: string; userId: string }) {
  const [todos, setTodos] = useCollabState<Todo[]>(roomId, ['todos']);
  const [newTodoText, setNewTodoText] = useState('');
  const { users, updatePresence } = usePresence(roomId);
  const inputRef = useRef<HTMLInputElement>(null);

  const userColor = useMemo(() => getUserColor(userId), [userId]);

  // Track focus state
  const handleFocus = useCallback(() => {
    updatePresence({ color: userColor, name: userId, activity: 'typing' });
  }, [updatePresence, userColor, userId]);

  const handleBlur = useCallback(() => {
    updatePresence({ color: userColor, name: userId, activity: 'idle' });
  }, [updatePresence, userColor, userId]);

  // Get other users who are typing
  const typingUsers = useMemo(() => {
    return users
      .filter((user) => {
        const presence = user.presence as { name?: string; activity?: string } | undefined;
        return presence?.activity === 'typing' && presence?.name !== userId;
      })
      .map((user) => {
        const presence = user.presence as { name?: string; color?: string } | undefined;
        return {
          name: presence?.name?.slice(5, 13) || user.id.slice(0, 8),
          color: presence?.color || '#888',
        };
      });
  }, [users, userId]);

  const handleAddTodo = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      if (!newTodoText.trim()) return;
      if (newTodoText.length > MAX_TODO_TEXT_LENGTH) {
        alert(`Todo must be ${MAX_TODO_TEXT_LENGTH} characters or less`);
        return;
      }

      const newTodo: Todo = {
        id: `todo-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        text: newTodoText.trim(),
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
      setTodos(todos.map((t) => (t.id === id ? { ...t, done: !t.done } : t)));
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

  const handleToggleAll = useCallback(() => {
    if (!todos || todos.length === 0) return;
    const allDone = todos.every((t) => t.done);
    setTodos(todos.map((t) => ({ ...t, done: !allDone })));
  }, [todos, setTodos]);

  const handleClearCompleted = useCallback(() => {
    if (!todos) return;
    setTodos(todos.filter((t) => !t.done));
  }, [todos, setTodos]);

  const todoList = todos || [];
  const completedCount = todoList.filter((t) => t.done).length;
  const activeCount = todoList.length - completedCount;

  return (
    <div className="todo-container">
      <div className="demo-header">
        <h2>Collaborative Todos</h2>
        <p className="demo-subtitle">Add and manage tasks together in real-time</p>
      </div>

      <form onSubmit={handleAddTodo} className="add-todo-form">
        <div className="input-wrapper">
          <Input
            ref={inputRef}
            value={newTodoText}
            onChange={(e) => setNewTodoText(e.target.value)}
            onFocus={handleFocus}
            onBlur={handleBlur}
            placeholder="What needs to be done?"
            className="todo-input"
          />
          {typingUsers.length > 0 && (
            <div className="typing-indicators">
              {typingUsers.map((user, i) => (
                <span
                  key={i}
                  className="typing-indicator"
                  style={{ backgroundColor: user.color }}
                >
                  {user.name}
                </span>
              ))}
              <span className="typing-text">typing...</span>
            </div>
          )}
        </div>
        <Button type="submit" variant="primary" className="add-btn">
          Add
        </Button>
      </form>

      {todoList.length > 0 && (
        <>
          <div className="todo-actions">
            <Button onClick={handleToggleAll} variant="secondary" className="action-btn">
              Toggle All
            </Button>
            {completedCount > 0 && (
              <Button onClick={handleClearCompleted} variant="destructive" className="action-btn danger">
                Clear Completed ({completedCount})
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

// ============================================================================
// Text Editor Demo
// ============================================================================

interface CursorPresence {
  color: string;
  name: string;
  cursorPosition?: number;
  selectionStart?: number;
  selectionEnd?: number;
}

function TextEditor({ roomId, userId }: { roomId: string; userId: string }) {
  const [document, setDocument] = useCollabState<Document>(roomId, ['document']);
  const { users, updatePresence } = usePresence(roomId);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const editorWrapperRef = useRef<HTMLDivElement>(null);
  const [localSelection, setLocalSelection] = useState({ start: 0, end: 0 });

  // Assign a consistent color to this user
  const userColor = useMemo(() => getUserColor(userId), [userId]);

  // Update presence with cursor position
  const updateCursorPresence = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    updatePresence({
      color: userColor,
      name: userId,
      cursorPosition: textarea.selectionEnd,
      selectionStart: textarea.selectionStart,
      selectionEnd: textarea.selectionEnd,
    });

    setLocalSelection({
      start: textarea.selectionStart,
      end: textarea.selectionEnd,
    });
  }, [updatePresence, userColor, userId]);

  // Set up cursor tracking
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const handleSelectionChange = () => {
      updateCursorPresence();
    };

    textarea.addEventListener('select', handleSelectionChange);
    textarea.addEventListener('click', handleSelectionChange);
    textarea.addEventListener('keyup', handleSelectionChange);

    // Initial presence update
    updateCursorPresence();

    return () => {
      textarea.removeEventListener('select', handleSelectionChange);
      textarea.removeEventListener('click', handleSelectionChange);
      textarea.removeEventListener('keyup', handleSelectionChange);
    };
  }, [updateCursorPresence]);

  const handleTextChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const newText = e.target.value;
      if (newText.length > MAX_DOCUMENT_LENGTH) {
        alert(`Document must be ${MAX_DOCUMENT_LENGTH} characters or less`);
        return;
      }

      setDocument({
        text: newText,
        lastEditedBy: userId,
        lastEditedAt: Date.now(),
      });

      // Update cursor position after text change
      setTimeout(updateCursorPresence, 0);
    },
    [setDocument, userId, updateCursorPresence]
  );

  const text = document?.text || '';

  const stats = useMemo(() => {
    const charCount = text.length;
    const wordCount = text.trim() ? text.trim().split(/\s+/).length : 0;
    const lineCount = text ? text.split('\n').length : 0;
    return { charCount, wordCount, lineCount };
  }, [text]);

  const lastEditInfo = useMemo(() => {
    if (!document?.lastEditedBy || !document?.lastEditedAt) return null;
    const time = new Date(document.lastEditedAt).toLocaleTimeString();
    const editor = document.lastEditedBy.slice(0, 8);
    return { editor, time };
  }, [document?.lastEditedBy, document?.lastEditedAt]);

  // Get all users' cursor positions (including self)
  const allUsersCursors = useMemo(() => {
    return users
      .map((user) => {
        const presence = user.presence as CursorPresence | undefined;
        // Check both user.id and presence.name to identify current user
        const isCurrentUser = user.id === userId || presence?.name === userId;
        return {
          id: user.id,
          name: presence?.name?.slice(0, 8) || user.id.slice(0, 8),
          color: presence?.color || '#888',
          cursorPosition: presence?.cursorPosition ?? 0,
          selectionStart: presence?.selectionStart ?? 0,
          selectionEnd: presence?.selectionEnd ?? 0,
          isCurrentUser,
        };
      })
      .filter((u) => u.cursorPosition !== undefined);
  }, [users, userId]);

  // Calculate cursor position in pixels using character/line counting
  const getCursorCoordinates = useCallback((position: number): { top: number; left: number } | null => {
    const textarea = textareaRef.current;
    if (!textarea || position < 0) return null;

    const computed = window.getComputedStyle(textarea);
    const lineHeight = parseFloat(computed.lineHeight) || 25.6; // 1rem * 1.6 line-height
    const paddingTop = parseFloat(computed.paddingTop) || 24;
    const paddingLeft = parseFloat(computed.paddingLeft) || 24;

    // Get text up to cursor position
    const textBeforeCursor = text.slice(0, position);

    // Count lines (split by newline)
    const lines = textBeforeCursor.split('\n');
    const lineNumber = lines.length - 1;
    const currentLineText = lines[lines.length - 1];

    // Create a temporary span to measure text width
    const measureSpan = window.document.createElement('span');
    measureSpan.style.cssText = `
      position: absolute;
      visibility: hidden;
      white-space: pre;
      font-family: ${computed.fontFamily};
      font-size: ${computed.fontSize};
      letter-spacing: ${computed.letterSpacing};
    `;
    measureSpan.textContent = currentLineText;
    window.document.body.appendChild(measureSpan);
    const textWidth = measureSpan.getBoundingClientRect().width;
    window.document.body.removeChild(measureSpan);

    return {
      top: paddingTop + (lineNumber * lineHeight) - textarea.scrollTop,
      left: paddingLeft + textWidth,
    };
  }, [text]);

  return (
    <div className="editor-container">
      <div className="demo-header">
        <h2>Collaborative Text Editor</h2>
        <p className="demo-subtitle">Edit documents together in real-time</p>
      </div>

      <div className="editor-meta">
        <span className="document-title">Shared Document</span>
        {lastEditInfo && (
          <span className="last-edit">
            Last edit by {lastEditInfo.editor} at {lastEditInfo.time}
          </span>
        )}
      </div>

      <div className="editor-wrapper" ref={editorWrapperRef}>
        <textarea
          ref={textareaRef}
          value={text}
          onChange={handleTextChange}
          onSelect={updateCursorPresence}
          placeholder="Start typing... All connected users can edit this document in real-time."
          className="editor-textarea"
          spellCheck={false}
        />

        {/* Render all users' cursors (including own) */}
        {allUsersCursors.map((cursor) => {
          const coords = getCursorCoordinates(cursor.cursorPosition);
          if (!coords) return null;

          return (
            <div
              key={cursor.id}
              className={`remote-cursor ${cursor.isCurrentUser ? 'own-cursor' : ''}`}
              style={{
                top: coords.top,
                left: coords.left,
              }}
            >
              <div className="cursor-caret" style={{ backgroundColor: cursor.color }} />
              {!cursor.isCurrentUser && (
                <div className="cursor-label" style={{ backgroundColor: cursor.color }}>
                  {cursor.name}
                </div>
              )}
            </div>
          );
        })}

        {/* Render all users' selections */}
        {allUsersCursors.map((cursor) => {
          if (cursor.selectionStart === cursor.selectionEnd) return null;

          const start = Math.min(cursor.selectionStart, cursor.selectionEnd);
          const end = Math.max(cursor.selectionStart, cursor.selectionEnd);
          const selectedText = text.slice(start, end);

          // For multi-line selections, we need to render multiple highlight spans
          const lines = selectedText.split('\n');
          let currentPos = start;

          return (
            <div key={`selection-${cursor.id}`} className="remote-selection">
              {lines.map((line, lineIndex) => {
                const lineStart = currentPos;
                currentPos += line.length + (lineIndex < lines.length - 1 ? 1 : 0);

                const startCoords = getCursorCoordinates(lineStart);
                const endCoords = getCursorCoordinates(lineStart + line.length);

                if (!startCoords || !endCoords) return null;

                return (
                  <div
                    key={`${cursor.id}-line-${lineIndex}`}
                    className="selection-highlight"
                    style={{
                      top: startCoords.top,
                      left: startCoords.left,
                      width: Math.max(endCoords.left - startCoords.left, 6),
                      height: 22,
                      backgroundColor: cursor.color,
                      opacity: 0.35,
                    }}
                  />
                );
              })}
            </div>
          );
        })}
      </div>

      <div className="editor-footer">
        <div className="stats">
          <span className="stat">
            <span className="stat-value">{stats.charCount.toLocaleString()}</span>
            <span className="stat-label">Chars</span>
          </span>
          <span className="stat">
            <span className="stat-value">{stats.wordCount.toLocaleString()}</span>
            <span className="stat-label">Words</span>
          </span>
          <span className="stat">
            <span className="stat-value">{stats.lineCount.toLocaleString()}</span>
            <span className="stat-label">Lines</span>
          </span>
        </div>
        <div className="limit-info">
          {stats.charCount.toLocaleString()} / {MAX_DOCUMENT_LENGTH.toLocaleString()} max
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Chat Room Demo
// ============================================================================

function ChatRoom({ roomId, userId }: { roomId: string; userId: string }) {
  const [messages, setMessages] = useCollabState<Message[]>(roomId, ['messages']);
  const [newMessageText, setNewMessageText] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const { users, updatePresence } = usePresence(roomId);

  const userColor = useMemo(() => getUserColor(userId), [userId]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Track typing state
  const handleFocus = useCallback(() => {
    updatePresence({ color: userColor, name: userId, activity: 'typing' });
  }, [updatePresence, userColor, userId]);

  const handleBlur = useCallback(() => {
    updatePresence({ color: userColor, name: userId, activity: 'idle' });
  }, [updatePresence, userColor, userId]);

  // Get other users who are typing
  const typingUsers = useMemo(() => {
    return users
      .filter((user) => {
        const presence = user.presence as { name?: string; activity?: string } | undefined;
        return presence?.activity === 'typing' && presence?.name !== userId;
      })
      .map((user) => {
        const presence = user.presence as { name?: string; color?: string } | undefined;
        return {
          name: presence?.name?.slice(5, 13) || user.id.slice(0, 8),
          color: presence?.color || '#888',
        };
      });
  }, [users, userId]);

  const handleSendMessage = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const trimmedText = newMessageText.trim();

      if (!trimmedText) return;
      if (trimmedText.length > MAX_MESSAGE_LENGTH) {
        alert(`Message must be ${MAX_MESSAGE_LENGTH} characters or less`);
        return;
      }

      const currentMessages = messages || [];
      let updatedMessages = [...currentMessages];
      if (updatedMessages.length >= MAX_MESSAGES_COUNT) {
        updatedMessages = updatedMessages.slice(-MAX_MESSAGES_COUNT + 1);
      }

      const newMessage: Message = {
        id: `msg-${crypto.randomUUID()}`,
        text: trimmedText,
        author: userId,
        timestamp: Date.now(),
      };

      setMessages([...updatedMessages, newMessage]);
      setNewMessageText('');
    },
    [newMessageText, messages, setMessages, userId]
  );

  const formatTimestamp = (timestamp: number): string => {
    const date = new Date(timestamp);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const messageList = messages || [];

  return (
    <div className="chat-container">
      <div className="demo-header">
        <h2>Live Chat</h2>
        <p className="demo-subtitle">One big room for everyone</p>
      </div>

      <div className="messages-list">
        {messageList.length === 0 && (
          <p className="empty-state">No messages yet. Start the conversation!</p>
        )}
        {messageList.map((message) => (
          <div
            key={message.id}
            className={`message ${message.author === userId ? 'own-message' : ''}`}
          >
            <div className="message-header">
              <span className="message-author">
                {message.author === userId ? 'You' : message.author.slice(0, 8)}
              </span>
              <span className="message-time">{formatTimestamp(message.timestamp)}</span>
            </div>
            <div className="message-text">{message.text}</div>
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>

      <form onSubmit={handleSendMessage} className="send-message-form">
        <div className="input-wrapper chat-input-wrapper">
          <Input
            value={newMessageText}
            onChange={(e) => setNewMessageText(e.target.value)}
            onFocus={handleFocus}
            onBlur={handleBlur}
            placeholder="Type your message..."
            className="message-input"
            maxLength={MAX_MESSAGE_LENGTH}
          />
          {typingUsers.length > 0 && (
            <div className="typing-indicators">
              {typingUsers.map((user, i) => (
                <span
                  key={i}
                  className="typing-indicator"
                  style={{ backgroundColor: user.color }}
                >
                  {user.name}
                </span>
              ))}
              <span className="typing-text">typing...</span>
            </div>
          )}
        </div>
        <Button type="submit" variant="primary" className="send-btn">
          Send
        </Button>
      </form>
    </div>
  );
}

// ============================================================================
// Screen Share Demo
// ============================================================================

function ScreenShareDemo({ roomId, userId }: { roomId: string; userId: string }) {
  const {
    state,
    isSharing,
    hasActiveShare,
    annotations,
    error,
    startSharing,
    stopSharing,
    requestRemoteControl,
    grantRemoteControl,
    denyRemoteControl,
    revokeRemoteControl,
    sendAnnotation,
    clearAnnotations,
  } = useScreenShare(roomId);

  const videoRef = useRef<HTMLVideoElement>(null);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [annotationMode, setAnnotationMode] = useState(false);
  const [isDrawing, setIsDrawing] = useState(false);
  const drawingPoints = useRef<Array<{ x: number; y: number }>>([]);

  const userColor = useMemo(() => getUserColor(userId), [userId]);
  const { users } = usePresence(roomId);

  // Attach remote stream to video element
  useEffect(() => {
    if (videoRef.current && state.remoteStreams.size > 0) {
      const stream = state.remoteStreams.values().next().value;
      if (stream && videoRef.current.srcObject !== stream) {
        videoRef.current.srcObject = stream;
      }
    }
  }, [state.remoteStreams]);

  // Attach local stream preview
  useEffect(() => {
    if (localVideoRef.current && state.localStream) {
      localVideoRef.current.srcObject = state.localStream;
    }
  }, [state.localStream]);

  // Draw annotations on canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Match canvas dimensions to its display size
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width;
    canvas.height = rect.height;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    for (const ann of annotations) {
      if (ann.type === 'freehand' && ann.points && ann.points.length > 1) {
        ctx.beginPath();
        ctx.strokeStyle = ann.color;
        ctx.lineWidth = 3;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        const first = ann.points[0];
        ctx.moveTo(first.x * canvas.width, first.y * canvas.height);
        for (let i = 1; i < ann.points.length; i++) {
          const p = ann.points[i];
          ctx.lineTo(p.x * canvas.width, p.y * canvas.height);
        }
        ctx.stroke();
      }
    }
  }, [annotations]);

  // Annotation drawing handlers
  const handleAnnotationStart = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!annotationMode) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    setIsDrawing(true);
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    drawingPoints.current = [{ x, y }];
  }, [annotationMode]);

  const handleAnnotationMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!isDrawing || !annotationMode) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    drawingPoints.current.push({ x, y });

    // Draw in real-time
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const points = drawingPoints.current;
    if (points.length < 2) return;

    const prev = points[points.length - 2];
    const curr = points[points.length - 1];
    ctx.beginPath();
    ctx.strokeStyle = userColor;
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.moveTo(prev.x * canvas.width, prev.y * canvas.height);
    ctx.lineTo(curr.x * canvas.width, curr.y * canvas.height);
    ctx.stroke();
  }, [isDrawing, annotationMode, userColor]);

  const handleAnnotationEnd = useCallback(() => {
    if (!isDrawing) return;
    setIsDrawing(false);

    if (drawingPoints.current.length > 1) {
      sendAnnotation({
        type: 'freehand',
        color: userColor,
        points: [...drawingPoints.current],
      });
    }
    drawingPoints.current = [];
  }, [isDrawing, sendAnnotation, userColor]);

  // Get sharer's display name
  const sharerName = useMemo(() => {
    if (!state.sharerId) return null;
    if (state.sharerId === userId) return 'You';
    const sharerUser = users.find(u => {
      const p = u.presence as { name?: string } | undefined;
      return u.id === state.sharerId || p?.name === state.sharerId;
    });
    const presence = sharerUser?.presence as { name?: string } | undefined;
    const name = presence?.name || state.sharerId;
    return name.startsWith('user-') ? name.slice(5, 13) : name.slice(0, 8);
  }, [state.sharerId, userId, users]);

  return (
    <div className="screenshare-container">
      <div className="demo-header">
        <h2>Screen Sharing</h2>
        <p className="demo-subtitle">Share your screen with everyone in the room</p>
      </div>

      {/* Controls */}
      <div className="screenshare-controls">
        {!hasActiveShare && (
          <Button onClick={() => startSharing()} variant="primary" className="share-btn">
            Share Screen
          </Button>
        )}
        {isSharing && (
          <>
            <Button onClick={stopSharing} variant="destructive" className="action-btn danger">
              Stop Sharing
            </Button>
            {state.remoteControlGrantedTo && (
              <Button onClick={revokeRemoteControl} variant="secondary" className="action-btn">
                Revoke Control
              </Button>
            )}
          </>
        )}
        {state.role === 'viewer' && (
          <Button onClick={requestRemoteControl} variant="secondary" className="action-btn">
            Request Control
          </Button>
        )}
        {hasActiveShare && (
          <>
            <Button
              variant={annotationMode ? 'secondary' : 'ghost'}
              onClick={() => setAnnotationMode(!annotationMode)}
              className={`action-btn ${annotationMode ? '' : ''}`}
            >
              {annotationMode ? 'Drawing...' : 'Annotate'}
            </Button>
            {annotations.length > 0 && (
              <Button onClick={clearAnnotations} variant="ghost" className="action-btn">
                Clear Marks
              </Button>
            )}
          </>
        )}
      </div>

      {/* Status bar */}
      {hasActiveShare && (
        <div className="screenshare-status">
          <span className="status-indicator" />
          <span className="status-text">
            {sharerName} is sharing
          </span>
          <span className="viewer-count">
            {state.viewers.length} viewer{state.viewers.length !== 1 ? 's' : ''}
          </span>
        </div>
      )}

      {/* Remote control requests (for sharer) */}
      {isSharing && state.remoteControlRequestsFrom.length > 0 && (
        <div className="control-requests">
          {state.remoteControlRequestsFrom.map((viewerId) => (
            <div key={viewerId} className="control-request">
              <span className="request-text">
                {viewerId.startsWith('user-') ? viewerId.slice(5, 13) : viewerId.slice(0, 8)} wants control
              </span>
              <Button onClick={() => grantRemoteControl(viewerId)} variant="primary" className="action-btn">
                Grant
              </Button>
              <Button onClick={() => denyRemoteControl(viewerId)} variant="destructive" className="action-btn danger">
                Deny
              </Button>
            </div>
          ))}
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="screenshare-error">
          {error.message}
        </div>
      )}

      {/* Video viewport */}
      <div className="screenshare-viewport">
        {state.role === 'idle' && !hasActiveShare && (
          <div className="empty-state screenshare-empty">
            No one is sharing. Click "Share Screen" to start.
          </div>
        )}

        {isSharing && state.localStream && (
          <div className="video-wrapper">
            <video
              ref={localVideoRef}
              autoPlay
              muted
              playsInline
              className="share-video"
            />
            <canvas
              ref={canvasRef}
              className="annotation-canvas"
              onMouseDown={handleAnnotationStart}
              onMouseMove={handleAnnotationMove}
              onMouseUp={handleAnnotationEnd}
              onMouseLeave={handleAnnotationEnd}
              style={{ cursor: annotationMode ? 'crosshair' : 'default' }}
            />
            <div className="video-label">Your shared screen (preview)</div>
          </div>
        )}

        {state.role === 'viewer' && state.remoteStreams.size > 0 && (
          <div className="video-wrapper">
            <video
              ref={videoRef}
              autoPlay
              playsInline
              className="share-video"
            />
            <canvas
              ref={canvasRef}
              className="annotation-canvas"
              onMouseDown={handleAnnotationStart}
              onMouseMove={handleAnnotationMove}
              onMouseUp={handleAnnotationEnd}
              onMouseLeave={handleAnnotationEnd}
              style={{ cursor: annotationMode ? 'crosshair' : 'default' }}
            />
          </div>
        )}

        {state.role === 'viewer' && state.remoteStreams.size === 0 && hasActiveShare && (
          <div className="empty-state screenshare-empty">
            Connecting to stream...
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// Users Panel
// ============================================================================

interface UserPresenceData {
  color?: string;
  name?: string;
}

interface AggregatedUser {
  id: string;
  name: string;
  color: string;
  rooms: string[];
  isCurrentUser: boolean;
}

function UsersPanel({ roomId, userId }: { roomId: string; userId: string }) {
  // Get users from all rooms
  const { users: todosUsers } = usePresence('demo-todos');
  const { users: editorUsers } = usePresence('demo-editor');
  const { users: chatUsers } = usePresence('demo-chat');
  const { users: lobbyUsers } = usePresence('demo-lobby');
  const { users: screenshareUsers } = usePresence('demo-screenshare');

  const userColor = useMemo(() => getUserColor(userId), [userId]);

  // Aggregate users from all rooms, removing duplicates
  // Always include current user immediately
  const aggregatedUsers = useMemo(() => {
    const userMap = new Map<string, AggregatedUser>();

    // Add current user first so they appear immediately
    userMap.set(userId, {
      id: 'self',
      name: userId,
      color: userColor,
      rooms: ['Todos', 'Editor', 'Chat', 'Users'],
      isCurrentUser: true,
    });

    const processUsers = (users: typeof todosUsers, roomName: string) => {
      users.forEach((user) => {
        const presence = user.presence as UserPresenceData | undefined;

        // Only show users who have properly set their presence with a user- prefixed name
        // This filters out ghost connections and users who haven't initialized yet
        if (!presence?.name || !presence.name.startsWith('user-')) {
          return;
        }

        // Skip current user since we already added them
        if (presence.name === userId) {
          return;
        }

        const name = presence.name;
        const color = presence.color || getUserColor(name);

        if (userMap.has(name)) {
          const existing = userMap.get(name)!;
          if (!existing.rooms.includes(roomName)) {
            existing.rooms.push(roomName);
          }
        } else {
          userMap.set(name, {
            id: user.id,
            name,
            color,
            rooms: [roomName],
            isCurrentUser: false,
          });
        }
      });
    };

    processUsers(todosUsers, 'Todos');
    processUsers(editorUsers, 'Editor');
    processUsers(chatUsers, 'Chat');
    processUsers(screenshareUsers, 'Screen Share');
    processUsers(lobbyUsers, 'Users');

    return Array.from(userMap.values());
  }, [todosUsers, editorUsers, chatUsers, screenshareUsers, lobbyUsers, userId, userColor]);

  return (
    <div className="users-container">
      <div className="demo-header">
        <h2>Online Users</h2>
        <p className="demo-subtitle">Everyone connected across all rooms</p>
      </div>

      <div className="users-stats">
        <div className="users-count">
          <span className="count-value">{aggregatedUsers.length}</span>
          <span className="count-label">User{aggregatedUsers.length !== 1 ? 's' : ''} Online</span>
        </div>
      </div>

      <div className="users-list">
        {aggregatedUsers.map((user) => {
          // Extract the short ID from "user-XXXXXXXX" format
          const shortName = user.name.startsWith('user-') ? user.name.slice(5, 13) : user.name.slice(0, 8);

          return (
            <div
              key={user.name}
              className={`user-card ${user.isCurrentUser ? 'current-user' : ''}`}
            >
              <div
                className="user-avatar"
                style={{ backgroundColor: user.color }}
              >
                {shortName.slice(0, 2).toUpperCase()}
              </div>
              <div className="user-info">
                <span className="user-name">
                  {user.isCurrentUser ? `${shortName} (You)` : shortName}
                </span>
              </div>
              <div
                className="user-status"
                style={{ backgroundColor: user.color }}
              />
            </div>
          );
        })}

        {aggregatedUsers.length === 0 && (
          <p className="empty-state">No users connected yet.</p>
        )}
      </div>
    </div>
  );
}
