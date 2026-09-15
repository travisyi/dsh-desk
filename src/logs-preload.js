'use strict';

/**
 * Bridge for the log window (a local page, so it may safely have a preload).
 * The Harness GUI itself never gets one.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dshLogs', {
  /** Snapshot of both logs plus the paths and service status. */
  read: () => ipcRenderer.invoke('logs:read'),
  /** Reveal the log folder in Explorer. */
  openFolder: () => ipcRenderer.invoke('logs:openFolder'),
  /** Open settings.json in the default editor. */
  openSettings: () => ipcRenderer.invoke('logs:openSettings'),
  /** Re-read the snapshot on an interval without rebuilding IPC. */
  poll: (callback, intervalMs = 1500) => {
    const timer = setInterval(() => {
      ipcRenderer
        .invoke('logs:read')
        .then(callback)
        .catch(() => {});
    }, intervalMs);
    return () => clearInterval(timer);
  },
});
