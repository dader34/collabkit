/**
 * Protocol message types for client-server communication.
 *
 * This module defines the message types used for WebSocket communication
 * between the client and the CollabKit server.
 */

import { Operation } from "./crdt/types.js";

// ============================================================================
// User types
// ============================================================================

/**
 * Represents a user in a collaboration room.
 */
export interface User {
  /** Unique identifier for the user */
  id: string;
  /** Display name of the user */
  name?: string;
  /** User's email address */
  email?: string;
  /** User's avatar URL */
  avatarUrl?: string;
  /** Custom metadata associated with the user */
  metadata?: Record<string, unknown>;
}

/**
 * User presence information.
 */
export interface Presence {
  /** The user */
  user: User;
  /** When the user was last active (Unix timestamp) */
  lastSeen: number;
  /** User's current cursor position or selection */
  cursor?: {
    x?: number;
    y?: number;
    path?: string[];
    selection?: { start: number; end: number };
  };
  /** Custom presence data */
  data?: Record<string, unknown>;
}

// ============================================================================
// Client -> Server messages
// ============================================================================

/**
 * Join a collaboration room.
 */
export interface JoinMessage {
  type: "join";
  roomId: string;
  user: User;
  /** Optional token for authentication */
  token?: string;
}

/**
 * Leave a collaboration room.
 */
export interface LeaveMessage {
  type: "leave";
  roomId: string;
}

/**
 * Send an operation to the server.
 */
export interface OperationMessage {
  type: "operation";
  roomId: string;
  operation: Operation;
}

/**
 * Request sync of state from the server.
 */
export interface SyncRequestMessage {
  type: "sync_request";
  roomId: string;
  /** Timestamp of last known operation (for partial sync) */
  since?: number;
}

/**
 * Call a server-side function.
 */
export interface CallMessage {
  type: "call";
  /** Unique ID for this call (for matching response) */
  callId: string;
  roomId: string;
  /** Name of the function to call */
  functionName: string;
  /** Arguments to pass to the function */
  args: unknown[];
}

/**
 * Update user presence.
 */
export interface PresenceMessage {
  type: "presence";
  roomId: string;
  presence: Omit<Presence, "user" | "lastSeen">;
}

/**
 * Ping message for keepalive.
 */
export interface PingMessage {
  type: "ping";
}

// ============================================================================
// Screen Share / WebRTC Signaling - Client -> Server
// ============================================================================

/**
 * Start sharing screen in a room.
 */
export interface ScreenShareStartMessage {
  type: "screenshare_start";
  roomId: string;
  shareName?: string;
}

/**
 * Stop sharing screen.
 */
export interface ScreenShareStopMessage {
  type: "screenshare_stop";
  roomId: string;
}

/**
 * WebRTC SDP offer sent from sharer to a specific viewer.
 */
export interface RtcOfferMessage {
  type: "rtc_offer";
  roomId: string;
  targetUserId: string;
  sdp: string;
}

/**
 * WebRTC SDP answer sent from viewer back to sharer.
 */
export interface RtcAnswerMessage {
  type: "rtc_answer";
  roomId: string;
  targetUserId: string;
  sdp: string;
}

/**
 * WebRTC ICE candidate exchange.
 */
export interface RtcIceCandidateMessage {
  type: "rtc_ice_candidate";
  roomId: string;
  targetUserId: string;
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
}

/**
 * Request remote control from viewer to sharer.
 */
export interface RemoteControlRequestMessage {
  type: "remote_control_request";
  roomId: string;
  targetUserId: string;
}

/**
 * Sharer responds to a remote control request.
 */
export interface RemoteControlResponseMessage {
  type: "remote_control_response";
  roomId: string;
  targetUserId: string;
  granted: boolean;
}

/**
 * Union type for all client messages.
 */
export type ClientMessage =
  | JoinMessage
  | LeaveMessage
  | OperationMessage
  | SyncRequestMessage
  | CallMessage
  | PresenceMessage
  | PingMessage
  | ScreenShareStartMessage
  | ScreenShareStopMessage
  | RtcOfferMessage
  | RtcAnswerMessage
  | RtcIceCandidateMessage
  | RemoteControlRequestMessage
  | RemoteControlResponseMessage;

// ============================================================================
// Server -> Client messages
// ============================================================================

