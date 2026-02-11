/**
 * React hooks for Collabkit
 *
 * Provides hooks for accessing client, rooms, state, presence, and functions.
 */

import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { CollabkitClient, PresenceData, User } from "../client.js";
import type {
  ScreenShareManager,
  ScreenShareState,
  Annotation,
  DisplayMediaOptions,
} from "../screenshare.js";
import { CollabkitContext } from "./context.js";

/**
 * Get the Collabkit client from context
 *
 * @throws Error if used outside of CollabkitProvider
 *
 * @example
 * ```tsx
 * function MyComponent() {
 *   const client = useCollabkit();
 *   // Access client methods directly
 * }
 * ```
 */
export function useCollabkit(): CollabkitClient {
  const { client } = useContext(CollabkitContext);

  if (!client) {
    throw new Error(
      "useCollabkit must be used within a CollabkitProvider. " +
        "Make sure your component is wrapped in <CollabkitProvider>."
    );
  }

  return client;
}

/**
 * Room connection status
 */
export type RoomStatus = "connecting" | "connected" | "error";

/**
 * Room state returned by useRoom hook
 */
export interface RoomState {
  /**
   * Connection status: "connecting", "connected", or "error"
   */
  status: RoomStatus;

  /**
   * Error if status is "error"
   */
  error: Error | null;

  /**
   * Current room state object
   */
  state: Record<string, unknown>;

  /**
   * List of users currently in the room
   */
  users: User[];
}

/**
 * Join a room and get its state
 *
 * Automatically joins the room on mount and leaves on unmount.
 *
 * @param roomId - The room identifier to join
 * @returns Room state including connection status, state, and users
 *
 * @example
 * ```tsx
 * function DocumentEditor({ docId }: { docId: string }) {
 *   const { connected, state, users } = useRoom(`doc:${docId}`);
 *
 *   if (!connected) return <div>Connecting...</div>;
 *
 *   return (
 *     <div>
 *       <p>{users.length} users editing</p>
 *       <Editor content={state.content} />
 *     </div>
 *   );
 * }
 * ```
 */
export function useRoom(roomId: string): RoomState {
  const client = useCollabkit();

  // Track connection status and error
  const [status, setStatus] = useState<RoomStatus>(() => {
    const connState = client.getConnectionState();
    if (connState === "connected") return "connected";
    if (connState === "error") return "error";
    return "connecting";
  });
  const [error, setError] = useState<Error | null>(null);
  const [state, setState] = useState<Record<string, unknown>>(
    () => client.getRoomState(roomId)
  );
  const [users, setUsers] = useState<User[]>(
    () => client.getRoomPresence(roomId).users
  );

  // Join/leave room on mount/unmount
  useEffect(() => {
    client.joinRoom(roomId);
    return () => {
      client.leaveRoom(roomId);
    };
  }, [client, roomId]);

  // Subscribe to connection state
  useEffect(() => {
    const updateStatus = (connState: string) => {
      if (connState === "connected") {
        setStatus("connected");
        setError(null);
      } else if (connState === "error") {
        setStatus("error");
        setError(new Error("Connection failed"));
      } else {
        setStatus("connecting");
      }
    };
    updateStatus(client.getConnectionState());
    return client.subscribeToConnection(updateStatus);
  }, [client]);

  // Subscribe to room state
  useEffect(() => {
    setState(client.getRoomState(roomId));
    return client.subscribeToState(roomId, (newState) => {
      setState(newState);
    });
  }, [client, roomId]);

  // Subscribe to presence for users list
  useEffect(() => {
    setUsers(client.getRoomPresence(roomId).users);
    return client.subscribeToPresence(roomId, (presence) => {
      setUsers(presence.users);
    });
  }, [client, roomId]);

  return useMemo(
    () => ({ status, error, state, users }),
    [status, error, state, users]
  );
}

