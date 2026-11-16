'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const sp = require('../src/scriptsPerfil');

const sha = t => crypto.createHash('sha1').update(t).digest('hex');
const ler = arq => fs.readFileSync(arq, 'utf8');
function pastaTemp() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'painel-teste-'));
}
function gravar(arq, texto) {
    fs.mkdirSync(path.dirname(arq), { recursive: true });
    fs.writeFileSync(arq, texto);
}
const EMBUTIDOS = [
    { id: 'mod-a', arquivo: 'mod-a.user.js', fonte: 'A v2', defaultOn: true },
    { id: 'mod-b', arquivo: 'mod-b.user.js', fonte: 'B v1', defaultOn: false }
];

test('estado vazio de scripts', () => {
    assert.deepEqual(sp.estadoVazio(), { scriptsExtras: [], modulosRemovidos: [], hashes: {} });
});

test('normalizar completa campos que faltam sem trocar os que existem', () => {
    const e = { scriptsExtras: [{ id: 'x', arquivo: 'x.user.js' }] };
    sp.normalizar(e);
    assert.deepEqual(e.scriptsExtras, [{ id: 'x', arquivo: 'x.user.js' }]);
    assert.deepEqual(e.modulosRemovidos, []);
    assert.deepEqual(e.hashes, {});
    assert.deepEqual(e.scripts, {});
});

test('prepararModulos grava o que falta, atualiza o nao editado e mantem o editado', () => {
    const raiz = pastaTemp();
    const pasta = path.join(raiz, 'modulos');
    gravar(path.join(pasta, 'mod-a.user.js'), 'A v1');
    gravar(path.join(pasta, 'mod-velho.user.js'), 'velho');
    const estado = { scripts: { 'mod-velho': true }, hashes: { 'mod-a': sha('A v1'), 'mod-velho': 'x' }, modulosRemovidos: ['mod-velho'], scriptsExtras: [] };
    sp.prepararModulos({ pasta, embutidos: EMBUTIDOS, retirados: ['mod-velho'], estado });
    assert.equal(ler(path.join(pasta, 'mod-a.user.js')), 'A v2');
    assert.equal(ler(path.join(pasta, 'mod-b.user.js')), 'B v1');
    assert.equal(fs.existsSync(path.join(pasta, 'mod-velho.user.js')), false);
    assert.equal(estado.scripts['mod-velho'], undefined);
    assert.equal(estado.hashes['mod-velho'], undefined);
    assert.deepEqual(estado.modulosRemovidos, []);
    assert.equal(estado.hashes['mod-a'], sha('A v2'));

    gravar(path.join(pasta, 'mod-a.user.js'), 'A editado');
    sp.prepararModulos({ pasta, embutidos: [{ ...EMBUTIDOS[0], fonte: 'A v3' }], retirados: [], estado });
    assert.equal(ler(path.join(pasta, 'mod-a.user.js')), 'A editado');
});

function montarLegado() {
    const base = pastaTemp();
    const scripts = path.join(base, 'scripts');
    gravar(path.join(scripts, 'modulos', 'mod-a.user.js'), 'A editado');
    gravar(path.join(scripts, 'meu.user.js'), 'meu script');
    gravar(path.join(scripts, 'apagado.user.js.removido'), 'apagado');
    gravar(path.join(scripts, 'requires', 'lib.js'), 'lib');
    const legado = { scriptsExtras: [{ id: 'meu', arquivo: 'meu.user.js' }], modulosRemovidos: ['mod-b'], hashes: { 'mod-a': 'h' } };
    const perfis = [{ id: 'p1', nome: 'Padrão' }, { id: 'p2', nome: 'Gilmario' }];
    return { base, scripts, legado, perfis };
}

