/**
 * CRDT (Conflict-free Replicated Data Types) exports
 *
 * This module provides CRDT implementations for real-time collaboration.
 */

// Base types and utilities
export {
  type Operation,
  type CRDT,
  type StateCRDT,
  BaseCRDT,
  VersionVector,
  createOperation,
  operationToDict,
  operationFromDict,
} from "./types.js";

// LWW-Register
export { LWWRegister } from "./register.js";

// LWW-Map
export { LWWMap } from "./map.js";