/**
 * Read and write state at a specific path in a room
 *
 * Similar to useState but synced across all clients in the room.
 *
 * @param roomId - The room identifier
 * @param path - Optional path to state as dot-separated string (e.g., "document.title") or array (e.g., ["document", "title"])
 * @returns Tuple of [value, setValue] similar to useState
 *
 * @example
 * ```tsx
 * function Counter({ roomId }: { roomId: string }) {
 *   const [count, setCount] = useCollabState<number>(roomId, "counter");
 *
 *   return (
 *     <button onClick={() => setCount((count ?? 0) + 1)}>
 *       Count: {count ?? 0}
 *     </button>
 *   );
 * }
 *
 * // Access entire room state
 * const [state, setState] = useCollabState<MyState>(roomId);
 * ```
 */
export function useCollabState<T>(
  roomId: string,
  path?: string | string[]
): [T | undefined, (value: T | ((prev: T | undefined) => T)) => void] {
  const client = useCollabkit();

  // Normalize path to string for client API
  const normalizedPath = useMemo(
    () => (Array.isArray(path) ? path.join(".") : path),
    [path]
  );

  // Track previous value for functional updates
  const valueRef = useRef<T | undefined>();

  // Use useState for simpler state management
  const [value, setValueState] = useState<T | undefined>(undefined);

  // Keep valueRef in sync
  useEffect(() => {
    valueRef.current = value;
  }, [value]);

  // Join room and subscribe to state changes in a single effect
  useEffect(() => {
    // Join room first
    client.joinRoom(roomId);

    // Now subscribe to state changes
    setValueState(client.getStateAtPath<T>(roomId, normalizedPath));
    const unsubscribe = client.subscribeToState(roomId, () => {
      const newValue = client.getStateAtPath<T>(roomId, normalizedPath);
      setValueState(newValue);
      valueRef.current = newValue;
    });

    return () => {
      unsubscribe();
      client.leaveRoom(roomId);
    };
  }, [client, roomId, normalizedPath]);

  // Setter function that supports both direct values and functional updates
  const setValue = useCallback(
    (valueOrUpdater: T | ((prev: T | undefined) => T)) => {
      const newValue =
        typeof valueOrUpdater === "function"
          ? (valueOrUpdater as (prev: T | undefined) => T)(valueRef.current)
          : valueOrUpdater;

      client.setStateAtPath(roomId, normalizedPath, newValue);
    },
    [client, roomId, normalizedPath]
  );

  return [value, setValue];
}

/**
 * Presence data returned by usePresence hook
 */
export interface PresenceResult<T extends PresenceData = PresenceData> {
  /**
   * List of users in the room with their presence data
   */
  users: Array<User & { presence?: T }>;

  /**
   * Current user's presence data
   */
  myPresence: T | undefined;

  /**
   * Update current user's presence
   */
  updatePresence: (data: Partial<T>) => void;
}

/**
 * Track and update presence in a room
 *
 * Presence is typically used for cursors, selection, typing indicators, etc.
 *
 * @param roomId - The room identifier
 * @returns Object with users, myPresence, and updatePresence
 *
 * @example
 * ```tsx
 * interface CursorPresence {
 *   cursor: { x: number; y: number } | null;
 *   name: string;
 * }
 *
 * function Cursors({ roomId }: { roomId: string }) {
 *   const { users, updatePresence } = usePresence<CursorPresence>(roomId);
 *
 *   useEffect(() => {
 *     const handleMouseMove = (e: MouseEvent) => {
 *       updatePresence({ cursor: { x: e.clientX, y: e.clientY } });
 *     };
 *     window.addEventListener('mousemove', handleMouseMove);
 *     return () => window.removeEventListener('mousemove', handleMouseMove);
 *   }, [updatePresence]);
 *
 *   return (
 *     <>
 *       {users.map(user => (
 *         user.presence?.cursor && (
 *           <Cursor key={user.id} position={user.presence.cursor} />
 *         )
 *       ))}
 *     </>
 *   );
 * }
 * ```
 */