test('migrarParaPerfis copia os scripts para cada perfil e guarda a pasta antiga', () => {
    const { base, scripts, legado, perfis } = montarLegado();
    const r = sp.migrarParaPerfis({ pastaScripts: scripts, perfis, legado });
    for (const p of perfis) {
        const pasta = sp.pastaDoPerfil(scripts, p.id);
        assert.equal(ler(path.join(pasta, 'modulos', 'mod-a.user.js')), 'A editado');
        assert.equal(ler(path.join(pasta, 'meu.user.js')), 'meu script');
        assert.equal(ler(path.join(pasta, 'apagado.user.js.removido')), 'apagado');
        assert.equal(fs.existsSync(path.join(pasta, 'requires')), false);
        assert.deepEqual(p.scriptsExtras, legado.scriptsExtras);
        assert.deepEqual(p.modulosRemovidos, ['mod-b']);
        assert.deepEqual(p.hashes, { 'mod-a': 'h' });
    }
    perfis[0].scriptsExtras.push({ id: 'outro', arquivo: 'o.user.js' });
    assert.equal(perfis[1].scriptsExtras.length, 1, 'cada perfil tem a propria lista');
    const backup = path.join(base, 'scripts-antes-1.1.0');
    assert.equal(ler(path.join(backup, 'meu.user.js')), 'meu script');
    assert.equal(ler(path.join(backup, 'modulos', 'mod-a.user.js')), 'A editado');
    assert.equal(fs.existsSync(path.join(scripts, 'meu.user.js')), false);
    assert.equal(fs.existsSync(path.join(scripts, 'modulos')), false);
    assert.equal(ler(path.join(scripts, 'requires', 'lib.js')), 'lib');
    assert.equal(r.perfis, 2);
});

test('migrarParaPerfis refeita depois de parar no meio nao perde arquivos', () => {
    const { base, scripts, legado, perfis } = montarLegado();
    const backup = path.join(base, 'scripts-antes-1.1.0');
    gravar(path.join(backup, 'meu.user.js'), 'meu script');
    fs.rmSync(path.join(scripts, 'meu.user.js'));
    sp.migrarParaPerfis({ pastaScripts: scripts, perfis, legado });
    for (const p of perfis) {
        const pasta = sp.pastaDoPerfil(scripts, p.id);
        assert.equal(ler(path.join(pasta, 'meu.user.js')), 'meu script');
        assert.equal(ler(path.join(pasta, 'modulos', 'mod-a.user.js')), 'A editado');
    }
    assert.equal(ler(path.join(backup, 'modulos', 'mod-a.user.js')), 'A editado');
});

test('migrarParaPerfis sem scripts antigos so cria as pastas', () => {
    const base = pastaTemp();
    const scripts = path.join(base, 'scripts');
    const perfis = [{ id: 'p1' }];
    sp.migrarParaPerfis({ pastaScripts: scripts, perfis, legado: sp.estadoVazio() });
    assert.equal(fs.existsSync(sp.pastaDoPerfil(scripts, 'p1')), true);
    assert.deepEqual(perfis[0].scriptsExtras, []);
});

test('copiarPastaDoPerfil copia arquivos e o novo perfil fica independente', () => {
    const base = pastaTemp();
    const scripts = path.join(base, 'scripts');
    gravar(path.join(sp.pastaDoPerfil(scripts, 'a'), 'meu.user.js'), 'original');
    sp.copiarPastaDoPerfil(scripts, 'a', 'b');
    gravar(path.join(sp.pastaDoPerfil(scripts, 'b'), 'meu.user.js'), 'mudou no b');
    assert.equal(ler(path.join(sp.pastaDoPerfil(scripts, 'a'), 'meu.user.js')), 'original');
});

test('moverParaExcluidos guarda a pasta do perfil sem apagar', () => {
    const base = pastaTemp();
    const scripts = path.join(base, 'scripts');
    gravar(path.join(sp.pastaDoPerfil(scripts, 'a'), 'meu.user.js'), 'x');
    const destino = sp.moverParaExcluidos(scripts, 'a', 'Meu: perfil', new Date(2026, 10, 16, 9, 5));
    assert.equal(fs.existsSync(sp.pastaDoPerfil(scripts, 'a')), false);
    assert.equal(ler(path.join(destino, 'meu.user.js')), 'x');
    assert.match(path.basename(destino), /^Meu- perfil-2026-11-16-0905/);
    assert.equal(sp.moverParaExcluidos(scripts, 'inexistente', 'x'), null);
});

test('idsDoPerfil lista modulos nao removidos e scripts adicionados', () => {
    const ids = sp.idsDoPerfil({ modulosRemovidos: ['mod-b'], scriptsExtras: [{ id: 'meu' }] }, EMBUTIDOS);
    assert.deepEqual(ids, ['mod-a', 'meu']);
});
