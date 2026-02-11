/**
 * React Context for Collabkit
 *
 * Provides the CollabkitClient instance to all child components.
 */

import { createContext } from "react";
import type { CollabkitClient } from "../client.js";

/**
 * Context value type containing the client instance
 */
export interface CollabkitContextValue {
  client: CollabkitClient | null;
}

/**
 * React context for accessing the Collabkit client
 *
 * Use the useCollabkit() hook to access this context in components.
 */
export const CollabkitContext = createContext<CollabkitContextValue>({
  client: null,
});

CollabkitContext.displayName = "CollabkitContext";
