/**
 * ScreenShareManager - WebRTC-based screen sharing
 *
 * Manages peer connections, media streams, data channels for annotations,
 * and remote control requests. Uses the existing WebSocket connection
 * (via CollabkitClient) as the signaling channel.
 */

// ============================================================================
// Types
// ============================================================================

export type ScreenShareRole = "sharer" | "viewer" | "idle";

export interface ScreenShareState {
  role: ScreenShareRole;
  sharerId: string | null;
  shareName: string | null;
  viewers: string[];
  localStream: MediaStream | null;
  remoteStreams: Map<string, MediaStream>;
  remoteControlGrantedTo: string | null;
  remoteControlRequestsFrom: string[];
}

export interface Annotation {
  id: string;
  type: "freehand" | "arrow" | "rectangle" | "text";
  authorId: string;
  color: string;
  points?: Array<{ x: number; y: number }>;
  text?: string;
  rect?: { x: number; y: number; width: number; height: number };
  timestamp: number;
}

export type ScreenShareEvent =
  | { type: "state_changed"; state: ScreenShareState }
  | { type: "annotation_received"; annotation: Annotation }
  | { type: "remote_control_request"; fromUserId: string }
  | { type: "remote_control_response"; fromUserId: string; granted: boolean }
  | { type: "cursor_received"; fromUserId: string; x: number; y: number }
  | { type: "error"; error: Error };

export type ScreenShareEventListener = (event: ScreenShareEvent) => void;

export interface DisplayMediaOptions {
  video?: boolean | MediaTrackConstraints;
  audio?: boolean;
}

export interface ScreenShareManagerConfig {
  roomId: string;
  userId: string;
  sendSignal: (message: Record<string, unknown>) => void;
  getRoomUsers: () => Array<{ id: string }>;
  rtcConfig?: RTCConfiguration;
}

// ============================================================================
// ScreenShareManager
// ============================================================================

export class ScreenShareManager {
  private role: ScreenShareRole = "idle";
  private sharerId: string | null = null;
  private shareName: string | null = null;
  private localStream: MediaStream | null = null;
  private peerConnections = new Map<string, RTCPeerConnection>();
  private dataChannels = new Map<string, RTCDataChannel>();
  private remoteStreams = new Map<string, MediaStream>();
  private pendingIceCandidates = new Map<string, RTCIceCandidateInit[]>();
  private remoteControlGrantedTo: string | null = null;
  private remoteControlRequestsFrom: string[] = [];
  private listeners = new Set<ScreenShareEventListener>();

  private sendSignal: (message: Record<string, unknown>) => void;
  private getRoomUsers: () => Array<{ id: string }>;
  private userId: string;
  private roomId: string;

