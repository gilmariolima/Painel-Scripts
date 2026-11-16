// Scripts por perfil do app: cada perfil tem a própria pasta de scripts e as próprias listas
// (scripts adicionados, módulos removidos e versões dos módulos do app).
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const sha = t => crypto.createHash('sha1').update(t).digest('hex');
const NOME_BACKUP = 'scripts-antes-1.1.0';
// Dentro da pasta de scripts, ficam fora da migração: as pastas dos perfis e o cache de @require.
const FICAM = new Set(['perfis', 'requires']);

const pastaDoPerfil = (pastaScripts, id) => path.join(pastaScripts, 'perfis', String(id));

const estadoVazio = () => ({ scriptsExtras: [], modulosRemovidos: [], hashes: {} });

function normalizar(estado) {
    if (!estado.scripts || typeof estado.scripts !== 'object') estado.scripts = {};
    if (!Array.isArray(estado.scriptsExtras)) estado.scriptsExtras = [];
    if (!Array.isArray(estado.modulosRemovidos)) estado.modulosRemovidos = [];
    if (!estado.hashes || typeof estado.hashes !== 'object') estado.hashes = {};
    return estado;
}

const clonar = v => JSON.parse(JSON.stringify(v));

// Grava os módulos do app na pasta do perfil. Troca pela versão nova só o arquivo que ainda é
// a versão anterior sem edição; apaga os módulos retirados do app.
function prepararModulos({ pasta, embutidos, retirados, estado }) {
    normalizar(estado);
    fs.mkdirSync(pasta, { recursive: true });
    for (const id of retirados) {
        try { fs.rmSync(path.join(pasta, id + '.user.js'), { force: true }); } catch {}
        delete estado.scripts[id];
        delete estado.hashes[id];
    }
    estado.modulosRemovidos = estado.modulosRemovidos.filter(id => !retirados.includes(id));
    for (const e of embutidos) {
        const arq = path.join(pasta, e.arquivo);
        const hNovo = sha(e.fonte);
        if (!fs.existsSync(arq)) {
            fs.writeFileSync(arq, e.fonte);
        } else {
            const hDisco = sha(fs.readFileSync(arq, 'utf8'));
            if (hDisco !== hNovo && hDisco === estado.hashes[e.id]) fs.writeFileSync(arq, e.fonte);
        }
        estado.hashes[e.id] = hNovo;
    }
}

// Copia uma pasta sem apagar o que já está no destino.
function copiarPorCima(origem, destino) {
    if (!fs.existsSync(origem)) return;
    fs.cpSync(origem, destino, { recursive: true, force: true });
}

// Move origem para destino; se o destino já existe (migração refeita), junta por cima.
function moverPorCima(origem, destino) {
    try {
        if (!fs.existsSync(destino)) { fs.renameSync(origem, destino); return; }
    } catch {}
    fs.cpSync(origem, destino, { recursive: true, force: true });
    fs.rmSync(origem, { recursive: true, force: true });
}

// Primeira abertura da 1.1.0: os scripts da pasta única vão para a pasta de cada perfil, com
// cópias das listas, e a pasta antiga fica guardada em scripts-antes-1.1.0. Pode ser refeita:
// se parou no meio, o que já foi guardado também é copiado para os perfis.
function migrarParaPerfis({ pastaScripts, perfis, legado }) {
    const backup = path.join(path.dirname(pastaScripts), NOME_BACKUP);
    fs.mkdirSync(pastaScripts, { recursive: true });
    const itens = fs.readdirSync(pastaScripts).filter(n => !FICAM.has(n));
    let arquivos = 0;
    for (const p of perfis) {
        const destino = pastaDoPerfil(pastaScripts, p.id);
        fs.mkdirSync(destino, { recursive: true });
        copiarPorCima(backup, destino);
        for (const n of itens) {
            copiarPorCima(path.join(pastaScripts, n), path.join(destino, n));
            arquivos++;
        }
        p.scriptsExtras = clonar(legado.scriptsExtras || []);
        p.modulosRemovidos = clonar(legado.modulosRemovidos || []);
        p.hashes = clonar(legado.hashes || {});
    }
    // Guarda tudo primeiro e só então tira da pasta antiga: se algo falhar antes, ela fica inteira.
    for (const n of itens) copiarPorCima(path.join(pastaScripts, n), path.join(backup, n));
    let sobraram = 0;
    for (const n of itens) {
        try { fs.rmSync(path.join(pastaScripts, n), { recursive: true, force: true }); } catch { sobraram++; }
    }
    return { perfis: perfis.length, itens: itens.length, arquivos, sobraram };
}

function copiarPastaDoPerfil(pastaScripts, deId, paraId) {
    const destino = pastaDoPerfil(pastaScripts, paraId);
    fs.mkdirSync(destino, { recursive: true });
    copiarPorCima(pastaDoPerfil(pastaScripts, deId), destino);
    return destino;
}

// Perfil excluído: a pasta vai para perfis\_excluidos\<nome>-<data>, nada é apagado de vez.
function moverParaExcluidos(pastaScripts, id, nome, agora = new Date()) {
    const origem = pastaDoPerfil(pastaScripts, id);
    if (!fs.existsSync(origem)) return null;
    const d2 = n => String(n).padStart(2, '0');
    const data = `${agora.getFullYear()}-${d2(agora.getMonth() + 1)}-${d2(agora.getDate())}-${d2(agora.getHours())}${d2(agora.getMinutes())}`;
    const limpo = String(nome || 'perfil').replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').trim() || 'perfil';
    const pai = path.join(pastaScripts, 'perfis', '_excluidos');
    fs.mkdirSync(pai, { recursive: true });
    let destino = path.join(pai, `${limpo}-${data}`);
    for (let i = 2; fs.existsSync(destino); i++) destino = path.join(pai, `${limpo}-${data}-${i}`);
    moverPorCima(origem, destino);
    return destino;
}

// Ids dos scripts de um perfil, sem ler arquivos: módulos do app não removidos + adicionados.
function idsDoPerfil(estado, embutidos) {
    const removidos = estado.modulosRemovidos || [];
    return [
        ...embutidos.filter(e => !removidos.includes(e.id)).map(e => e.id),
        ...(estado.scriptsExtras || []).map(x => x.id)
    ];
}

module.exports = {
    pastaDoPerfil, estadoVazio, normalizar, prepararModulos, migrarParaPerfis,
    copiarPastaDoPerfil, moverParaExcluidos, idsDoPerfil, NOME_BACKUP
};
