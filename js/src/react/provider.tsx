/**
 * CollabkitProvider - React provider component
 *
 * Creates and manages the Collabkit client lifecycle.
 * Auto-connects on mount and disconnects on unmount.
 */

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { CollabkitClient } from "../client.js";
import { CollabkitContext, type CollabkitContextValue } from "./context.js";

/**
 * Props for the CollabkitProvider component
 */
export interface CollabkitProviderProps {
  /**
   * WebSocket URL for the Collabkit server
   */
  url: string;

  /**
   * Function to get authentication token
   * Called when connecting/reconnecting to the server
   */
  getToken: () => Promise<string> | string;

  /**
   * Child components that will have access to the Collabkit client
   */
  children: ReactNode;
}

/**
 * Provider component that creates and manages the Collabkit client
 *
 * @example
 * ```tsx
 * function App() {
 *   return (
 *     <CollabkitProvider
 *       url="wss://api.example.com/collab"
 *       getToken={async () => {
 *         const response = await fetch('/api/collab-token');
 *         const { token } = await response.json();
 *         return token;
 *       }}
 *     >
 *       <MyCollaborativeApp />
 *     </CollabkitProvider>
 *   );
 * }
 * ```
 */
export function CollabkitProvider({
  url,
  getToken,
  children,
}: CollabkitProviderProps): JSX.Element {
  // Create client synchronously using lazy initial state
  const [client] = useState<CollabkitClient>(
    () => new CollabkitClient({ url, getToken })
  );

  // Connect on mount and disconnect on unmount
  useEffect(() => {
    client.connect().catch((error) => {
      console.error("Failed to connect to Collabkit:", error);
    });

    return () => {
      client.disconnect();
    };
  }, [client]);

  // Memoize context value to prevent unnecessary re-renders
  const contextValue = useMemo<CollabkitContextValue>(
    () => ({ client }),
    [client]
  );

  return (
    <CollabkitContext.Provider value={contextValue}>
      {children}
    </CollabkitContext.Provider>
  );
}
