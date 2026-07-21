const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('appApi', {
  adminLogin: (account, password) => ipcRenderer.invoke('auth:login', account, password), authStatus: () => ipcRenderer.invoke('auth:status'),
  chooseFolder: () => ipcRenderer.invoke('folder:choose'), startNew: (root, options) => ipcRenderer.invoke('task:startNew', root, options),
  continueSaved: (root, options) => ipcRenderer.invoke('task:continueSaved', root, options), inspectSaved: (root) => ipcRenderer.invoke('task:inspectSaved', root),
  pause: () => ipcRenderer.invoke('task:pause'), resume: () => ipcRenderer.invoke('task:resume'), stop: () => ipcRenderer.invoke('task:stop'),
  login: (root) => ipcRenderer.invoke('task:login', root), openOutput: (root) => ipcRenderer.invoke('folder:openOutput', root),
  getVersion: () => ipcRenderer.invoke('app:version'), getUpdateSettings: () => ipcRenderer.invoke('update:getSettings'), chooseUpdateSource: () => ipcRenderer.invoke('update:chooseSource'), saveUpdateSettings: (settings) => ipcRenderer.invoke('update:saveSettings', settings),
  checkUpdate: (source) => ipcRenderer.invoke('update:check', source), installUpdate: () => ipcRenderer.invoke('update:install'),
  onStatus: (fn) => ipcRenderer.on('task:status', (_e, value) => fn(value)), onLog: (fn) => ipcRenderer.on('task:log', (_e, value) => fn(value)), onUpdateStatus: (fn) => ipcRenderer.on('update:status', (_e, value) => fn(value))
});
