/**
 * CollabkitClient - Core client for real-time collaboration
 *
 * Manages WebSocket connection, room subscriptions, state synchronization,
 * presence tracking, and remote function calls.
 */

import { LWWMap } from "./crdt/map.js";
import { Operation, operationFromDict, operationToDict, validateValue } from "./crdt/types.js";
import { OfflineQueue } from "./offline.js";
import { ScreenShareManager } from "./screenshare.js";

/** Maximum message size in bytes (1MB) */
const MAX_MESSAGE_SIZE = 1024 * 1024;

/** Rate limiting: max messages per second */
const MAX_MESSAGES_PER_SECOND = 50;

/** Simple client-side rate limiter */
class ClientRateLimiter {
  private tokens: number;
  private lastRefill: number;
  private readonly rate: number;

  constructor(rate: number = MAX_MESSAGES_PER_SECOND) {
    this.rate = rate;
    this.tokens = rate;
    this.lastRefill = Date.now();
  }

  canSend(): boolean {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.lastRefill = now;

    // Refill tokens based on elapsed time
    this.tokens = Math.min(this.rate, this.tokens + elapsed * this.rate);

    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }
}

/**
 * Validate incoming server message structure.
 * Returns true if the message has a valid basic structure.
 */
function isValidServerMessage(message: unknown): message is Record<string, unknown> {
  if (typeof message !== "object" || message === null) {
    return false;
  }
  const msg = message as Record<string, unknown>;
  // All server messages must have a type
  if (typeof msg.type !== "string") {
    return false;
  }
  return true;
}

export type ConnectionState = "disconnected" | "connecting" | "connected" | "error";

export interface User {
  id: string;
  name?: string;
  email?: string;
  avatarUrl?: string;
  [key: string]: unknown;
}

export interface PresenceData {
  cursor?: { x?: number; y?: number; path?: string[] };
  selection?: { start: number; end: number };
  [key: string]: unknown;
}

export interface RoomState {
  state: Record<string, unknown>;
  presence: Map<string, PresenceData>;
  users: User[];
}

export interface CollabkitClientOptions {
  url: string;
  getToken: () => Promise<string> | string;
  /** User information (optional, for CRDT operations) */
  user?: User;
  /** Namespace for offline storage (default: "collabkit") */
  storageNamespace?: string;
}

type StateListener = (state: Record<string, unknown>) => void;
type PresenceListener = (presence: { users: User[]; presenceMap: Map<string, PresenceData> }) => void;
type ConnectionListener = (state: ConnectionState) => void;
type OperationListener = (operation: Operation, userId: string) => void;

interface Room {
  id: string;
  state: Record<string, unknown>;
  /** CRDT state for conflict-free synchronization */
  crdt?: LWWMap;
  presence: Map<string, PresenceData>;
  users: User[];
  stateListeners: Set<StateListener>;
  presenceListeners: Set<PresenceListener>;
  operationListeners: Set<OperationListener>;
}

export class CollabkitClient {
  private url: string;
  private getToken: () => Promise<string> | string;
  private ws: WebSocket | null = null;
  private connectionState: ConnectionState = "disconnected";
  private connectionListeners = new Set<ConnectionListener>();
  private rooms = new Map<string, Room>();
  private roomRefCounts = new Map<string, number>();
  private userId: string | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private pendingCalls = new Map<string, {
    resolve: (result: unknown) => void;
    reject: (error: Error) => void;
  }>();
  private callIdCounter = 0;

  // CRDT-related fields
  private user?: User;
  private offlineQueue: OfflineQueue;

  // Rate limiter for outgoing messages
  private rateLimiter = new ClientRateLimiter();

  // Pending token for first-message auth
  private pendingToken: string | null = null;

  // Heartbeat interval to keep connection alive
  private pingInterval: ReturnType<typeof setInterval> | null = null;

  // Set to true during intentional disconnect to prevent auto-reconnect
  private closing = false;

  // Screen share managers per room
  private screenShareManagers = new Map<string, ScreenShareManager>();

