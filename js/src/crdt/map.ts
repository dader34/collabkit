/**
 * LWW-Map (Last-Writer-Wins Map) CRDT implementation.
 *
 * A map where each key is independently an LWW-Register.
 * Supports nested paths for deep object structures.
 */

import {
  BaseCRDT,
  CRDT,
  Operation,
  StateCRDT,
  createOperation,
  operationFromDict,
  operationToDict,
  isDangerousKey,
  validatePath,
  validateValue,
} from "./types.js";

/** Entry value with timestamp metadata */
type Entry = [value: unknown, timestamp: number, nodeId: string];

/** Tombstone with timestamp metadata */
type Tombstone = [timestamp: number, nodeId: string];

/**
 * Last-Writer-Wins Map.
 *
 * Each key in the map is independently resolved using LWW semantics.
 * Supports nested paths like ["users", "123", "name"] for deep updates.
 *
 * @example
 * ```typescript
 * const state = new LWWMap("node-1");
 * state.set(["user", "name"], "Alice");
 * state.set(["user", "age"], 30);
 * console.log(state.value()); // { user: { name: "Alice", age: 30 } }
 * ```
 */
export class LWWMap
  extends BaseCRDT<Record<string, unknown>>
  implements StateCRDT<Record<string, unknown>>
{
  /** Store (value, timestamp, nodeId) for each path */
  private entries: Map<string, Entry> = new Map();

  /** Track deleted paths */
  private tombstones: Map<string, Tombstone> = new Map();

  constructor(
    nodeId: string,
    initialValue?: Record<string, unknown> | null
  ) {
    super(nodeId);
    if (initialValue) {
      this.initFromValue(initialValue);
    }
  }

  /**
   * Convert a path array to a string key for Map storage.
   */
  private pathToKey(path: string[]): string {
    return path.join("\x00"); // Use null character as separator
  }

  /**
   * Convert a string key back to a path array.
   */
  private keyToPath(key: string): string[] {
    return key.split("\x00");
  }

  /**
   * Initialize entries from a nested dictionary.
   */
  private initFromValue(
    value: Record<string, unknown>,
    path: string[] = []
  ): void {
    for (const [key, val] of Object.entries(value)) {
      // Skip dangerous keys to prevent prototype pollution
      if (isDangerousKey(key)) {
        continue;
      }
      const currentPath = [...path, key];
      if (val !== null && typeof val === "object" && !Array.isArray(val)) {
        this.initFromValue(val as Record<string, unknown>, currentPath);
      } else {
        this.entries.set(this.pathToKey(currentPath), [val, 0, this.nodeId]);
      }
    }
  }

  /**
   * Set a value at the given path.
   *
   * If value is an object, it will be flattened into individual path entries.
   * @returns The operation that was applied.
   */
  set(path: string[], value: unknown): Operation {
    const op = createOperation(this.nodeId, path, "set", value);
    this.apply(op);
    return op;
  }

  /**
   * Delete a value at the given path.
   *
   * @returns The operation that was applied.
   */
  delete(path: string[]): Operation {
    const op = createOperation(this.nodeId, path, "delete");
    this.apply(op);
    return op;
  }

  /**
   * Get a value at the given path.
   */
  get(path: string[]): unknown {
    const pathKey = this.pathToKey(path);

    // Check if path is deleted
    const tombstone = this.tombstones.get(pathKey);
    if (tombstone) {
      const entry = this.entries.get(pathKey);
      if (!entry || tombstone[0] > entry[1]) {
        return undefined;
      }
    }

    const entry = this.entries.get(pathKey);
    if (entry) {
      return entry[0];
    }

    // Check for nested values
    return this.getNested(path);
  }

  /**
   * Get all values nested under a path as a dictionary.
   * Filters out dangerous keys to prevent prototype pollution.
   */
  private getNested(path: string[]): Record<string, unknown> | undefined {
    const result: Record<string, unknown> = {};
    const pathKey = this.pathToKey(path);
    const pathLen = path.length;
    let hasValues = false;

    for (const [entryKey, [value, ts]] of this.entries) {
      const entryPath = this.keyToPath(entryKey);

      // Skip any paths containing dangerous keys
      if (entryPath.some(isDangerousKey)) {
        continue;
      }

      if (entryPath.length > pathLen && entryKey.startsWith(pathKey + "\x00")) {
        // Check tombstone
        const tombstone = this.tombstones.get(entryKey);
        if (tombstone && tombstone[0] > ts) {
          continue;
        }

        // Build nested structure safely
        const remaining = entryPath.slice(pathLen);
        let current = result;
        for (let i = 0; i < remaining.length - 1; i++) {
          const key = remaining[i];
          // Safety check for dangerous keys
          if (isDangerousKey(key)) {
            continue;
          }
          if (!(key in current)) {
            current[key] = {};
          }
          current = current[key] as Record<string, unknown>;
        }
        const finalKey = remaining[remaining.length - 1];
        if (!isDangerousKey(finalKey)) {
          current[finalKey] = value;
          hasValues = true;
        }
      }
    }

    return hasValues ? result : undefined;
  }

  /**
   * Apply a set or delete operation.
   */
  apply(op: Operation): boolean {
    if (this.hasSeen(op)) {
      return false;
    }

    const path = op.path;

    if (op.opType === "set") {
      this.applySet(path, op.value, op.timestamp, op.nodeId);
    } else if (op.opType === "delete") {
      this.applyDelete(path, op.timestamp, op.nodeId);
    } else {
      throw new Error(
        `LWWMap supports 'set' and 'delete' operations, got '${op.opType}'`
      );
    }

    this.recordOperation(op);
    return true;
  }

  /**
   * Apply a set operation at a path.
   */
  private applySet(
    path: string[],
    value: unknown,
    timestamp: number,
    nodeId: string
  ): void {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      // Flatten nested object into individual entries
      this.flattenSet(path, value as Record<string, unknown>, timestamp, nodeId);
    } else {
      const pathKey = this.pathToKey(path);
      const existing = this.entries.get(pathKey);
      if (!existing || this.isNewer(timestamp, nodeId, existing[1], existing[2])) {
        this.entries.set(pathKey, [value, timestamp, nodeId]);
      }
    }
  }

  /**
   * Flatten a nested object into individual path entries.
   * Skips dangerous keys to prevent prototype pollution.
   */
  private flattenSet(
    path: string[],
    value: Record<string, unknown>,
    timestamp: number,
    nodeId: string
  ): void {
    for (const [key, val] of Object.entries(value)) {
      // Skip dangerous keys to prevent prototype pollution
      if (isDangerousKey(key)) {
        continue;
      }
      const currentPath = [...path, key];
      if (val !== null && typeof val === "object" && !Array.isArray(val)) {
        this.flattenSet(currentPath, val as Record<string, unknown>, timestamp, nodeId);
      } else {
        const pathKey = this.pathToKey(currentPath);
        const existing = this.entries.get(pathKey);
        if (!existing || this.isNewer(timestamp, nodeId, existing[1], existing[2])) {
          this.entries.set(pathKey, [val, timestamp, nodeId]);
        }
      }
    }
  }

  /**
   * Apply a delete operation at a path.
   */
  private applyDelete(
    path: string[],
    timestamp: number,
    nodeId: string
  ): void {
    const pathKey = this.pathToKey(path);
    const existing = this.tombstones.get(pathKey);
    if (!existing || this.isNewer(timestamp, nodeId, existing[0], existing[1])) {
      this.tombstones.set(pathKey, [timestamp, nodeId]);
    }
  }

  /**
   * Check if (ts1, node1) is newer than (ts2, node2).
   */
  private isNewer(
    ts1: number,
    node1: string,
    ts2: number,
    node2: string
  ): boolean {
    if (ts1 !== ts2) {
      return ts1 > ts2;
    }
    return node1 > node2;
  }

  /**
   * Merge another map into this one.
   */
  merge(other: CRDT<Record<string, unknown>>): void {
    for (const op of other.allOperations()) {
      this.apply(op);
    }
  }

  /**
   * Get the current value as a nested dictionary.
   * Filters out dangerous keys to prevent prototype pollution.
   */
  value(): Record<string, unknown> {
    const result: Record<string, unknown> = {};

    for (const [pathKey, [value, ts]] of this.entries) {
      const path = this.keyToPath(pathKey);

      // Skip any paths containing dangerous keys
      if (path.some(isDangerousKey)) {
        continue;
      }

      // Check tombstone
      const tombstone = this.tombstones.get(pathKey);
      if (tombstone && tombstone[0] > ts) {
        continue;
      }

      // Build nested structure safely
      let current = result;
      for (let i = 0; i < path.length - 1; i++) {
        const key = path[i];
        // Double-check for dangerous keys (defense in depth)
        if (isDangerousKey(key)) {
          continue;
        }
        if (!(key in current)) {
          current[key] = {};
        } else if (typeof current[key] !== "object" || current[key] === null) {
          // Conflict: path has both a value and nested values
          // Nested values take precedence
          current[key] = {};
        }
        current = current[key] as Record<string, unknown>;
      }

      if (path.length > 0) {
        const finalKey = path[path.length - 1];
        // Final safety check
        if (!isDangerousKey(finalKey)) {
          current[finalKey] = value;
        }
      }
    }

    return result;
  }

  /**
   * Get the full state for transmission.
   */
  state(): Record<string, unknown> {
    const entries: Record<string, unknown> = {};
    for (const [pathKey, [val, ts, nid]] of this.entries) {
      const path = this.keyToPath(pathKey);
      entries[path.join(".")] = { value: val, timestamp: ts, node_id: nid };
    }

    const tombstones: Record<string, unknown> = {};
    for (const [pathKey, [ts, nid]] of this.tombstones) {
      const path = this.keyToPath(pathKey);
      tombstones[path.join(".")] = { timestamp: ts, node_id: nid };
    }

    return {
      entries,
      tombstones,
      operations: this.operations.map(operationToDict),
    };
  }

  /**
   * Reconstruct map from transmitted state.
   */
  static fromState(
    nodeId: string,
    state: Record<string, unknown>
  ): LWWMap {
    const lwwMap = new LWWMap(nodeId);

    const entries = state.entries as Record<string, Record<string, unknown>> ?? {};
    for (const [pathStr, entry] of Object.entries(entries)) {
      const path = pathStr ? pathStr.split(".") : [];
      const pathKey = lwwMap.pathToKey(path);
      lwwMap.entries.set(pathKey, [
        entry.value,
        entry.timestamp as number,
        entry.node_id as string,
      ]);
    }

    const tombstones = state.tombstones as Record<string, Record<string, unknown>> ?? {};
    for (const [pathStr, tombstone] of Object.entries(tombstones)) {
      const path = pathStr ? pathStr.split(".") : [];
      const pathKey = lwwMap.pathToKey(path);
      lwwMap.tombstones.set(pathKey, [
        tombstone.timestamp as number,
        tombstone.node_id as string,
      ]);
    }

    lwwMap.operations = (
      (state.operations as Record<string, unknown>[]) ?? []
    ).map(operationFromDict);

    return lwwMap;
  }

  /**
   * Get top-level keys.
   */
  keys(): string[] {
    const seen = new Set<string>();
    for (const pathKey of this.entries.keys()) {
      const path = this.keyToPath(pathKey);
      if (path.length > 0) {
        seen.add(path[0]);
      }
    }
    return Array.from(seen);
  }

  /**
   * Check if a top-level key exists.
   */
  has(key: string): boolean {
    for (const pathKey of this.entries.keys()) {
      const path = this.keyToPath(pathKey);
      if (path.length > 0 && path[0] === key) {
        return true;
      }
    }
    return false;
  }
}
