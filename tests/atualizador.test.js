'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { versaoEhNova, procurarVersaoNova, baixarVersao, abrirExe } = require('../src/atualizador');

const resposta = (corpo, status = 200) => async () => new Response(corpo, { status });
const release = (extra = {}) => JSON.stringify({
    tag_name: 'v6.5.8',
    assets: [
        { name: 'outro.zip', browser_download_url: 'https://x/outro.zip', size: 1 },
        { name: 'PainelDeScripts.exe', browser_download_url: 'https://x/p.exe', size: 3, digest: 'sha256:abc' }
    ],
    ...extra
});

test('versaoEhNova compara numero a numero, nao como texto', () => {
    assert.equal(versaoEhNova('v6.5.10', '6.5.9'), true);
    assert.equal(versaoEhNova('6.5.7', '6.5.7'), false);
    assert.equal(versaoEhNova('6.5.6', '6.5.7'), false);
    assert.equal(versaoEhNova('7.0', '6.9.9'), true);
    assert.equal(versaoEhNova('sem-numero', '6.5.7'), false);
});

test('procura devolve a versao nova com o exe certo', async () => {
    const nova = await procurarVersaoNova({ atual: '6.5.7', busca: resposta(release()) });
    assert.deepEqual(nova, { versao: '6.5.8', url: 'https://x/p.exe', tamanho: 3, digest: 'sha256:abc' });
});

test('procura devolve null quando ja esta na ultima', async () => {
    assert.equal(await procurarVersaoNova({ atual: '6.5.8', busca: resposta(release()) }), null);
});

test('procura devolve null quando ainda nao ha release', async () => {
    assert.equal(await procurarVersaoNova({ atual: '6.5.7', busca: resposta('{}', 404) }), null);
});

test('procura falha se a release nao tem o exe', async () => {
    await assert.rejects(
        procurarVersaoNova({ atual: '6.5.7', busca: resposta(release({ assets: [] })) }),
        /não tem o PainelDeScripts\.exe/);
});

test('procura explica falta de conexao e erro do GitHub', async () => {
    const semRede = async () => { throw new Error('fetch failed'); };
    await assert.rejects(procurarVersaoNova({ atual: '1.0.0', busca: semRede }), /Sem conexão/);
    await assert.rejects(procurarVersaoNova({ atual: '1.0.0', busca: resposta('{}', 403) }), /GitHub respondeu 403/);
});

test('baixar devolve o arquivo quando tamanho e hash batem', async () => {
    const dados = Buffer.from('abc');
    const digest = 'sha256:' + crypto.createHash('sha256').update(dados).digest('hex');
    const r = await baixarVersao({ url: 'u', tamanho: 3, digest }, resposta(dados));
    assert.ok(r.equals(dados));
});

test('baixar aceita release sem digest', async () => {
    const r = await baixarVersao({ url: 'u', tamanho: 3, digest: '' }, resposta(Buffer.from('abc')));
    assert.equal(r.length, 3);
});

test('baixar recusa arquivo incompleto ou alterado', async () => {
    await assert.rejects(baixarVersao({ url: 'u', tamanho: 9, digest: '' }, resposta(Buffer.from('abc'))), /incompleto/);
    await assert.rejects(baixarVersao({ url: 'u', tamanho: 3, digest: 'sha256:00' }, resposta(Buffer.from('abc'))), /não confere/);
    await assert.rejects(baixarVersao({ url: 'u', tamanho: 3, digest: '' }, resposta('', 500)), /download falhou/i);
});

function abrirFalso(resultados) {
    const chamadas = [];
    const abrir = (arq, args, opcoes) => {
        chamadas.push({ arq, args, opcoes });
        const r = resultados[chamadas.length - 1];
        if (r === 'lanca') { const e = new Error('spawn UNKNOWN'); e.code = 'UNKNOWN'; throw e; }
        const filho = new EventEmitter();
        filho.unref = () => { filho.soltou = true; };
        process.nextTick(() => {
            if (r === 'erro') { const e = new Error('spawn EACCES'); e.code = 'EACCES'; filho.emit('error', e); }
            else filho.emit('spawn');
        });
        return filho;
    };
    return { abrir, chamadas };
}

test('abrirExe tenta de novo quando o Windows recusa o exe recem-gravado', async () => {
    const f = abrirFalso(['lanca', 'erro', 'ok']);
    await abrirExe('a.exe', ['--x'], { cwd: 'c' }, { abrir: f.abrir, espera: 0 });
    assert.equal(f.chamadas.length, 3);
    assert.deepEqual(f.chamadas[2].args, ['--x']);
    assert.equal(f.chamadas[2].opcoes.detached, true);
    assert.equal(f.chamadas[2].opcoes.cwd, 'c');
});

test('abrirExe desiste depois das tentativas e devolve o erro em vez de derrubar o app', async () => {
    const f = abrirFalso(['erro', 'erro', 'erro']);
    await assert.rejects(abrirExe('a.exe', [], {}, { abrir: f.abrir, espera: 0, tentativas: 3 }), /EACCES/);
    assert.equal(f.chamadas.length, 3);
});
