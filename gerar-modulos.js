// Separa o "Painel de Scripts (Unificado)" em um script por módulo.
// Cada arquivo gerado é um userscript completo, com cabeçalho próprio.
const fs = require('fs');
const path = require('path');
const fonte = fs.readFileSync('src/embutidos/painel.user.txt', 'utf8');
const versao = (fonte.match(/@version\s+(\S+)/) || [, '1.0'])[1];
const linhas = fonte.split('\n');
const inicios = [], fins = [];
linhas.forEach((l, i) => { if (/^\s*\/\/ MÓDULO/.test(l)) inicios.push(i - 1); if (/registrarModulo\(criar/.test(l)) fins.push(i); });
const fimTotal = linhas.findIndex(l => /FIM DOS MODULOS/.test(l)) - 1;
const pasta = 'src/embutidos/modulos';
fs.rmSync(pasta, { recursive: true, force: true });
fs.mkdirSync(pasta, { recursive: true });
const lista = [];
inicios.forEach((ini, k) => {
    const fim = k === inicios.length - 1 ? fimTotal : fins[k];
    let trecho = linhas.slice(ini, fim + 1);
    // tira a indentação comum
    const ind = Math.min(...trecho.filter(l => l.trim()).map(l => l.match(/^ */)[0].length));
    trecho = trecho.map(l => l.slice(Math.min(ind, l.match(/^ */)[0].length))).join('\n').replace(/\s+$/, '') + '\n';
    const m = trecho.match(/id:\s*['"]([^'"]+)['"]\s*,\s*name:\s*['"]([^'"]+)['"]\s*,\s*defaultOn:\s*(true|false)/);
    if (!m) throw new Error('módulo sem id no trecho ' + k);
    const [, id, nomeCompleto, defaultOn] = m;
    const sup = nomeCompleto.toUpperCase();
    const grupo = sup.startsWith('SMART BUS') ? 'SmartBus' : sup.startsWith('TALLOS') ? 'Tallos' : 'Outros';
    const nome = nomeCompleto.replace(/^(SMART BUS|TALLOS)\s*[-—]\s*/i, '').trim();
    const descricao = (linhas[ini + 1].match(/MÓDULO[^—-]*[—-]\s*(.*)/) || [, nome])[1].trim();
    const matches = grupo === 'SmartBus' ? ['*://*.smarttravelit.com/*'] : grupo === 'Tallos' ? ['*://*.tallos.com.br/*'] : ['*://*.smarttravelit.com/*', '*://*.tallos.com.br/*'];
    const cab = [
        '// ==UserScript==',
        `// @name         ${nome}`,
        `// @version      ${versao}`,
        `// @description  ${descricao}`,
        ...matches.map(x => `// @match        ${x}`),
        `// @grupo        ${grupo}`,
        '// ==/UserScript==',
        '',
        '// Este script é um módulo: registrarModulo() liga e desliga o módulo pelo hub,',
        '// sem precisar recarregar a página.',
        ''
    ].join('\n');
    const arquivo = `mod-${id.replace(/[^a-zA-Z0-9_-]/g, '-')}.user.txt`;
    // Se existe uma versão nova do módulo em substituicoes/, ela entra no lugar.
    const subst = path.join('src/embutidos/substituicoes', arquivo);
    fs.writeFileSync(path.join(pasta, arquivo), fs.existsSync(subst) ? fs.readFileSync(subst, 'utf8') : cab + trecho);
    lista.push({ id: 'mod-' + id.replace(/[^a-zA-Z0-9_-]/g, '-'), modulo: id, arquivo, defaultOn: defaultOn === 'true' });
});
fs.writeFileSync(path.join(pasta, 'index.js'),
    '// Gerado por gerar-modulos.js\nmodule.exports = [\n' +
    lista.map(x => `    { id: ${JSON.stringify(x.id)}, modulo: ${JSON.stringify(x.modulo)}, arquivo: ${JSON.stringify(x.arquivo.replace('.txt', '.js'))}, defaultOn: ${x.defaultOn}, fonte: require('./${x.arquivo}') }`).join(',\n') +
    '\n];\n');
console.log(lista.map(x => x.id).join('\n'));

// ---------- Módulos extras (scripts próprios, fora do painel unificado) ----------
// Cada um já é um userscript completo em src/embutidos/extras/<modulo>.user.txt.
const EXTRAS = [
    { modulo: 'fast_loading', defaultOn: true },
];
for (const x of EXTRAS) {
    const arquivo = `mod-${x.modulo}.user.txt`;
    fs.copyFileSync(path.join('src/embutidos/extras', `${x.modulo}.user.txt`), path.join(pasta, arquivo));
    lista.push({ id: 'mod-' + x.modulo, modulo: x.modulo, arquivo, defaultOn: x.defaultOn });
}
fs.writeFileSync(path.join(pasta, 'index.js'),
    '// Gerado por gerar-modulos.js\nmodule.exports = [\n' +
    lista.map(x => `    { id: ${JSON.stringify(x.id)}, modulo: ${JSON.stringify(x.modulo)}, arquivo: ${JSON.stringify(x.arquivo.replace('.txt', '.js'))}, defaultOn: ${x.defaultOn}, fonte: require('./${x.arquivo}') }`).join(',\n') +
    '\n];\n');
console.log('extras:', EXTRAS.map(x => x.modulo).join(', '));
