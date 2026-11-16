// Monta src/embutidos/modulos/index.js com os scripts que vêm com o app.
// Para adicionar um script padrão: coloque mod-<id>.user.txt nessa pasta e rode "npm run gerar".
// Para tirar um script padrão das máquinas que já o têm: apague o arquivo e ponha o id em
// MODULOS_RETIRADOS (src/app.js).
const fs = require('fs');
const path = require('path');
const pasta = 'src/embutidos/modulos';
// Scripts que começam desligados numa instalação nova.
const DESLIGADOS = [];

const lista = fs.readdirSync(pasta).filter(f => /^mod-.+\.user\.txt$/.test(f)).sort().map(arquivo => {
    const id = arquivo.replace('.user.txt', '');
    return { id, modulo: id.slice(4), arquivo, defaultOn: !DESLIGADOS.includes(id) };
});
fs.writeFileSync(path.join(pasta, 'index.js'),
    '// Gerado por gerar-modulos.js\nmodule.exports = [\n' +
    lista.map(x => `    { id: ${JSON.stringify(x.id)}, modulo: ${JSON.stringify(x.modulo)}, arquivo: ${JSON.stringify(x.arquivo.replace('.txt', '.js'))}, defaultOn: ${x.defaultOn}, fonte: require('./${x.arquivo}') }`).join(',\n') +
    '\n];\n');
console.log(lista.map(x => x.id).join('\n'));
