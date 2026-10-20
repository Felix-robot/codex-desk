const { contextBridge, ipcRenderer, webUtils } = require('electron');
contextBridge.exposeInMainWorld('desk', {
  call: (action, params = {}) => ipcRenderer.invoke('desk:call', action, params),
  onEvent: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('desk:event', listener);
    return () => ipcRenderer.removeListener('desk:event', listener);
  },
  filePath: (file) => webUtils.getPathForFile(file),
  platform: process.platform,
});
