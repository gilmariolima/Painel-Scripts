const { app } = require('electron');
const fs = require('fs');
const path = require('path');
app.whenReady().then(() => {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(path.join(app.getPath('userData'), 'abriu.txt'), `${app.getVersion()} ${process.versions.electron}`);
    app.quit();
});
