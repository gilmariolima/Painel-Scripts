// Única ponte entre a janela e o processo principal.
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('painel', {
    api: (caminho, corpo) => ipcRenderer.invoke('api', caminho, corpo),
    aoMudar: fn => { ipcRenderer.on('estado:mudou', () => fn()); }
});