export function usePresence<T extends PresenceData = PresenceData>(
  roomId: string
): PresenceResult<T> {
  const client = useCollabkit();

  // Track current presence for merging partial updates
  const myPresenceRef = useRef<T | undefined>();

  // Use useState for simpler state management
  const [presenceData, setPresenceData] = useState<{
    users: User[];
    presenceMap: Map<string, PresenceData>;
  }>(() => ({ users: [], presenceMap: new Map() }));

  // Join room and subscribe to presence changes in a single effect
  useEffect(() => {
    // Join room first
    client.joinRoom(roomId);

    // Now subscribe to presence changes
    setPresenceData(client.getRoomPresence(roomId));
    const unsubscribe = client.subscribeToPresence(roomId, (presence) => {
      setPresenceData(presence);
    });

    return () => {
      unsubscribe();
      client.leaveRoom(roomId);
    };
  }, [client, roomId]);

  // Combine users with their presence data
  const users = useMemo(() => {
    return presenceData.users.map((user) => ({
      ...user,
      presence: presenceData.presenceMap.get(user.id) as T | undefined,
    }));
  }, [presenceData]);

  // Get current user's presence (simplified - in real impl would need user ID)
  const myPresence = myPresenceRef.current;

  // Update presence with partial data (merges with existing)
  const updatePresence = useCallback(
    (data: Partial<T>) => {
      const merged = { ...myPresenceRef.current, ...data } as T;
      myPresenceRef.current = merged;
      client.updatePresence(roomId, merged);
    },
    [client, roomId]
  );

  return useMemo(
    () => ({ users, myPresence, updatePresence }),
    [users, myPresence, updatePresence]
  );
}

/**
 * Result of useCollabFunction hook
 */
export interface CollabFunctionResult<TResult> {
  /**
   * Call the remote function with arguments
   */
  call: (args?: unknown) => Promise<TResult>;

  /**
   * Whether a call is currently in progress
   */
  loading: boolean;

  /**
   * Error from the last call, if any
   */
  error: Error | null;

  /**
   * Result from the last successful call
   */
  result: TResult | undefined;
}

/**
 * Call a remote function in a room
 *
 * Functions are defined on the server and can be called from any client.
 *
 * @param roomId - The room identifier
 * @param functionName - Name of the function to call
 * @returns Object with call function, loading state, error, and result
 *
 * @example
 * ```tsx
 * interface SaveResult {
 *   success: boolean;
 *   savedAt: string;
 * }
 *
 * function SaveButton({ roomId }: { roomId: string }) {
 *   const { call, loading, error } = useCollabFunction<
 *     { content: string },
 *     SaveResult
 *   >(roomId, 'saveDocument');
 *
 *   const handleSave = async () => {
 *     try {
 *       const result = await call({ content: 'Hello world' });
 *       console.log('Saved at:', result.savedAt);
 *     } catch (e) {
 *       console.error('Save failed:', e);
 *     }
 *   };
 *
 *   return (
 *     <button onClick={handleSave} disabled={loading}>
 *       {loading ? 'Saving...' : 'Save'}
 *     </button>
 *   );
 * }
 * ```
 */
export function useCollabFunction<TArgs = unknown, TResult = unknown>(
  roomId: string,
  functionName: string
): CollabFunctionResult<TResult> {
  const client = useCollabkit();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [result, setResult] = useState<TResult | undefined>();

  // Track if component is still mounted
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const call = useCallback(
    async (args?: TArgs): Promise<TResult> => {
      setLoading(true);
      setError(null);

      try {
        const callResult = await client.callFunction<TArgs, TResult>(
          roomId,
          functionName,
          args as TArgs
        );

        if (mountedRef.current) {
          setResult(callResult);
          setLoading(false);
        }

        return callResult;
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));

        if (mountedRef.current) {
          setError(err);
          setLoading(false);
        }

        throw err;
      }
    },
    [client, roomId, functionName]
  );

  return useMemo(
    () => ({ call, loading, error, result }),
    [call, loading, error, result]
  );
}

// ============================================================================
// Screen Share Hook
// ============================================================================

/**
 * Screen share actions
 */
export interface ScreenShareActions {
  startSharing: (options?: DisplayMediaOptions) => Promise<void>;
  stopSharing: () => Promise<void>;
  requestRemoteControl: () => void;
  grantRemoteControl: (viewerUserId: string) => void;
  denyRemoteControl: (viewerUserId: string) => void;
  revokeRemoteControl: () => void;
  sendAnnotation: (
    annotation: Omit<Annotation, "id" | "authorId" | "timestamp">
  ) => void;
  clearAnnotations: () => void;
}

/**
 * Screen share result
 */
export interface ScreenShareResult extends ScreenShareActions {
  state: ScreenShareState;
  annotations: Annotation[];
  isSharing: boolean;
  hasActiveShare: boolean;
  error: Error | null;
}