  constructor(options: CollabkitClientOptions) {
    this.url = options.url;
    this.getToken = options.getToken;
    this.user = options.user;
    this.offlineQueue = new OfflineQueue(options.storageNamespace ?? "collabkit");
  }

  /**
   * Get the node ID for CRDT operations.
   * Uses user ID if available, otherwise generates a random ID.
   */
  private getNodeId(): string {
    return this.user?.id ?? this.userId ?? crypto.randomUUID();
  }

  async connect(): Promise<void> {
    if (this.connectionState === "connected" || this.connectionState === "connecting") {
      return;
    }

    this.closing = false;
    this.setConnectionState("connecting");

    try {
      // Get token but don't put it in URL to avoid logging exposure
      const token = await this.getToken();
      this.pendingToken = token;

      // Connect without token in URL - will send via first message
      this.ws = new WebSocket(this.url);

      this.ws.onopen = () => {
        this.setConnectionState("connected");
        this.reconnectAttempts = 0;

        // Send auth message with token (not in URL for security)
        if (this.pendingToken) {
          this.send({ type: "auth", token: this.pendingToken });
          this.pendingToken = null;
        }

        // Start heartbeat to keep connection alive
        this.startPingInterval();

        // Rejoin all rooms after reconnect
        for (const roomId of this.rooms.keys()) {
          this.sendJoinRoom(roomId);
        }
        // Replay offline queue
        this.replayAllOfflineQueue();
      };

      this.ws.onclose = () => {
        if (this.closing) return;
        this.setConnectionState("disconnected");
        this.attemptReconnect();
      };

      this.ws.onerror = () => {
        this.setConnectionState("error");
      };

      this.ws.onmessage = (event) => {
        this.handleMessage(event.data);
      };

      // Wait for connection to be established
      await new Promise<void>((resolve, reject) => {
        const onOpen = () => {
          cleanup();
          resolve();
        };
        const onError = () => {
          cleanup();
          reject(new Error("Failed to connect"));
        };
        const cleanup = () => {
          this.ws?.removeEventListener("open", onOpen);
          this.ws?.removeEventListener("error", onError);
        };
        this.ws?.addEventListener("open", onOpen);
        this.ws?.addEventListener("error", onError);
      });
    } catch (error) {
      this.setConnectionState("error");
      throw error;
    }
  }

  disconnect(): void {
    this.closing = true;

    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.setConnectionState("disconnected");

    // Destroy all screen share managers
    for (const [, manager] of this.screenShareManagers) {
      manager.destroy();
    }
    this.screenShareManagers.clear();

    this.rooms.clear();
    this.roomRefCounts.clear();

    // Reject all pending calls
    for (const [, { reject }] of this.pendingCalls) {
      reject(new Error("Client disconnected"));
    }
    this.pendingCalls.clear();
  }

  getConnectionState(): ConnectionState {
    return this.connectionState;
  }

  subscribeToConnection(listener: ConnectionListener): () => void {
    this.connectionListeners.add(listener);
    return () => {
      this.connectionListeners.delete(listener);
    };
  }

  joinRoom(roomId: string): void {
    const refCount = this.roomRefCounts.get(roomId) ?? 0;
    this.roomRefCounts.set(roomId, refCount + 1);

    if (refCount === 0) {
      // First subscription to this room
      const room: Room = {
        id: roomId,
        state: {},
        presence: new Map(),
        users: [],
        stateListeners: new Set(),
        presenceListeners: new Set(),
        operationListeners: new Set(),
      };

      // Initialize CRDT for the room
      room.crdt = new LWWMap(this.getNodeId());

      this.rooms.set(roomId, room);

      if (this.connectionState === "connected") {
        this.sendJoinRoom(roomId);
        // Replay offline queue for this room
        this.replayOfflineQueue(roomId);
      }
    }
  }

  leaveRoom(roomId: string): void {
    const refCount = this.roomRefCounts.get(roomId) ?? 0;
    if (refCount <= 1) {
      this.roomRefCounts.delete(roomId);
      this.rooms.delete(roomId);

      // Destroy screen share manager for this room
      const ssManager = this.screenShareManagers.get(roomId);
      if (ssManager) {
        ssManager.destroy();
        this.screenShareManagers.delete(roomId);
      }

      if (this.connectionState === "connected") {
        this.send({ type: "leave", room_id: roomId });
      }
    } else {
      this.roomRefCounts.set(roomId, refCount - 1);
    }
  }

