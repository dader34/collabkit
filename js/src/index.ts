/**
 * @collabkit/client - Real-time collaboration toolkit
 *
 * Main entry point exporting all public APIs
 */

// Core client
export {
  CollabkitClient,
  type CollabkitClientOptions,
  type ConnectionState,
  type User,
  type PresenceData,
  type RoomState as ClientRoomState,
} from "./client.js";

// CRDT exports
export * from "./crdt/index.js";

// React hooks exports
export * from "./react/index.js";

// Protocol types
export * from "./protocol.js";

// Screen share module
export {
  ScreenShareManager,
  type ScreenShareState,
  type ScreenShareRole,
  type ScreenShareEvent,
  type ScreenShareEventListener,
  type Annotation,
  type DisplayMediaOptions,
  type ScreenShareManagerConfig,
} from "./screenshare.js";

// Offline support
export { OfflineQueue, type QueuedOperation } from "./offline.js";
