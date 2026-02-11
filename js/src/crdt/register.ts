/**
 * LWW-Register (Last-Writer-Wins Register) CRDT implementation.
 *
 * A register holds a single value. Concurrent writes are resolved
 * by keeping the value with the latest timestamp.
 */

import {
  BaseCRDT,
  CRDT,
  Operation,
  StateCRDT,
  createOperation,
  operationFromDict,
  operationToDict,
} from "./types.js";

/**
 * A value with its associated timestamp and node ID.
 */
interface TimestampedValue<T> {
  value: T;
  timestamp: number;
  nodeId: string;
}

/**
 * Compare two timestamped values.
 * Returns true if a is newer than b.
 */
function isNewer<T>(a: TimestampedValue<T>, b: TimestampedValue<T>): boolean {
  if (a.timestamp !== b.timestamp) {
    return a.timestamp > b.timestamp;
  }
  return a.nodeId > b.nodeId;
}

/**
 * Last-Writer-Wins Register.
 *
 * Stores a single value. When concurrent writes occur, the write
 * with the latest timestamp wins. Ties are broken deterministically
 * using nodeId comparison.
 *
 * @example
 * ```typescript
 * const register = new LWWRegister<string>("node-1");
 * register.set("hello");
 * console.log(register.value()); // "hello"
 * ```
 */
export class LWWRegister<T> extends BaseCRDT<T | null> implements StateCRDT<T | null> {
  private current: TimestampedValue<T | null>;

  constructor(nodeId: string, initialValue: T | null = null) {
    super(nodeId);
    this.current = {
      value: initialValue,
      timestamp: 0,
      nodeId,
    };
  }

  /**
   * Set a new value.
   *
   * @returns The operation that was applied.
   */
  set(value: T): Operation {
    const op = createOperation(this.nodeId, [], "set", value);
    this.apply(op);
    return op;
  }

  /**
   * Apply a set operation.
   */
  apply(op: Operation): boolean {
    if (this.hasSeen(op)) {
      return false;
    }

    if (op.opType !== "set") {
      throw new Error(
        `LWWRegister only supports 'set' operations, got '${op.opType}'`
      );
    }

    const newValue: TimestampedValue<T | null> = {
      value: op.value as T,
      timestamp: op.timestamp,
      nodeId: op.nodeId,
    };

    // Only update if new value is "greater" (later timestamp or higher nodeId)
    if (isNewer(newValue, this.current)) {
      this.current = newValue;
    }

    this.recordOperation(op);
    return true;
  }

  /**
   * Merge another register into this one.
   */
  merge(other: CRDT<T | null>): void {
    for (const op of other.allOperations()) {
      this.apply(op);
    }
  }

  /**
   * Get the current value.
   */
  value(): T | null {
    return this.current.value;
  }

  /**
   * Get the full state for transmission.
   */
  state(): Record<string, unknown> {
    return {
      value: this.current.value,
      timestamp: this.current.timestamp,
      node_id: this.current.nodeId,
      operations: this.operations.map(operationToDict),
    };
  }

  /**
   * Reconstruct register from transmitted state.
   */
  static fromState<T>(
    nodeId: string,
    state: Record<string, unknown>
  ): LWWRegister<T> {
    const register = new LWWRegister<T>(nodeId);
    register.current = {
      value: state.value as T,
      timestamp: state.timestamp as number,
      nodeId: state.node_id as string,
    };
    register.operations = (
      (state.operations as Record<string, unknown>[]) ?? []
    ).map(operationFromDict);
    return register;
  }
}
