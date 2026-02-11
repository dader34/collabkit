/**
 * React hooks and components for Collabkit
 *
 * This module provides React integration for the collaboration toolkit.
 *
 * @example
 * ```tsx
 * import {
 *   CollabkitProvider,
 *   useRoom,
 *   useCollabState,
 *   usePresence,
 *   useCollabFunction,
 * } from '@collabkit/client';
 *
 * function App() {
 *   return (
 *     <CollabkitProvider
 *       url="wss://api.example.com/collab"
 *       getToken={() => fetchAuthToken()}
 *     >
 *       <CollaborativeEditor />
 *     </CollabkitProvider>
 *   );
 * }
 * ```
 */

// Context
export { CollabkitContext, type CollabkitContextValue } from "./context.js";

// Provider
export { CollabkitProvider, type CollabkitProviderProps } from "./provider.js";

// Hooks
export {
  useCollabkit,
  useRoom,
  useCollabState,
  usePresence,
  useCollabFunction,
  useScreenShare,
  type RoomState,
  type PresenceResult,
  type CollabFunctionResult,
  type ScreenShareResult,
  type ScreenShareActions,
} from "./hooks.js";