  getRoomState(roomId: string): Record<string, unknown> {
    return this.rooms.get(roomId)?.state ?? {};
  }

  getStateAtPath<T>(roomId: string, path?: string): T | undefined {
    const state = this.getRoomState(roomId);
    if (!path) {
      return state as T;
    }

    const parts = path.split(".");
    let current: unknown = state;

    for (const part of parts) {
      if (current === null || current === undefined || typeof current !== "object") {
        return undefined;
      }
      current = (current as Record<string, unknown>)[part];
    }

    return current as T;
  }

  setStateAtPath(roomId: string, path: string | undefined, value: unknown): void {
    const room = this.rooms.get(roomId);
    if (!room) {
      console.warn("[CollabkitClient] Room not found for setStateAtPath", roomId);
      return;
    }

    if (!room.crdt) {
      console.error("[CollabkitClient] Room CRDT not initialized", roomId);
      return;
    }

    const pathArray = path ? path.split(".") : [];
    const op = room.crdt.set(pathArray, value);
    room.state = room.crdt.value();

    // Notify listeners
    this.notifyStateListeners(roomId);

    // Send operation to server or queue for offline
    if (this.connectionState === "connected") {
      this.send({
        type: "operation",
        room_id: roomId,
        operation: operationToDict(op),
      });
    } else {
      this.offlineQueue.enqueue(roomId, op);
    }
  }

  /**
   * Delete a value at a specific path.
   */
  deleteStateAtPath(roomId: string, path: string): void {
    const room = this.rooms.get(roomId);
    if (!room || !room.crdt) return;

    const pathArray = path.split(".");
    const op = room.crdt.delete(pathArray);
    room.state = room.crdt.value();

    // Notify listeners
    this.notifyStateListeners(roomId);

    // Send operation to server or queue for offline
    if (this.connectionState === "connected") {
      this.send({
        type: "operation",
        room_id: roomId,
        operation: operationToDict(op),
      });
    } else {
      this.offlineQueue.enqueue(roomId, op);
    }
  }

  /**
   * Get the CRDT instance for a room.
   */
  getRoomCRDT(roomId: string): LWWMap | undefined {
    return this.rooms.get(roomId)?.crdt;
  }

  subscribeToState(roomId: string, listener: StateListener): () => void {
    const room = this.rooms.get(roomId);
    if (!room) {
      // Room doesn't exist yet - this shouldn't happen if useRoom is called first
      // but we handle it gracefully by returning a no-op unsubscribe
      console.warn(`subscribeToState called for room "${roomId}" that doesn't exist. Call joinRoom first.`);
      return () => {};
    }

    room.stateListeners.add(listener);
    return () => {
      room.stateListeners.delete(listener);
    };
  }

  /**
   * Subscribe to CRDT operations for a room.
   */
  subscribeToOperations(roomId: string, listener: OperationListener): () => void {
    const room = this.rooms.get(roomId);
    if (!room) {
      return () => {};
    }

    room.operationListeners.add(listener);
    return () => {
      room.operationListeners.delete(listener);
    };
  }

  getRoomPresence(roomId: string): { users: User[]; presenceMap: Map<string, PresenceData> } {
    const room = this.rooms.get(roomId);
    return {
      users: room?.users ?? [],
      presenceMap: room?.presence ?? new Map(),
    };
  }

  updatePresence(roomId: string, data: PresenceData): void {
    const room = this.rooms.get(roomId);
    if (!room || !this.userId) return;

    room.presence.set(this.userId, data);
    this.notifyPresenceListeners(roomId);

    this.send({
      type: "presence",
      room_id: roomId,
      data,
    });
  }

  subscribeToPresence(roomId: string, listener: PresenceListener): () => void {
    const room = this.rooms.get(roomId);
    if (!room) {
      // Room doesn't exist yet - this shouldn't happen if useRoom is called first
      // but we handle it gracefully by returning a no-op unsubscribe
      console.warn(`subscribeToPresence called for room "${roomId}" that doesn't exist. Call joinRoom first.`);
      return () => {};
    }

    room.presenceListeners.add(listener);
    return () => {
      room.presenceListeners.delete(listener);
    };
  }