  private rtcConfig: RTCConfiguration = {
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" },
    ],
  };

  constructor(config: ScreenShareManagerConfig) {
    this.roomId = config.roomId;
    this.userId = config.userId;
    this.sendSignal = config.sendSignal;
    this.getRoomUsers = config.getRoomUsers;
    if (config.rtcConfig) this.rtcConfig = config.rtcConfig;
  }

  // ---- Public API ----

  subscribe(listener: ScreenShareEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getState(): ScreenShareState {
    return {
      role: this.role,
      sharerId: this.sharerId,
      shareName: this.shareName,
      viewers: Array.from(this.peerConnections.keys()),
      localStream: this.localStream,
      remoteStreams: new Map(this.remoteStreams),
      remoteControlGrantedTo: this.remoteControlGrantedTo,
      remoteControlRequestsFrom: [...this.remoteControlRequestsFrom],
    };
  }

  async startSharing(options?: DisplayMediaOptions): Promise<void> {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: options?.video ?? true,
        audio: options?.audio ?? false,
      });

      // If already sharing, replace tracks instead of creating new connections
      if (this.role === "sharer" && this.localStream) {
        await this.replaceStreamTracks(stream);
        return;
      }

      this.localStream = stream;
      this.role = "sharer";
      this.sharerId = this.userId;

      // Listen for the browser "Stop sharing" button
      for (const track of stream.getTracks()) {
        track.addEventListener("ended", () => {
          this.stopSharing();
        });
      }

      // Notify server
      this.sendSignal({
        type: "screenshare_start",
        room_id: this.roomId,
        share_name: this.shareName,
      });

      this.emitStateChanged();
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e));
      this.emitEvent({ type: "error", error });
      throw error;
    }
  }

  async stopSharing(): Promise<void> {
    if (this.role !== "sharer") return;

    // Stop all local tracks
    if (this.localStream) {
      for (const track of this.localStream.getTracks()) {
        track.stop();
      }
      this.localStream = null;
    }

    // Close all peer connections
    for (const peerId of Array.from(this.peerConnections.keys())) {
      this.closePeerConnection(peerId);
    }

    // Notify server
    this.sendSignal({
      type: "screenshare_stop",
      room_id: this.roomId,
    });

    // Reset state
    this.role = "idle";
    this.sharerId = null;
    this.shareName = null;
    this.remoteControlGrantedTo = null;
    this.remoteControlRequestsFrom = [];

    this.emitStateChanged();
  }

  requestRemoteControl(sharerUserId: string): void {
    this.sendSignal({
      type: "remote_control_request",
      room_id: this.roomId,
      target_user_id: sharerUserId,
    });
  }

  grantRemoteControl(viewerUserId: string): void {
    this.remoteControlGrantedTo = viewerUserId;
    this.remoteControlRequestsFrom = this.remoteControlRequestsFrom.filter(
      (id) => id !== viewerUserId
    );
    this.sendSignal({
      type: "remote_control_response",
      room_id: this.roomId,
      target_user_id: viewerUserId,
      granted: true,
    });
    this.emitStateChanged();
  }

  denyRemoteControl(viewerUserId: string): void {
    this.remoteControlRequestsFrom = this.remoteControlRequestsFrom.filter(
      (id) => id !== viewerUserId
    );
    this.sendSignal({
      type: "remote_control_response",
      room_id: this.roomId,
      target_user_id: viewerUserId,
      granted: false,
    });
    this.emitStateChanged();
  }

  revokeRemoteControl(): void {
    if (this.remoteControlGrantedTo) {
      this.sendSignal({
        type: "remote_control_response",
        room_id: this.roomId,
        target_user_id: this.remoteControlGrantedTo,
        granted: false,
      });
      this.remoteControlGrantedTo = null;
      this.emitStateChanged();
    }
  }

  sendAnnotation(
    annotation: Omit<Annotation, "id" | "authorId" | "timestamp">
  ): void {
    const full: Annotation = {
      ...annotation,
      id: `ann-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      authorId: this.userId,
      timestamp: Date.now(),
    };

    // Send via all data channels
    const msg = JSON.stringify({ type: "annotation", annotation: full });
    for (const [, channel] of this.dataChannels) {
      if (channel.readyState === "open") {
        channel.send(msg);
      }
    }

    // Emit locally so the sender also sees their annotation
    this.emitEvent({ type: "annotation_received", annotation: full });
  }

  sendCursorPosition(x: number, y: number): void {
    const msg = JSON.stringify({ type: "cursor", x, y, userId: this.userId });
    for (const [, channel] of this.dataChannels) {
      if (channel.readyState === "open") {
        channel.send(msg);
      }
    }
  }

  clearAnnotations(): void {
    const msg = JSON.stringify({ type: "clear_annotations" });
    for (const [, channel] of this.dataChannels) {
      if (channel.readyState === "open") {
        channel.send(msg);
      }
    }
  }

  destroy(): void {
    if (this.role === "sharer") {
      this.stopSharing();
    }

    for (const peerId of Array.from(this.peerConnections.keys())) {
      this.closePeerConnection(peerId);
    }

    this.listeners.clear();
    this.role = "idle";
    this.sharerId = null;
    this.localStream = null;
    this.remoteStreams.clear();
  }

  // ---- Signal Handlers (called by CollabkitClient) ----

  handleScreenShareStarted(userId: string, shareName: string | null): void {
    this.sharerId = userId;
    this.shareName = shareName;

    if (userId === this.userId) {
      // We are the sharer — now create offers for all existing room users
      this.role = "sharer";
      const users = this.getRoomUsers();
      for (const user of users) {
        if (user.id !== this.userId) {
          this.createOfferForViewer(user.id);
        }
      }
    } else {
      // Someone else is sharing — we become a viewer
      this.role = "viewer";
    }

    this.emitStateChanged();
  }

  handleScreenShareStopped(userId: string): void {
    if (userId === this.sharerId) {
      // Close all peer connections related to this share session
      for (const peerId of Array.from(this.peerConnections.keys())) {
        this.closePeerConnection(peerId);
      }

      this.remoteStreams.clear();
      this.role = "idle";
      this.sharerId = null;
      this.shareName = null;
      this.remoteControlGrantedTo = null;
      this.remoteControlRequestsFrom = [];

      // Stop local stream if we were the sharer
      if (userId === this.userId && this.localStream) {
        for (const track of this.localStream.getTracks()) {
          track.stop();
        }
        this.localStream = null;
      }

      this.emitStateChanged();
    }
  }

  async handleRtcOffer(fromUserId: string, sdp: string): Promise<void> {
    try {
      const pc = this.createPeerConnection(fromUserId, false);

      await pc.setRemoteDescription(
        new RTCSessionDescription({ type: "offer", sdp })
      );

      // Apply any buffered ICE candidates
      await this.applyPendingCandidates(fromUserId);

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      this.sendSignal({
        type: "rtc_answer",
        room_id: this.roomId,
        target_user_id: fromUserId,
        sdp: answer.sdp!,
      });
    } catch (e) {
      console.error("[ScreenShareManager] Error handling RTC offer:", e);
      this.emitEvent({
        type: "error",
        error: e instanceof Error ? e : new Error(String(e)),
      });
    }
  }

  async handleRtcAnswer(fromUserId: string, sdp: string): Promise<void> {
    const pc = this.peerConnections.get(fromUserId);
    if (!pc) return;

    try {
      await pc.setRemoteDescription(
        new RTCSessionDescription({ type: "answer", sdp })
      );

      // Apply any buffered ICE candidates
      await this.applyPendingCandidates(fromUserId);
    } catch (e) {
      console.error("[ScreenShareManager] Error handling RTC answer:", e);
    }
  }

  async handleRtcIceCandidate(
    fromUserId: string,
    candidate: string,
    sdpMid: string | null,
    sdpMLineIndex: number | null
  ): Promise<void> {
    const pc = this.peerConnections.get(fromUserId);

    const candidateInit: RTCIceCandidateInit = {
      candidate,
      sdpMid,
      sdpMLineIndex,
    };

    if (!pc || !pc.remoteDescription) {
      // Buffer until remote description is set
      const pending = this.pendingIceCandidates.get(fromUserId) ?? [];
      pending.push(candidateInit);
      this.pendingIceCandidates.set(fromUserId, pending);
      return;
    }

    try {
      await pc.addIceCandidate(new RTCIceCandidate(candidateInit));
    } catch (e) {
      console.error("[ScreenShareManager] Error adding ICE candidate:", e);
    }
  }

  handleRemoteControlRequest(fromUserId: string): void {
    if (!this.remoteControlRequestsFrom.includes(fromUserId)) {
      this.remoteControlRequestsFrom.push(fromUserId);
    }
    this.emitEvent({ type: "remote_control_request", fromUserId });
    this.emitStateChanged();
  }

  handleRemoteControlResponse(fromUserId: string, granted: boolean): void {
    this.emitEvent({ type: "remote_control_response", fromUserId, granted });
  }

  handleUserJoined(userId: string): void {
    // If we are sharing, create an offer for the new user
    if (this.role === "sharer" && userId !== this.userId && this.localStream) {
      this.createOfferForViewer(userId);
    }
  }

  handleUserLeft(userId: string): void {
    // Close peer connection for this user
    this.closePeerConnection(userId);

    // If the departed user was the sharer, reset to idle
    if (userId === this.sharerId) {
      this.remoteStreams.clear();
      this.role = "idle";
      this.sharerId = null;
      this.shareName = null;
      this.remoteControlGrantedTo = null;
      this.remoteControlRequestsFrom = [];
      this.emitStateChanged();
    }

    // Clean up remote control state
    if (this.remoteControlGrantedTo === userId) {
      this.remoteControlGrantedTo = null;
      this.emitStateChanged();
    }
    if (this.remoteControlRequestsFrom.includes(userId)) {
      this.remoteControlRequestsFrom =
        this.remoteControlRequestsFrom.filter((id) => id !== userId);
      this.emitStateChanged();
    }
  }

  // ---- Private Helpers ----

  private createPeerConnection(
    peerId: string,
    isInitiator: boolean
  ): RTCPeerConnection {
    // Close existing connection if any
    const existing = this.peerConnections.get(peerId);
    if (existing) {
      existing.close();
    }

    const pc = new RTCPeerConnection(this.rtcConfig);
    this.peerConnections.set(peerId, pc);

    // ICE candidate handling
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.sendSignal({
          type: "rtc_ice_candidate",
          room_id: this.roomId,
          target_user_id: peerId,
          candidate: event.candidate.candidate,
          sdp_mid: event.candidate.sdpMid,
          sdp_m_line_index: event.candidate.sdpMLineIndex,
        });
      }
    };

    // Connection state changes
    pc.onconnectionstatechange = () => {
      if (
        pc.connectionState === "disconnected" ||
        pc.connectionState === "failed" ||
        pc.connectionState === "closed"
      ) {
        this.closePeerConnection(peerId);
        this.emitStateChanged();
      }
    };

    // Track handling (viewer receives sharer's stream)
    pc.ontrack = (event) => {
      const stream =
        event.streams[0] ?? new MediaStream([event.track]);
      this.remoteStreams.set(peerId, stream);
      this.emitStateChanged();
    };

    // Data channel
    if (isInitiator) {
      const channel = pc.createDataChannel("annotations", {
        ordered: true,
      });
      this.setupDataChannel(channel, peerId);
    } else {
      pc.ondatachannel = (event) => {
        this.setupDataChannel(event.channel, peerId);
      };
    }

    return pc;
  }

  private async createOfferForViewer(viewerUserId: string): Promise<void> {
    try {
      const pc = this.createPeerConnection(viewerUserId, true);

      // Add all local stream tracks
      if (this.localStream) {
        for (const track of this.localStream.getTracks()) {
          pc.addTrack(track, this.localStream);
        }
      }

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      this.sendSignal({
        type: "rtc_offer",
        room_id: this.roomId,
        target_user_id: viewerUserId,
        sdp: offer.sdp!,
      });
    } catch (e) {
      console.error(
        "[ScreenShareManager] Error creating offer for viewer:",
        viewerUserId,
        e
      );
    }
  }

  private setupDataChannel(channel: RTCDataChannel, peerId: string): void {
    this.dataChannels.set(peerId, channel);

    channel.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        switch (data.type) {
          case "annotation":
            this.emitEvent({
              type: "annotation_received",
              annotation: data.annotation as Annotation,
            });
            break;
          case "cursor":
            this.emitEvent({
              type: "cursor_received",
              fromUserId: data.userId,
              x: data.x,
              y: data.y,
            });
            break;
          case "clear_annotations":
            // Emit a synthetic clear event — consumers should reset their annotation list
            this.emitEvent({
              type: "state_changed",
              state: this.getState(),
            });
            break;
        }
      } catch {
        // Ignore malformed data channel messages
      }
    };

    channel.onclose = () => {
      this.dataChannels.delete(peerId);
    };
  }

  private closePeerConnection(peerId: string): void {
    const pc = this.peerConnections.get(peerId);
    if (pc) {
      pc.close();
      this.peerConnections.delete(peerId);
    }

    const channel = this.dataChannels.get(peerId);
    if (channel) {
      channel.close();
      this.dataChannels.delete(peerId);
    }

    this.pendingIceCandidates.delete(peerId);
    this.remoteStreams.delete(peerId);
  }

  private async applyPendingCandidates(peerId: string): Promise<void> {
    const pending = this.pendingIceCandidates.get(peerId);
    if (!pending || pending.length === 0) return;

    const pc = this.peerConnections.get(peerId);
    if (!pc) return;

    this.pendingIceCandidates.delete(peerId);

    for (const candidateInit of pending) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidateInit));
      } catch (e) {
        console.error(
          "[ScreenShareManager] Error applying buffered ICE candidate:",
          e
        );
      }
    }
  }

  private async replaceStreamTracks(newStream: MediaStream): Promise<void> {
    const oldStream = this.localStream;
    this.localStream = newStream;

    // Listen for browser stop button on new tracks
    for (const track of newStream.getTracks()) {
      track.addEventListener("ended", () => {
        this.stopSharing();
      });
    }

    // Replace tracks on all existing peer connections
    for (const [, pc] of this.peerConnections) {
      const senders = pc.getSenders();
      for (const track of newStream.getTracks()) {
        const sender = senders.find(
          (s) => s.track?.kind === track.kind
        );
        if (sender) {
          await sender.replaceTrack(track);
        } else {
          pc.addTrack(track, newStream);
        }
      }
    }

    // Stop old tracks
    if (oldStream) {
      for (const track of oldStream.getTracks()) {
        track.stop();
      }
    }

    this.emitStateChanged();
  }

  private emitEvent(event: ScreenShareEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Don't let listener errors break the manager
      }
    }
  }

  private emitStateChanged(): void {
    this.emitEvent({ type: "state_changed", state: this.getState() });
  }
}
