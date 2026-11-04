const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  listAdapters: () => ipcRenderer.invoke('adapters:list'),
  startLogin: (adapterId) => ipcRenderer.invoke('login:start', adapterId),
  grabNow: (adapterId) => ipcRenderer.invoke('login:grabNow', adapterId),
  cancelLogin: () => ipcRenderer.invoke('login:cancel'),
  setToken: (adapterId, token) => ipcRenderer.invoke('token:set', adapterId, token),
  clearToken: (adapterId) => ipcRenderer.invoke('token:clear', adapterId),
  getServerInfo: () => ipcRenderer.invoke('server:getInfo'),
  restartServer: (port) => ipcRenderer.invoke('server:restart', port),
  refreshModels: () => ipcRenderer.invoke('models:refresh'),
  testChat: (adapterId, message) => ipcRenderer.invoke('test:chat', adapterId, message),
  openExternal: (url) => ipcRenderer.invoke('open:external', url),
  onServerError: (cb) => {
    ipcRenderer.on('server:error', (e, msg) => cb(msg));
  },
});
