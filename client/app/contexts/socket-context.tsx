"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  ReactNode,
} from "react";
import { io, Socket } from "socket.io-client";
import { API_URL } from "@/app/lib/constants";

interface SocketContextType {
  socket: Socket | null;
  isConnected: boolean;
  subscribeToVideo: (videoId: string) => void;
  unsubscribeFromVideo: (videoId: string) => void;
  subscribeToUpload: (uploadId: string) => void;
  unsubscribeFromUpload: (uploadId: string) => void;
  onVideoStatus: (callback: (event: VideoStatusEvent) => void) => () => void;
  onUploadProgress: (
    callback: (event: UploadProgressEvent) => void
  ) => () => void;
}

export type VideoStatus =
  | "pending_upload"
  | "uploading"
  | "processing"
  | "ready"
  | "failed"
  | "cancelled"
  | "deleted";

export interface VideoStatusEvent {
  videoId: string;
  status: VideoStatus;
  error?: string;
}

export interface UploadProgressEvent {
  uploadId: string;
  status: string;
  progress?: number;
  error?: string;
}

const SocketContext = createContext<SocketContextType | null>(null);

export function SocketProvider({ children }: { children: ReactNode }) {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [isConnected, setIsConnected] = useState(false);

  useEffect(() => {
    const socketInstance = io(API_URL, {
      transports: ["websocket", "polling"],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionAttempts: 5,
    });

    socketInstance.on("connect", () => {
      console.log("[Socket] Connected:", socketInstance.id);
      setIsConnected(true);
    });

    socketInstance.on("disconnect", () => {
      console.log("[Socket] Disconnected");
      setIsConnected(false);
    });

    socketInstance.on("error", (error) => {
      console.error("[Socket] Error:", error);
    });

    setSocket(socketInstance);

    return () => {
      socketInstance.disconnect();
    };
  }, []);

  const subscribeToVideo = (videoId: string) => {
    if (socket) {
      socket.emit("subscribe:video", videoId);
    }
  };

  const unsubscribeFromVideo = (videoId: string) => {
    if (socket) {
      socket.emit("unsubscribe:video", videoId);
    }
  };

  const subscribeToUpload = (uploadId: string) => {
    if (socket) {
      socket.emit("subscribe:upload", uploadId);
    }
  };

  const unsubscribeFromUpload = (uploadId: string) => {
    if (socket) {
      socket.emit("unsubscribe:upload", uploadId);
    }
  };

  const onVideoStatus = (callback: (event: VideoStatusEvent) => void) => {
    if (!socket) return () => {};

    socket.on("video:status", callback);

    return () => {
      socket.off("video:status", callback);
    };
  };

  const onUploadProgress = (callback: (event: UploadProgressEvent) => void) => {
    if (!socket) return () => {};

    socket.on("upload:progress", callback);

    return () => {
      socket.off("upload:progress", callback);
    };
  };

  return (
    <SocketContext.Provider
      value={{
        socket,
        isConnected,
        subscribeToVideo,
        unsubscribeFromVideo,
        subscribeToUpload,
        unsubscribeFromUpload,
        onVideoStatus,
        onUploadProgress,
      }}
    >
      {children}
    </SocketContext.Provider>
  );
}

export function useSocket() {
  const context = useContext(SocketContext);
  if (!context) {
    throw new Error("useSocket must be used within SocketProvider");
  }
  return context;
}
