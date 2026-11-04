// Procura e baixa versões novas nas Releases do GitHub.
'use strict';

const crypto = require('crypto');
const { spawn } = require('child_process');

const URL_RELEASES = 'https://api.github.com/repos/gilmariolima/painel-scripts/releases/latest';
const NOME_EXE = 'PainelDeScripts.exe';
const CABECALHOS = { 'User-Agent': 'painel-de-scripts', Accept: 'application/vnd.github+json' };

function versaoEhNova(nova, atual) {
    const partes = v => String(v).replace(/^v/, '').split('.').map(Number);
    const a = partes(nova), b = partes(atual);
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const dif = (a[i] || 0) - (b[i] || 0);
        if (dif) return dif > 0;
    }
    return false;
}

// Devolve os dados da versão nova, ou null se já está na última.
async function procurarVersaoNova({ atual, url = URL_RELEASES, busca = fetch }) {
    let r;
    try {
        r = await busca(url, { headers: CABECALHOS, signal: AbortSignal.timeout(15000) });
    } catch {
        throw new Error('Sem conexão com o GitHub. Confira a internet e tente de novo.');
    }
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`GitHub respondeu ${r.status}. Tente de novo em alguns minutos.`);
    const release = await r.json();
    if (!versaoEhNova(release.tag_name, atual)) return null;
    const exe = (release.assets || []).find(a => a.name === NOME_EXE);
    if (!exe) throw new Error(`A versão ${release.tag_name} não tem o ${NOME_EXE}.`);
    return {
        versao: String(release.tag_name).replace(/^v/, ''),
        url: exe.browser_download_url,
        tamanho: exe.size,
        digest: exe.digest || ''
    };
}

async function baixarVersao(nova, busca = fetch) {
    const r = await busca(nova.url, { headers: { 'User-Agent': CABECALHOS['User-Agent'] }, signal: AbortSignal.timeout(15 * 60 * 1000) });
    if (!r.ok) throw new Error(`O download falhou (${r.status}).`);
    const conteudo = Buffer.from(await r.arrayBuffer());
    if (conteudo.length !== nova.tamanho) throw new Error('O download veio incompleto. Tente de novo.');
    if (nova.digest) {
        const hash = 'sha256:' + crypto.createHash('sha256').update(conteudo).digest('hex');
        if (hash !== nova.digest) throw new Error('O arquivo baixado não confere com o publicado.');
    }
    return conteudo;
}

// Abre um exe solto deste processo. O Windows pode recusar um exe recém-gravado
// enquanto o antivírus examina, por isso tenta algumas vezes.
async function abrirExe(arq, args, opcoes, { abrir = spawn, tentativas = 15, espera = 2000 } = {}) {
    let erro;
    for (let i = 0; i < tentativas; i++) {
        try {
            await new Promise((pronto, falhou) => {
                const filho = abrir(arq, args, { detached: true, stdio: 'ignore', ...opcoes });
                filho.once('error', falhou);
                filho.once('spawn', () => { filho.unref(); pronto(); });
            });
            return;
        } catch (e) {
            erro = e;
            if (i < tentativas - 1) await new Promise(r => setTimeout(r, espera));
        }
    }
    throw erro;
}

module.exports = { versaoEhNova, procurarVersaoNova, baixarVersao, abrirExe };