/**
 * Confirmation of joining a room.
 */
export interface JoinedMessage {
  type: "joined";
  roomId: string;
  /** The assigned user ID (may differ from requested) */
  userId: string;
  /** Other users currently in the room */
  users: User[];
  /** Initial state of the room */
  state?: Record<string, unknown>;
}

/**
 * Operation broadcast from the server.
 */
export interface ServerOperationMessage {
  type: "operation";
  roomId: string;
  operation: Operation;
  /** User who made the operation */
  userId: string;
}

/**
 * Full or partial state sync from the server.
 */
export interface SyncMessage {
  type: "sync";
  roomId: string;
  /** Full state of the room */
  state: Record<string, unknown>;
  /** Operations since the requested timestamp (for partial sync) */
  operations?: Operation[];
}

/**
 * Result of a server-side function call.
 */
export interface CallResultMessage {
  type: "call_result";
  /** ID of the call this is responding to */
  callId: string;
  /** Whether the call succeeded */
  success: boolean;
  /** Result value (if success) */
  result?: unknown;
  /** Error message (if failure) */
  error?: string;
}

/**
 * Presence update from another user.
 */
export interface ServerPresenceMessage {
  type: "presence";
  roomId: string;
  presence: Presence;
}

/**
 * A new user joined the room.
 */
export interface UserJoinedMessage {
  type: "user_joined";
  roomId: string;
  user: User;
}

/**
 * A user left the room.
 */
export interface UserLeftMessage {
  type: "user_left";
  roomId: string;
  userId: string;
}

/**
 * Error message from the server.
 */
export interface ErrorMessage {
  type: "error";
  /** Error code */
  code: string;
  /** Human-readable error message */
  message: string;
  /** Room ID (if applicable) */
  roomId?: string;
}

/**
 * Pong message in response to ping.
 */
export interface PongMessage {
  type: "pong";
}

// ============================================================================
// Screen Share / WebRTC Signaling - Server -> Client
// ============================================================================

/**
 * Server notifies room that a user started sharing.
 */
export interface ScreenShareStartedMessage {
  type: "screenshare_started";
  roomId: string;
  userId: string;
  shareName?: string;
}

/**
 * Server notifies room that sharing stopped.
 */
export interface ScreenShareStoppedMessage {
  type: "screenshare_stopped";
  roomId: string;
  userId: string;
}

/**
 * Relayed RTC offer from sharer.
 */
export interface ServerRtcOfferMessage {
  type: "rtc_offer";
  roomId: string;
  fromUserId: string;
  sdp: string;
}

/**
 * Relayed RTC answer from viewer.
 */
export interface ServerRtcAnswerMessage {
  type: "rtc_answer";
  roomId: string;
  fromUserId: string;
  sdp: string;
}

/**
 * Relayed ICE candidate.
 */
export interface ServerRtcIceCandidateMessage {
  type: "rtc_ice_candidate";
  roomId: string;
  fromUserId: string;
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
}

/**
 * Relayed remote control request.
 */
export interface ServerRemoteControlRequestMessage {
  type: "remote_control_request";
  roomId: string;
  fromUserId: string;
}

/**
 * Relayed remote control response.
 */
export interface ServerRemoteControlResponseMessage {
  type: "remote_control_response";
  roomId: string;
  fromUserId: string;
  granted: boolean;
}

/**
 * Union type for all server messages.
 */
export type ServerMessage =
  | JoinedMessage
  | ServerOperationMessage
  | SyncMessage
  | CallResultMessage
  | ServerPresenceMessage
  | UserJoinedMessage
  | UserLeftMessage
  | ErrorMessage
  | PongMessage
  | ScreenShareStartedMessage
  | ScreenShareStoppedMessage
  | ServerRtcOfferMessage
  | ServerRtcAnswerMessage
  | ServerRtcIceCandidateMessage
  | ServerRemoteControlRequestMessage
  | ServerRemoteControlResponseMessage;

// ============================================================================
// Message serialization helpers
// ============================================================================

/**
 * Serialize a client message for transmission.
 */
export function serializeClientMessage(message: ClientMessage): string {
  return JSON.stringify(message);
}

/**
 * Deserialize a server message from received data.
 */
export function deserializeServerMessage(data: string): ServerMessage {
  return JSON.parse(data) as ServerMessage;
}