const INITIAL_SCREEN_SHARE_STATE: ScreenShareState = {
  role: "idle",
  sharerId: null,
  shareName: null,
  viewers: [],
  localStream: null,
  remoteStreams: new Map(),
  remoteControlGrantedTo: null,
  remoteControlRequestsFrom: [],
};

/**
 * Hook for screen sharing in a room.
 *
 * Manages WebRTC peer connections, media streams, annotations,
 * and remote control requests.
 *
 * @param roomId - The room to share in. Must already be joined via useRoom.
 * @returns Screen share state, actions, and metadata.
 *
 * @example
 * ```tsx
 * function ScreenSharePanel({ roomId }: { roomId: string }) {
 *   const {
 *     state,
 *     isSharing,
 *     hasActiveShare,
 *     startSharing,
 *     stopSharing,
 *   } = useScreenShare(roomId);
 *
 *   return (
 *     <div>
 *       {!hasActiveShare && (
 *         <button onClick={() => startSharing()}>Share Screen</button>
 *       )}
 *       {isSharing && (
 *         <button onClick={stopSharing}>Stop Sharing</button>
 *       )}
 *     </div>
 *   );
 * }
 * ```
 */
export function useScreenShare(roomId: string): ScreenShareResult {
  const client = useCollabkit();
  const [state, setState] = useState<ScreenShareState>(
    INITIAL_SCREEN_SHARE_STATE
  );
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [error, setError] = useState<Error | null>(null);

  const managerRef = useRef<ScreenShareManager | null>(null);

  useEffect(() => {
    const manager = client.getScreenShareManager(roomId);
    managerRef.current = manager;

    if (!manager) return;

    const unsubscribe = manager.subscribe((event) => {
      switch (event.type) {
        case "state_changed":
          setState(event.state);
          break;
        case "annotation_received":
          setAnnotations((prev: Annotation[]) => [...prev, event.annotation]);
          break;
        case "error":
          setError(event.error);
          break;
      }
    });

    setState(manager.getState());

    return () => {
      unsubscribe();
    };
  }, [client, roomId]);

  const startSharing = useCallback(
    async (options?: DisplayMediaOptions) => {
      setError(null);
      try {
        await managerRef.current?.startSharing(options);
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        setError(err);
        throw err;
      }
    },
    []
  );

  const stopSharing = useCallback(async () => {
    setError(null);
    try {
      await managerRef.current?.stopSharing();
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      setError(err);
    }
  }, []);

  const requestRemoteControl = useCallback(() => {
    if (state.sharerId) {
      managerRef.current?.requestRemoteControl(state.sharerId);
    }
  }, [state.sharerId]);

  const grantRemoteControl = useCallback((viewerUserId: string) => {
    managerRef.current?.grantRemoteControl(viewerUserId);
  }, []);

  const denyRemoteControl = useCallback((viewerUserId: string) => {
    managerRef.current?.denyRemoteControl(viewerUserId);
  }, []);

  const revokeRemoteControl = useCallback(() => {
    managerRef.current?.revokeRemoteControl();
  }, []);

  const sendAnnotation = useCallback(
    (annotation: Omit<Annotation, "id" | "authorId" | "timestamp">) => {
      managerRef.current?.sendAnnotation(annotation);
    },
    []
  );

  const clearAnnotations = useCallback(() => {
    managerRef.current?.clearAnnotations();
    setAnnotations([]);
  }, []);

  const isSharing = state.role === "sharer";
  const hasActiveShare = state.sharerId !== null;

  return useMemo(
    () => ({
      state,
      annotations,
      isSharing,
      hasActiveShare,
      error,
      startSharing,
      stopSharing,
      requestRemoteControl,
      grantRemoteControl,
      denyRemoteControl,
      revokeRemoteControl,
      sendAnnotation,
      clearAnnotations,
    }),
    [
      state,
      annotations,
      isSharing,
      hasActiveShare,
      error,
      startSharing,
      stopSharing,
      requestRemoteControl,
      grantRemoteControl,
      denyRemoteControl,
      revokeRemoteControl,
      sendAnnotation,
      clearAnnotations,
    ]
  );
}