  async callFunction<TArgs = unknown, TResult = unknown>(
    roomId: string,
    functionName: string,
    args: TArgs
  ): Promise<TResult> {
    const callId = `call_${++this.callIdCounter}`;

    return new Promise<TResult>((resolve, reject) => {
      this.pendingCalls.set(callId, {
        resolve: resolve as (result: unknown) => void,
        reject,
      });

      this.send({
        type: "call",
        call_id: callId,
        room_id: roomId,
        function_name: functionName,
        args: [args],
      });

      // Timeout after 30 seconds
      setTimeout(() => {
        const pending = this.pendingCalls.get(callId);
        if (pending) {
          this.pendingCalls.delete(callId);
          pending.reject(new Error(`Function call timeout: ${functionName}`));
        }
      }, 30000);
    });
  }

  /**
   * Get or create a ScreenShareManager for a room.
   * Returns null if the room hasn't been joined yet.
   */
  getScreenShareManager(roomId: string): ScreenShareManager | null {
    const room = this.rooms.get(roomId);
    if (!room) return null;

    if (!this.screenShareManagers.has(roomId)) {
      const manager = new ScreenShareManager({
        roomId,
        userId: this.userId ?? this.getNodeId(),
        sendSignal: (msg) => this.send(msg),
        getRoomUsers: () => this.rooms.get(roomId)?.users ?? [],
      });
      this.screenShareManagers.set(roomId, manager);
    }

    return this.screenShareManagers.get(roomId)!;
  }

  private setConnectionState(state: ConnectionState): void {
    this.connectionState = state;
    for (const listener of this.connectionListeners) {
      listener(state);
    }
  }

