/**
 * Offline support for CollabKit.
 *
 * This module provides an offline queue that persists operations
 * to localStorage and replays them when reconnected.
 *
 * Security Note: localStorage data is validated on load to prevent
 * tampering attacks via XSS or browser dev tools.
 */

import { Operation, operationFromDict, operationToDict, validateValue } from "./crdt/types.js";

/** Maximum queue size to prevent storage exhaustion */
const MAX_QUEUE_SIZE = 1000;

/** Maximum age for queued operations (24 hours) */
const MAX_QUEUE_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * A queued operation with its room context.
 */
export interface QueuedOperation {
  roomId: string;
  operation: Operation;
  queuedAt: number;
}

/**
 * Offline queue that persists operations to localStorage.
 *
 * When the client is disconnected, operations are queued locally
 * and replayed when the connection is restored.
 *
 * @example
 * ```typescript
 * const queue = new OfflineQueue("myapp");
 *
 * // When disconnected, queue operations
 * queue.enqueue("room-1", operation);
 *
 * // When reconnected, replay and clear
 * const ops = queue.drain("room-1");
 * for (const op of ops) {
 *   client.send(op);
 * }
 * ```
 */
export class OfflineQueue {
  private readonly storageKey: string;
  private queue: QueuedOperation[] = [];

  /**
   * Create a new offline queue.
   *
   * @param namespace - Namespace for localStorage key (to avoid collisions)
   */
  constructor(namespace: string = "collabkit") {
    this.storageKey = `${namespace}:offline_queue`;
    this.load();
  }

  /**
   * Load the queue from localStorage.
   * Validates data to prevent tampering attacks.
   */
  private load(): void {
    if (typeof localStorage === "undefined") {
      return;
    }

    try {
      const stored = localStorage.getItem(this.storageKey);
      if (stored) {
        // Validate data structure before parsing operations
        const data = JSON.parse(stored);

        if (!Array.isArray(data)) {
          console.warn("Invalid offline queue format, clearing");
          this.queue = [];
          this.save();
          return;
        }

        const now = Date.now();
        const validItems: QueuedOperation[] = [];

        for (const item of data) {
          try {
            // Validate item structure
            if (
              typeof item !== "object" ||
              item === null ||
              typeof item.roomId !== "string" ||
              typeof item.queuedAt !== "number" ||
              typeof item.operation !== "object"
            ) {
              continue;
            }

            // Skip items that are too old
            if (now - item.queuedAt > MAX_QUEUE_AGE_MS) {
              continue;
            }

            // Validate operation for prototype pollution (throws on error)
            const operation = operationFromDict(item.operation);

            validItems.push({
              roomId: item.roomId,
              operation,
              queuedAt: item.queuedAt,
            });
          } catch (e) {
            // Skip invalid operations (could be tampered)
            console.warn("Skipping invalid queued operation:", e);
          }
        }

        this.queue = validItems;

        // Re-save to clean up any invalid items
        if (validItems.length !== data.length) {
          this.save();
        }
      }
    } catch (error) {
      console.warn("Failed to load offline queue from localStorage:", error);
      this.queue = [];
      // Clear potentially corrupted data
      try {
        localStorage.removeItem(this.storageKey);
      } catch {
        // Ignore localStorage errors
      }
    }
  }

  /**
   * Save the queue to localStorage.
   */
  private save(): void {
    if (typeof localStorage === "undefined") {
      return;
    }

    try {
      const data = this.queue.map((item) => ({
        roomId: item.roomId,
        operation: operationToDict(item.operation),
        queuedAt: item.queuedAt,
      }));
      localStorage.setItem(this.storageKey, JSON.stringify(data));
    } catch (error) {
      console.warn("Failed to save offline queue to localStorage:", error);
    }
  }

  /**
   * Add an operation to the queue.
   *
   * @param roomId - The room the operation belongs to
   * @param operation - The operation to queue
   */
  enqueue(roomId: string, operation: Operation): void {
    // Enforce queue size limit
    if (this.queue.length >= MAX_QUEUE_SIZE) {
      // Remove oldest items to make room
      this.queue = this.queue.slice(-MAX_QUEUE_SIZE + 1);
    }

    this.queue.push({
      roomId,
      operation,
      queuedAt: Date.now(),
    });
    this.save();
  }

  /**
   * Get all queued operations for a room without removing them.
   *
   * @param roomId - The room to get operations for
   * @returns Array of queued operations
   */
  peek(roomId: string): QueuedOperation[] {
    return this.queue.filter((item) => item.roomId === roomId);
  }

  /**
   * Get all queued operations for a room without removing them.
   *
   * @returns Array of all queued operations
   */
  peekAll(): QueuedOperation[] {
    return [...this.queue];
  }

  /**
   * Remove and return all queued operations for a room.
   *
   * @param roomId - The room to drain operations for
   * @returns Array of queued operations
   */
  drain(roomId: string): QueuedOperation[] {
    const roomOps = this.queue.filter((item) => item.roomId === roomId);
    this.queue = this.queue.filter((item) => item.roomId !== roomId);
    this.save();
    return roomOps;
  }

  /**
   * Remove and return all queued operations.
   *
   * @returns Array of all queued operations
   */
  drainAll(): QueuedOperation[] {
    const allOps = [...this.queue];
    this.queue = [];
    this.save();
    return allOps;
  }

  /**
   * Clear all queued operations for a room.
   *
   * @param roomId - The room to clear operations for
   */
  clear(roomId: string): void {
    this.queue = this.queue.filter((item) => item.roomId !== roomId);
    this.save();
  }

  /**
   * Clear all queued operations.
   */
  clearAll(): void {
    this.queue = [];
    this.save();
  }

  /**
   * Get the number of queued operations.
   */
  get size(): number {
    return this.queue.length;
  }

  /**
   * Get the number of queued operations for a specific room.
   */
  sizeForRoom(roomId: string): number {
    return this.queue.filter((item) => item.roomId === roomId).length;
  }

  /**
   * Check if the queue is empty.
   */
  get isEmpty(): boolean {
    return this.queue.length === 0;
  }

  /**
   * Remove operations older than a certain age.
   *
   * @param maxAgeMs - Maximum age in milliseconds
   * @returns Number of operations removed
   */
  pruneOld(maxAgeMs: number): number {
    const cutoff = Date.now() - maxAgeMs;
    const originalLength = this.queue.length;
    this.queue = this.queue.filter((item) => item.queuedAt >= cutoff);
    const removed = originalLength - this.queue.length;
    if (removed > 0) {
      this.save();
    }
    return removed;
  }
}
