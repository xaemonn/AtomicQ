import { useSyncExternalStore } from 'react';
import { io } from 'socket.io-client';
import type { JobEvent } from './api';

// One socket for the whole app. Same origin in production (served by the API
// server); proxied by Vite in dev.
const socket = io();

/** Subscribes to live job events. Returns the unsubscribe function. */
export function onJobEvent(listener: (event: JobEvent) => void): () => void {
  socket.on('job-event', listener);
  return () => {
    socket.off('job-event', listener);
  };
}

function subscribe(onChange: () => void): () => void {
  socket.on('connect', onChange);
  socket.on('disconnect', onChange);
  return () => {
    socket.off('connect', onChange);
    socket.off('disconnect', onChange);
  };
}

/** True while the Socket.IO connection to the server is up. */
export function useConnected(): boolean {
  return useSyncExternalStore(subscribe, () => socket.connected);
}
