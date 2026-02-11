/**
 * CRDT base types and Operation interface.
 *
 * CRDTs (Conflict-free Replicated Data Types) allow concurrent modifications
 * to shared state without coordination, automatically merging changes.
 */

/** Keys that could be used for prototype pollution attacks */
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype", "__class__"]);

/**
 * Check if a key is dangerous (could cause prototype pollution).
 */
export function isDangerousKey(key: string): boolean {
  return DANGEROUS_KEYS.has(key);
}

/**
 * Validate a path array for prototype pollution attacks.
 * Throws an error if dangerous keys are found.
 */
export function validatePath(path: string[]): void {
  for (const segment of path) {
    if (isDangerousKey(segment)) {
      throw new Error(`Dangerous path segment '${segment}' not allowed`);
    }
  }
}

/**
 * Recursively validate an object for prototype pollution keys.
 */
export function validateValue(value: unknown, path = "value"): void {
  if (value === null || value === undefined) {
    return;
  }

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      validateValue(value[i], `${path}[${i}]`);
    }
  } else if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
      if (isDangerousKey(key)) {
        throw new Error(`Dangerous key '${key}' not allowed in ${path}`);
      }
      validateValue(obj[key], `${path}.${key}`);
    }
  }
}

/**
 * Represents a single operation on a CRDT.
 *
 * Operations are immutable and can be applied in any order to achieve
 * eventual consistency across all replicas.
 */
export interface Operation {
  /** Unique identifier for this operation */
  id: string;
  /** Timestamp when the operation was created */
  timestamp: number;
  /** ID of the node that created this operation */
  nodeId: string;
  /** Path to the value being modified (e.g., ["user", "name"]) */
  path: string[];
  /** Type of operation: 'set', 'delete', 'increment', 'decrement', 'add', 'remove' */
  opType: string;
  /** The value for the operation (optional, depends on opType) */
  value?: unknown;
}

/**
 * Create a new operation with auto-generated ID and timestamp.
 * Validates path and value for prototype pollution.
 */
export function createOperation(
  nodeId: string,
  path: string[],
  opType: string,
  value?: unknown
): Operation {
  // Validate path for prototype pollution
  validatePath(path);

  // Validate value for prototype pollution
  if (value !== undefined) {
    validateValue(value);
  }

  return {
    id: crypto.randomUUID(),
    timestamp: Date.now() / 1000, // Use seconds to match Python
    nodeId,
    path: [...path],
    opType,
    value,
  };
}

/**
 * Serialize an operation to a plain object for transmission.
 */
export function operationToDict(op: Operation): Record<string, unknown> {
  return {
    id: op.id,
    timestamp: op.timestamp,
    node_id: op.nodeId,
    path: op.path,
    op_type: op.opType,
    value: op.value,
  };
}

/**
 * Deserialize an operation from a plain object.
 * Validates path and value for prototype pollution.
 */
export function operationFromDict(data: Record<string, unknown>): Operation {
  const path = data.path as string[];

  // Validate path for prototype pollution
  if (Array.isArray(path)) {
    validatePath(path);
  }

  // Validate value for prototype pollution
  if (data.value !== undefined) {
    validateValue(data.value);
  }

  return {
    id: data.id as string,
    timestamp: data.timestamp as number,
    nodeId: data.node_id as string,
    path: path,
    opType: data.op_type as string,
    value: data.value,
  };
}

/**
 * Tracks the latest timestamp seen from each node.
 *
 * Used for efficient sync - only send operations newer than
 * what the peer has already seen.
 */
export class VersionVector {
  private timestamps: Map<string, number> = new Map();

  /**
   * Update the vector with a new timestamp from a node.
   */
  update(nodeId: string, timestamp: number): void {
    const current = this.timestamps.get(nodeId) ?? 0;
    this.timestamps.set(nodeId, Math.max(current, timestamp));
  }

  /**
   * Get the latest timestamp seen from a node.
   */
  get(nodeId: string): number {
    return this.timestamps.get(nodeId) ?? 0;
  }

  /**
   * Merge another version vector into this one.
   */
  merge(other: VersionVector): void {
    for (const [nodeId, timestamp] of other.timestamps) {
      this.update(nodeId, timestamp);
    }
  }

  /**
   * Serialize to a plain object.
   */
  toDict(): Record<string, number> {
    return Object.fromEntries(this.timestamps);
  }

  /**
   * Deserialize from a plain object.
   */
  static fromDict(data: Record<string, number>): VersionVector {
    const vv = new VersionVector();
    for (const [nodeId, timestamp] of Object.entries(data)) {
      vv.timestamps.set(nodeId, timestamp);
    }
    return vv;
  }
}

/**
 * Abstract interface for all CRDT types.
 *
 * Implementations must provide:
 * - apply: Apply a single operation
 * - merge: Merge another CRDT of the same type
 * - value: Get the current resolved value
 * - operationsSince: Get operations after a timestamp
 */
export interface CRDT<T> {
  /** The node ID of this CRDT instance */
  readonly nodeId: string;

  /**
   * Apply an operation to this CRDT.
   * Returns true if the operation was applied (not a duplicate).
   */
  apply(op: Operation): boolean;

  /**
   * Merge another CRDT into this one.
   */
  merge(other: CRDT<T>): void;

  /**
   * Get the current resolved value.
   */
  value(): T;

  /**
   * Get all operations after the given timestamp.
   */
  operationsSince(timestamp: number): Operation[];

  /**
   * Get all operations.
   */
  allOperations(): Operation[];
}

/**
 * Base class providing common CRDT functionality.
 */
export abstract class BaseCRDT<T> implements CRDT<T> {
  readonly nodeId: string;
  protected operations: Operation[] = [];
  protected versionVector: VersionVector = new VersionVector();

  constructor(nodeId: string) {
    this.nodeId = nodeId;
  }

  abstract apply(op: Operation): boolean;
  abstract merge(other: CRDT<T>): void;
  abstract value(): T;

  /**
   * Get all operations after the given timestamp.
   */
  operationsSince(timestamp: number): Operation[] {
    return this.operations.filter((op) => op.timestamp > timestamp);
  }

  /**
   * Get all operations.
   */
  allOperations(): Operation[] {
    return [...this.operations];
  }

  /**
   * Record an operation and update version vector.
   */
  protected recordOperation(op: Operation): void {
    this.operations.push(op);
    this.versionVector.update(op.nodeId, op.timestamp);
  }

  /**
   * Check if we've already seen this operation.
   */
  protected hasSeen(op: Operation): boolean {
    return this.operations.some((existing) => existing.id === op.id);
  }
}

/**
 * Interface for state-based CRDTs that can serialize their full state.
 */
export interface StateCRDT<T> extends CRDT<T> {
  /**
   * Get the full CRDT state for transmission.
   */
  state(): Record<string, unknown>;
}
