import React, { useState, useCallback, useEffect, useRef } from 'react';
import {
  useRoom,
  useCollabState,
  usePresence,
} from '@collabkit/client/react';
import { Button, Input } from '@dader34/stylekit-ui';

interface Message {
  id: string;
  text: string;
  author: string;
  timestamp: number;
}

// Input validation constants
const MAX_MESSAGE_LENGTH = 1000;
const MAX_MESSAGES_COUNT = 500;

interface AppProps {
  userId: string;
}

const ROOM_ID = 'shared-chat';

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
        <h1>Live Chat</h1>
        <p className="subtitle">
          One big room for everyone - Open in multiple tabs to test!
        </p>
      </header>
      <OnlineUsers roomId={ROOM_ID} currentUserId={userId} />
      <ChatRoom roomId={ROOM_ID} userId={userId} />
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
  useEffect(() => {
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
          style={{ backgroundColor: (user.presence as { color?: string })?.color || '#888' }}
          title={user.id}
        >
          {user.id === currentUserId ? 'You' : user.id.slice(0, 8)}
        </span>
      ))}
    </div>
  );
}

function ChatRoom({ roomId, userId }: { roomId: string; userId: string }) {
  const [messages, setMessages] = useCollabState<Message[]>(roomId, ['messages']);
  const [newMessageText, setNewMessageText] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to newest messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSendMessage = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const trimmedText = newMessageText.trim();

      // Input validation
      if (!trimmedText) return;
      if (trimmedText.length > MAX_MESSAGE_LENGTH) {
        alert(`Message must be ${MAX_MESSAGE_LENGTH} characters or less`);
        return;
      }

      const currentMessages = messages || [];

      // Limit total messages (remove oldest if over limit)
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
        <Input
          value={newMessageText}
          onChange={(e) => setNewMessageText(e.target.value)}
          placeholder="Type your message..."
          className="message-input"
          maxLength={MAX_MESSAGE_LENGTH}
        />
        <Button type="submit" variant="primary" className="send-btn">
          Send
        </Button>
      </form>
    </div>
  );
}
