import React, { useCallback, useMemo } from 'react';
import {
  useRoom,
  useCollabState,
  usePresence,
} from '@collabkit/client/react';

interface Document {
  text: string;
  lastEditedBy: string;
  lastEditedAt: number;
}

// Input validation constants
const MAX_DOCUMENT_LENGTH = 50000;

interface AppProps {
  userId: string;
}

const ROOM_ID = 'shared-document';

export default function App({ userId }: AppProps) {
  const { status } = useRoom(ROOM_ID);

  if (status === 'connecting') {
    return <div className="loading">Connecting to collaboration server...</div>;
  }

  if (status === 'error') {
    return <div className="error">Connection error. Please try refreshing the page.</div>;
  }

  return (
    <div className="app">
      <header>
        <h1>Collaborative Text Editor</h1>
        <p className="subtitle">
          Open this page in multiple tabs to see real-time sync!
        </p>
      </header>
      <OnlineUsers roomId={ROOM_ID} currentUserId={userId} />
      <TextEditor roomId={ROOM_ID} userId={userId} />
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

function TextEditor({ roomId, userId }: { roomId: string; userId: string }) {
  const [document, setDocument] = useCollabState<Document>(roomId, ['document']);

  const handleTextChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const newText = e.target.value;

      // Input validation
      if (newText.length > MAX_DOCUMENT_LENGTH) {
        alert(`Document must be ${MAX_DOCUMENT_LENGTH} characters or less`);
        return;
      }

      setDocument({
        text: newText,
        lastEditedBy: userId,
        lastEditedAt: Date.now(),
      });
    },
    [setDocument, userId]
  );

  const text = document?.text || '';

  // Calculate character and word count
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

  return (
    <div className="editor-container">
      <div className="editor-header">
        <span className="document-title">Shared Document</span>
        {lastEditInfo && (
          <span className="last-edit">
            Last edit by {lastEditInfo.editor} at {lastEditInfo.time}
          </span>
        )}
      </div>

      <textarea
        value={text}
        onChange={handleTextChange}
        placeholder="Start typing... All connected users can edit this document in real-time."
        className="editor-textarea"
        spellCheck={false}
      />

      <div className="editor-footer">
        <div className="stats">
          <span className="stat">
            <span className="stat-value">{stats.charCount.toLocaleString()}</span>
            <span className="stat-label">Characters</span>
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

      {text.length === 0 && (
        <p className="empty-state">No content yet. Start typing above!</p>
      )}
    </div>
  );
}
