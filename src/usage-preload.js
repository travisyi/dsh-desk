'use strict';

/**
 * Bridge for the token usage window (a local page, so it may safely have a
 * preload). The Harness GUI itself never gets one.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dshUsage', {
  /** Scan the session logs and return the aggregated usage report. */
  read: () => ipcRenderer.invoke('usage:read'),
  /** Reveal the Harness sessions folder in Explorer. */
  openSessionsFolder: () => ipcRenderer.invoke('usage:openFolder'),
  /** Copy the report as the same plain-text table the CLI prints. */
  asText: () => ipcRenderer.invoke('usage:asText'),
});
'use strict';

/**
 * Bridge for the token usage window (a local page, so it may safely have a
 * preload). The Harness GUI itself never gets one.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dshUsage', {
  /** Scan the session logs and return the aggregated usage report. */
  read: () => ipcRenderer.invoke('usage:read'),
  /** Reveal the Harness sessions folder in Explorer. */
  openSessionsFolder: () => ipcRenderer.invoke('usage:openFolder'),
  /** Copy the report as the same plain-text table the CLI prints. */
  asText: () => ipcRenderer.invoke('usage:asText'),
});