  private attemptReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.setConnectionState("error");
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);

    this.reconnectTimeout = setTimeout(() => {
      this.connect().catch(() => {
        // Error will be handled by the connect method
      });
    }, delay);
  }

  private startPingInterval(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
    }
    // Send ping every 30 seconds to keep the connection alive
    this.pingInterval = setInterval(() => {
      this.send({ type: "ping" });
    }, 30000);
  }

  private sendJoinRoom(roomId: string): void {
    this.send({ type: "join", room_id: roomId });
  }

  private send(message: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn("[CollabkitClient] Cannot send - WebSocket not open");
      return;
    }

    // Rate limiting (skip for auth and ICE candidate messages)
    if (message.type !== "auth" && message.type !== "rtc_ice_candidate" && !this.rateLimiter.canSend()) {
      console.warn("[CollabkitClient] Rate limit exceeded, message dropped");
      return;
    }

    const serialized = JSON.stringify(message);

    // Message size check
    if (serialized.length > MAX_MESSAGE_SIZE) {
      console.error("[CollabkitClient] Message too large, not sending");
      return;
    }

    this.ws.send(serialized);
  }

  private handleMessage(data: string): void {
    // Message size check
    if (data.length > MAX_MESSAGE_SIZE) {
      console.error("[CollabkitClient] Received message too large, ignoring");
      return;
    }

    try {
      const parsed = JSON.parse(data);

      // Validate message structure
      if (!isValidServerMessage(parsed)) {
        console.error("[CollabkitClient] Invalid message structure, ignoring");
        return;
      }

      const message = parsed;

      switch (message.type) {
        case "authenticated":
          this.userId = (message.user_id ?? message.userId) as string;
          break;

        case "joined":
          this.handleJoined(message);
          break;

        case "presence":
          this.handlePresenceUpdate(message);
          break;

        case "user_joined":
          this.handleUserJoined(message);
          break;

        case "user_left":
          this.handleUserLeft(message);
          break;

        case "call_result":
          this.handleFunctionResult(message);
          break;

        case "operation":
          this.handleOperation(message);
          break;

        case "sync":
          this.handleSync(message);
          break;

        case "error":
          console.error("[CollabkitClient] Server error:", message.code, message.message);
          break;

        // Screen share / WebRTC signaling
        case "screenshare_started":
          this.handleScreenShareStarted(message);
          break;
        case "screenshare_stopped":
          this.handleScreenShareStopped(message);
          break;
        case "rtc_offer":
          this.handleRtcOffer(message);
          break;
        case "rtc_answer":
          this.handleRtcAnswer(message);
          break;
        case "rtc_ice_candidate":
          this.handleRtcIceCandidate(message);
          break;
        case "remote_control_request":
          this.handleRemoteControlRequest(message);
          break;
        case "remote_control_response":
          this.handleRemoteControlResponse(message);
          break;
      }
    } catch {
      console.error("Failed to parse message:", data);
    }
  }

  /**
   * Handle incoming CRDT operation from server.
   */
  private handleOperation(message: Record<string, unknown>): void {
    const roomId = message.room_id as string;
    const room = this.rooms.get(roomId);
    if (!room) return;

    const operationData = message.operation as Record<string, unknown>;
    const userId = message.user_id as string;

    // Validate and deserialize operation (throws on prototype pollution)
    let operation: Operation;
    try {
      operation = operationFromDict(operationData);
    } catch (e) {
      console.error("[CollabkitClient] Invalid operation received, ignoring:", e);
      return;
    }

    // Apply operation to CRDT
    if (room.crdt) {
      room.crdt.apply(operation);
      room.state = room.crdt.value();
    }

    // Notify operation listeners
    for (const listener of room.operationListeners) {
      listener(operation, userId);
    }

    this.notifyStateListeners(roomId);
  }

  /**
   * Handle sync message from server.
   */
  private handleSync(message: Record<string, unknown>): void {
    const roomId = message.room_id as string;
    const room = this.rooms.get(roomId);
    if (!room) return;

    const stateData = message.state as Record<string, unknown>;

    // Validate state data for prototype pollution
    try {
      validateValue(stateData, "sync.state");
    } catch (e) {
      console.error("[CollabkitClient] Invalid sync state received, ignoring:", e);
      return;
    }

    room.crdt = LWWMap.fromState(this.getNodeId(), stateData);
    room.state = room.crdt.value();

    // Apply any additional operations
    const operations = message.operations as Record<string, unknown>[] | undefined;
    if (operations && room.crdt) {
      for (const opData of operations) {
        try {
          const op = operationFromDict(opData);
          room.crdt.apply(op);
        } catch (e) {
          console.error("[CollabkitClient] Invalid operation in sync, skipping:", e);
          continue;
        }
      }
      room.state = room.crdt.value();
    }

    this.notifyStateListeners(roomId);
  }

  /**
   * Replay offline queue for a room.
   */
  private replayOfflineQueue(roomId: string): void {
    const operations = this.offlineQueue.drain(roomId);
    for (const { operation } of operations) {
      this.send({
        type: "operation",
        room_id: roomId,
        operation: operationToDict(operation),
      });
    }
  }

  /**
   * Replay all offline queued operations.
   */
  private replayAllOfflineQueue(): void {
    const operations = this.offlineQueue.drainAll();
    for (const { roomId, operation } of operations) {
      this.send({
        type: "operation",
        room_id: roomId,
        operation: operationToDict(operation),
      });
    }
  }

  private handleJoined(message: Record<string, unknown>): void {
    const roomId = message.room_id as string;
    const room = this.rooms.get(roomId);
    if (!room) {
      console.warn("[CollabkitClient] Received joined for unknown room", roomId);
      return;
    }

    this.userId = message.user_id as string;
    room.state = (message.state as Record<string, unknown>) ?? {};
    room.users = (message.users as User[]) ?? [];

    // Initialize CRDT with server state
    if (room.crdt) {
      room.crdt = LWWMap.fromState(this.getNodeId(), room.state);
    }

    this.notifyStateListeners(roomId);
    this.notifyPresenceListeners(roomId);
  }

  private handlePresenceUpdate(message: Record<string, unknown>): void {
    const roomId = message.room_id as string;
    const userId = message.user_id as string;
    const data = message.data as PresenceData;

    const room = this.rooms.get(roomId);
    if (!room) return;

    room.presence.set(userId, data);
    this.notifyPresenceListeners(roomId);
  }

  private handleUserJoined(message: Record<string, unknown>): void {
    const roomId = message.room_id as string;
    const user = message.user as User;

    const room = this.rooms.get(roomId);
    if (!room) return;

    if (!room.users.some((u) => u.id === user.id)) {
      room.users = [...room.users, user];
    }

    this.notifyPresenceListeners(roomId);

    // Notify screen share manager so sharer can create offer for new viewer
    const ssManager = this.screenShareManagers.get(roomId);
    if (ssManager) {
      ssManager.handleUserJoined(user.id);
    }
  }

  private handleUserLeft(message: Record<string, unknown>): void {
    const roomId = message.room_id as string;
    const userId = message.user_id as string;

    const room = this.rooms.get(roomId);
    if (!room) return;

    room.users = room.users.filter((u) => u.id !== userId);
    room.presence.delete(userId);

    this.notifyPresenceListeners(roomId);

    // Notify screen share manager to close peer connection
    const ssManager = this.screenShareManagers.get(roomId);
    if (ssManager) {
      ssManager.handleUserLeft(userId);
    }
  }

  private handleFunctionResult(message: Record<string, unknown>): void {
    const callId = message.call_id as string;
    const result = message.result;

    const pending = this.pendingCalls.get(callId);
    if (pending) {
      this.pendingCalls.delete(callId);
      if (message.success) {
        pending.resolve(result);
      } else {
        pending.reject(new Error(message.error as string || "Unknown error"));
      }
    }
  }

  // ---- Screen Share / WebRTC Signal Handlers ----

  private handleScreenShareStarted(message: Record<string, unknown>): void {
    const roomId = message.room_id as string;
    const manager = this.getScreenShareManager(roomId);
    if (manager) {
      manager.handleScreenShareStarted(
        message.user_id as string,
        (message.share_name as string) ?? null
      );
    }
  }

  private handleScreenShareStopped(message: Record<string, unknown>): void {
    const roomId = message.room_id as string;
    const manager = this.getScreenShareManager(roomId);
    if (manager) {
      manager.handleScreenShareStopped(message.user_id as string);
    }
  }

  private handleRtcOffer(message: Record<string, unknown>): void {
    const roomId = message.room_id as string;
    const manager = this.getScreenShareManager(roomId);
    if (manager) {
      manager.handleRtcOffer(
        message.from_user_id as string,
        message.sdp as string
      );
    }
  }

  private handleRtcAnswer(message: Record<string, unknown>): void {
    const roomId = message.room_id as string;
    const manager = this.getScreenShareManager(roomId);
    if (manager) {
      manager.handleRtcAnswer(
        message.from_user_id as string,
        message.sdp as string
      );
    }
  }

  private handleRtcIceCandidate(message: Record<string, unknown>): void {
    const roomId = message.room_id as string;
    const manager = this.getScreenShareManager(roomId);
    if (manager) {
      manager.handleRtcIceCandidate(
        message.from_user_id as string,
        message.candidate as string,
        (message.sdp_mid as string) ?? null,
        (message.sdp_m_line_index as number) ?? null
      );
    }
  }

  private handleRemoteControlRequest(message: Record<string, unknown>): void {
    const roomId = message.room_id as string;
    const manager = this.getScreenShareManager(roomId);
    if (manager) {
      manager.handleRemoteControlRequest(message.from_user_id as string);
    }
  }

  private handleRemoteControlResponse(message: Record<string, unknown>): void {
    const roomId = message.room_id as string;
    const manager = this.getScreenShareManager(roomId);
    if (manager) {
      manager.handleRemoteControlResponse(
        message.from_user_id as string,
        message.granted as boolean
      );
    }
  }

  private notifyStateListeners(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;

    for (const listener of room.stateListeners) {
      listener(room.state);
    }
  }

  private notifyPresenceListeners(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;

    const presence = {
      users: room.users,
      presenceMap: room.presence,
    };

    for (const listener of room.presenceListeners) {
      listener(presence);
    }
  }
}
