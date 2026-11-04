const { app, dialog } = require('electron');
const fs = require('fs');
const path = require('path');
app.whenReady().then(() => {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(path.join(app.getPath('userData'), 'abriu.txt'), `${app.getVersion()} ${process.versions.electron}`);
    if (!process.argv.includes('--sem-janela')) {
        dialog.showMessageBoxSync({ type: 'info', title: 'Painel Teste', message: 'O Painel Teste abriu. Pode fechar e desinstalar.' });
    }
    app.quit();
});
