// Troca o subsistema do exe de "console" (3) para "janela" (2): o Windows não abre a janela preta.
const fs = require('fs');
const arq = process.argv[2];
const fd = fs.openSync(arq, 'r+');
const b = Buffer.alloc(4096);
fs.readSync(fd, b, 0, 4096, 0);
if (b.toString('latin1', 0, 2) !== 'MZ') throw new Error('não é um exe');
const pe = b.readUInt32LE(0x3c);
if (b.toString('latin1', pe, pe + 4) !== 'PE\0\0') throw new Error('cabeçalho PE não encontrado');
const opt = pe + 24;
const magic = b.readUInt16LE(opt);
const pos = opt + 68;
console.log('magic', magic.toString(16), 'subsistema antes', b.readUInt16LE(pos));
const novo = Buffer.alloc(2); novo.writeUInt16LE(2);
fs.writeSync(fd, novo, 0, 2, pos);
fs.closeSync(fd);
const c = Buffer.alloc(2); const fd2 = fs.openSync(arq, 'r'); fs.readSync(fd2, c, 0, 2, pos); fs.closeSync(fd2);
console.log('subsistema depois', c.readUInt16LE(0));
