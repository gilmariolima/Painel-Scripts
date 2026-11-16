// Painel de Scripts — núcleo do app (roda no processo principal do Electron).
// Abre o Edge com a porta de controle ligada, nos perfis já existentes
// (Perfil 1–6 para a SmartBus, Perfil 1 para a Tallos, até escanear), e injeta o
// Painel de Scripts nas abas da SmartBus e da Tallos.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const puppeteer = require('puppeteer-core');

const PONTE = require('./ponte.txt');
const RUNTIME = require('./runtime.txt');
// Módulos que vêm com o app: um script por módulo (gerados por gerar-modulos.js)
const EMBUTIDOS = require('./embutidos/modulos/index.js');
// sha1 do Painel unificado que a 6.x instalava: se o arquivo dela for diferente, foi editado.
const SHA_PAINEL_ANTIGO = '20ad556220a8c97655ab812747d2d6548a0e800f';

const { version: VERSAO } = require('../package.json');

// Scripts: o Painel de Scripts (que vem com o app) + os que você adiciona pelo hub.
// A lista é montada em carregarListaScripts(), lendo o cabeçalho ==UserScript== de cada arquivo.
// Os módulos que vêm com o app compartilham o mesmo "armazém" de dados (como era no painel unificado).
const ARMAZEM_MODULOS = 'painel';
const embutidoPorId = id => EMBUTIDOS.find(e => e.id === id);
let SCRIPTS = {};

const SITES = Object.assign({
    tallos: 'https://app.tallos.com.br/',
    smartbus: 'https://prod-guanabara-frontoffice-smartbus.smarttravelit.com/'
}, process.env.PAINEL_SITES ? JSON.parse(process.env.PAINEL_SITES) : {});

// Perfis do Edge usados por cada sistema (pelo nome que aparece no Edge)
const PERFIS_SMARTBUS_PADRAO = ['Perfil 1', 'Perfil 2', 'Perfil 3', 'Perfil 4', 'Perfil 5', 'Perfil 6'];
const PERFIL_TALLOS = 'Perfil 1';

const K = { painelEstado: 'tmm_painel_scripts_state_v1' };

const LOCALAPPDATA = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
const BASE = path.join(LOCALAPPDATA, 'PainelDeScripts');
const PASTA_SCRIPTS = path.join(BASE, 'scripts');
const ARQ_DADOS = path.join(BASE, 'dados.json');
const ARQ_CONFIG = path.join(BASE, 'config.json');

const ARQ_LOG = path.join(BASE, 'painel.log');
const doisDig = n => String(n).padStart(2, '0');
// O registro vai para o arquivo painel.log (e para o console, se houver um).
const log = (...a) => {
    const d = new Date();
    const linha = `${doisDig(d.getDate())}/${doisDig(d.getMonth() + 1)} ${doisDig(d.getHours())}:${doisDig(d.getMinutes())}:${doisDig(d.getSeconds())} - ` +
        a.map(x => (typeof x === 'string' ? x : (x?.message || JSON.stringify(x)))).join(' ');
    try {
        fs.mkdirSync(BASE, { recursive: true });
        try { if (fs.statSync(ARQ_LOG).size > 1048576) fs.renameSync(ARQ_LOG, ARQ_LOG + '.antigo'); } catch {}
        fs.appendFileSync(ARQ_LOG, linha + '\r\n');
    } catch {}
    try { if (process.stdout?.isTTY) console.log(linha); } catch {}
};
const sha = t => crypto.createHash('sha1').update(t).digest('hex');
const sleep = ms => new Promise(r => setTimeout(r, ms));
// Nunca deixa travado: se a promessa não resolver em `ms`, devolve `padrao` (a promessa original
// segue correndo sozinha, mas não bloqueia mais nada).
function comTimeout(promessa, ms, padrao) {
    return new Promise(resolve => {
        const t = setTimeout(() => resolve(padrao), ms);
        promessa.then(v => { clearTimeout(t); resolve(v); }, () => { clearTimeout(t); resolve(padrao); });
    });
}

function lerJSON(arq, padrao) {
    try { return JSON.parse(fs.readFileSync(arq, 'utf8')); } catch { return padrao; }
}
function gravarJSON(arq, dados) {
    fs.writeFileSync(arq + '.tmp', JSON.stringify(dados));
    fs.renameSync(arq + '.tmp', arq);
}

// ---------- Configuração e script em disco ----------
fs.mkdirSync(PASTA_SCRIPTS, { recursive: true });
const config = Object.assign({ scripts: {}, hashes: {} }, lerJSON(ARQ_CONFIG, {}));
config.scripts = config.scripts || {};
config.hashes = config.hashes || {};
config.scriptsExtras = Array.isArray(config.scriptsExtras) ? config.scriptsExtras : [];
config.modulosRemovidos = Array.isArray(config.modulosRemovidos) ? config.modulosRemovidos : [];
const salvarConfig = () => {
    try {
        gravarJSON(ARQ_CONFIG, config);
        copiarCamposDoPerfil(config, perfilAtivo());
        gravarJSON(ARQ_PERFIS, perfisApp);
    } catch (e) { log('Falha ao salvar config:', e.message); }
};

// ---------- Perfis do app (troca de login) ----------
// Cada perfil guarda estes campos da configuração. O perfil ativo fica carregado em "config"
// e o resto do app continua lendo só de lá. O código dos scripts é o mesmo para todos os perfis.
const ARQ_PERFIS = path.join(BASE, 'perfis.json');
const CAMPOS_DO_PERFIL = ['scripts', 'navegador', 'abrirAoIniciar', 'perfisSmartbus', 'perfisTallos', 'perfisSmartbus_chrome', 'perfisTallos_chrome'];
const CORES_PERFIL = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899'];

function copiarCamposDoPerfil(de, para) {
    for (const c of CAMPOS_DO_PERFIL) {
        if (de[c] === undefined) delete para[c];
        else para[c] = JSON.parse(JSON.stringify(de[c]));
    }
}

function montarPerfilApp(nome, cor, origem) {
    const perfil = { id: crypto.randomUUID(), nome, cor, criadoEm: Date.now() };
    copiarCamposDoPerfil(origem, perfil);
    return perfil;
}

// Na primeira vez, o que já estava configurado vira o perfil "Padrão".
function carregarPerfisApp() {
    const existe = fs.existsSync(ARQ_PERFIS);
    const dados = lerJSON(ARQ_PERFIS, null);
    if (Array.isArray(dados?.perfis) && dados.perfis.length) return dados;
    if (existe) {
        log('O arquivo de perfis estava danificado: guardado como perfis.json.danificado.');
        try { fs.renameSync(ARQ_PERFIS, ARQ_PERFIS + '.danificado'); } catch {}
    }
    const padrao = montarPerfilApp('Padrão', CORES_PERFIL[0], config);
    return { ativo: padrao.id, perfis: [padrao] };
}

const perfisApp = carregarPerfisApp();
const perfilAtivo = () => perfisApp.perfis.find(p => p.id === perfisApp.ativo);
if (!perfilAtivo()) perfisApp.ativo = perfisApp.perfis[0].id;
copiarCamposDoPerfil(perfilAtivo(), config);
config.scripts = config.scripts || {};

const PASTA_MODULOS = path.join(PASTA_SCRIPTS, 'modulos');

// Grava os módulos que vêm com o app na pasta. Se o arquivo em disco é uma versão
// antiga sem edição, troca pela nova; se você editou, mantém a sua versão.
// Módulos que já vieram no app e foram tirados: apaga o arquivo e o liga/desliga deles.
const MODULOS_RETIRADOS = ['mod-leitor_documento', 'mod-idade_nascimento', 'mod-arrasto_promo',
    'mod-alarme_flutuante', 'mod-colar_trecho_auto', 'mod-guanabara_print_horarios', 'mod-horario-servico',
    'mod-preencher-email', 'mod-preencher_passageiros', 'mod-remover_acentos_nomes', 'mod-reserva_automatica',
    'mod-smartbus_copiar_clique', 'mod-tallos_30min', 'mod-tallos_botoes_mensagens',
    'mod-tallos_ocultar_botoes_barra', 'mod-chatpro_copiar_2'];

function prepararArquivosScripts() {
    fs.mkdirSync(PASTA_MODULOS, { recursive: true });
    for (const id of MODULOS_RETIRADOS) {
        try { fs.rmSync(path.join(PASTA_MODULOS, id + '.user.js'), { force: true }); } catch {}
        delete config.scripts[id];
        delete config.hashes[id];
    }
    config.modulosRemovidos = config.modulosRemovidos.filter(id => !MODULOS_RETIRADOS.includes(id));
    for (const e of EMBUTIDOS) {
        const arq = path.join(PASTA_MODULOS, e.arquivo);
        const hNovo = sha(e.fonte);
        if (!fs.existsSync(arq)) {
            fs.writeFileSync(arq, e.fonte);
        } else {
            const hDisco = sha(fs.readFileSync(arq, 'utf8'));
            if (hDisco !== hNovo && hDisco === config.hashes[e.id]) fs.writeFileSync(arq, e.fonte);
        }
        config.hashes[e.id] = hNovo;
    }
    migrarPainelUnificado();
    salvarConfig();
}

// Versões anteriores tinham tudo num script só ("painel"). Passa o liga/desliga de cada
// módulo para o novo script dele. Se o script unificado tinha sido editado, ele fica
// guardado como um script extra, desligado.
function migrarPainelUnificado() {
    if (config.modulosSeparados) return;
    let mapa = {};
    try { mapa = JSON.parse(store.painel?.tmm_painel_scripts_state_v1 || '{}') || {}; } catch {}
    const painelLigado = config.scripts.painel !== false;
    for (const e of EMBUTIDOS) {
        if (config.scripts[e.id] !== undefined) continue;
        config.scripts[e.id] = painelLigado && (mapa[e.modulo] !== undefined ? Boolean(mapa[e.modulo]) : e.defaultOn);
    }
    const antigo = path.join(PASTA_SCRIPTS, 'painel-de-scripts.user.js');
    try {
        const texto = fs.readFileSync(antigo, 'utf8');
        if (sha(texto) !== SHA_PAINEL_ANTIGO && sha(texto) !== config.hashes.painel) {
            const arquivo = 'painel-unificado-editado.user.js';
            fs.writeFileSync(path.join(PASTA_SCRIPTS, arquivo), texto);
            config.scriptsExtras.push({ id: 'painel-unificado-editado', arquivo });
            config.scripts['painel-unificado-editado'] = false;
            log('O Painel unificado tinha edições: guardado como "painel-unificado-editado", desligado.');
        }
        fs.renameSync(antigo, antigo + '.antigo');
    } catch {}
    delete config.scripts.painel;
    delete config.hashes.painel;
    config.modulosSeparados = true;
    log('Módulos separados: cada módulo agora é um script próprio.');
}

// ---------- Cabeçalho ==UserScript== ----------
function lerCabecalho(fonte) {
    const bloco = String(fonte).match(/\/\/\s*==UserScript==([\s\S]*?)\/\/\s*==\/UserScript==/);
    const meta = { name: '', version: '', description: '', grupo: '', match: [], include: [], exclude: [], connect: [], require: [], runAt: 'document-idle' };
    if (!bloco) return { meta, temCabecalho: false };
    for (const linha of bloco[1].split(/\r?\n/)) {
        const m = linha.match(/^\s*\/\/\s*@([\w:-]+)\s*(.*?)\s*$/);
        if (!m) continue;
        const [, chave, valor] = m;
        if (chave === 'name') meta.name = meta.name || valor;
        else if (chave === 'version') meta.version = valor;
        else if (chave === 'description') meta.description = meta.description || valor;
        else if (chave === 'match') meta.match.push(valor);
        else if (chave === 'include') meta.include.push(valor);
        else if (chave === 'exclude' || chave === 'exclude-match') meta.exclude.push(valor);
        else if (chave === 'connect') meta.connect.push(valor);
        else if (chave === 'require') meta.require.push(valor);
        else if (chave === 'run-at') meta.runAt = valor;
        else if (chave === 'grupo') meta.grupo = valor;
    }
    return { meta, temCabecalho: true };
}

// Troca o valor de um campo (@name, @description) no cabeçalho ==UserScript==, mantendo
// o resto do arquivo igual. Se o campo não existe ainda, insere logo depois do @name.
function alterarCabecalho(fonte, campo, novoValor) {
    const linhaCampo = new RegExp(`^([ \\t]*//[ \\t]*@${campo}[ \\t]+).*$`, 'm');
    if (linhaCampo.test(fonte)) {
        return fonte.replace(linhaCampo, (_, prefixo) => prefixo + novoValor);
    }
    if (!novoValor) return fonte;
    const linhaName = /^([ \t]*\/\/[ \t]*@name[ \t]+.*)$/m;
    if (!linhaName.test(fonte)) return fonte;
    return fonte.replace(linhaName, linha => `${linha}\n// @${campo}  ${novoValor}`);
}

const escRe = t => t.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&');

// @match do Tampermonkey (ex.: *://*.tallos.com.br/*) -> expressão regular sobre o endereço todo
function matchParaRegex(p) {
    p = String(p).trim();
    if (p === '<all_urls>' || p === '*') return '^(https?|file)://';
    const m = p.match(/^(\*|https?|file|ftp):\/\/([^/]*)(\/.*)?$/);
    if (!m) return null;
    const esquema = m[1] === '*' ? 'https?' : escRe(m[1]);
    let host = m[2];
    if (host === '*') host = '[^/]*';
    else if (host.startsWith('*.')) host = '(?:[^/]*\\.)?' + escRe(host.slice(2));
    else host = escRe(host).replace(/\\\*/g, '[^/]*');
    const caminho = escRe(m[3] || '/').replace(/\\\*/g, '.*');
    return `^${esquema}://${host}(?::\\d+)?${caminho}$`;
}

// @include: aceita /regex/ ou um padrão com *
function includeParaRegex(p) {
    p = String(p).trim();
    const re = p.match(/^\/(.*)\/([a-z]*)$/);
    if (re) return re[1];
    if (p === '*') return '.*';
    return '^' + escRe(p).replace(/\\\*/g, '.*') + '$';
}

function regrasDoScript(meta) {
    return {
        inclui: [...meta.match.map(matchParaRegex), ...meta.include.map(includeParaRegex)].filter(Boolean),
        exclui: meta.exclude.map(x => matchParaRegex(x) || includeParaRegex(x)).filter(Boolean)
    };
}

function casaUrl(url, regras) {
    try {
        if (!regras.inclui.some(r => new RegExp(r).test(url))) return false;
        return !regras.exclui.some(r => new RegExp(r).test(url));
    } catch { return false; }
}

// Mostra os sites de forma curta: "*://*.tallos.com.br/*" -> "tallos.com.br"
function sitesCurtos(meta) {
    const lista = [...meta.match, ...meta.include].map(p => {
        if (p === '<all_urls>' || p === '*') return 'todos os sites';
        const m = String(p).match(/^[^:]*:\/\/([^/]*)/);
        return m ? m[1].replace(/^\*\./, '').replace(/^\*$/, 'todos os sites') : p;
    });
    return [...new Set(lista)];
}

// ---------- @require: bibliotecas externas ficam guardadas na pasta ----------
const PASTA_REQUIRES = path.join(PASTA_SCRIPTS, 'requires');
const arqRequire = url => path.join(PASTA_REQUIRES, sha(url) + '.js');

async function baixarRequires(meta) {
    const falhas = [];
    fs.mkdirSync(PASTA_REQUIRES, { recursive: true });
    for (const url of meta.require) {
        if (fs.existsSync(arqRequire(url))) continue;
        try {
            const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
            if (!r.ok) throw new Error('HTTP ' + r.status);
            fs.writeFileSync(arqRequire(url), await r.text());
            log(`Biblioteca baixada: ${url}`);
        } catch (e) {
            falhas.push(url);
            log(`Não baixei a biblioteca ${url}:`, e.message);
        }
    }
    return falhas;
}

function lerRequires(meta) {
    return meta.require.map(url => {
        try { return `\n;/* @require ${url} */\n` + fs.readFileSync(arqRequire(url), 'utf8') + '\n;'; }
        catch { log(`Biblioteca não encontrada (será baixada ao salvar o script): ${url}`); return ''; }
    }).join('');
}

// ---------- Lista de scripts ----------
function grupoDoScript(meta) {
    const g = (String(meta.grupo || '').trim());
    if (g) return g;
    const sites = [...meta.match, ...meta.include].join(' ');
    const sb = /smarttravelit/.test(sites), tl = /tallos/.test(sites);
    return sb && !tl ? 'SmartBus' : tl && !sb ? 'Tallos' : 'Outros';
}

function carregarListaScripts() {
    const lista = [
        ...EMBUTIDOS.filter(e => !config.modulosRemovidos.includes(e.id))
            .map(e => ({ id: e.id, arquivo: path.join('modulos', e.arquivo), embutido: true, defaultOn: e.defaultOn })),
        ...config.scriptsExtras
    ];
    const novos = {};
    for (const item of lista) {
        let fonte = '';
        try { fonte = fs.readFileSync(path.join(PASTA_SCRIPTS, item.arquivo), 'utf8'); }
        catch (e) { log(`Não li ${item.arquivo}:`, e.message); continue; }
        const { meta } = lerCabecalho(fonte);
        novos[item.id] = {
            id: item.id,
            arquivo: item.arquivo,
            embutido: Boolean(item.embutido),
            armazem: item.embutido ? ARMAZEM_MODULOS : item.id,
            nome: meta.name || item.arquivo,
            grupo: grupoDoScript(meta),
            meta,
            regras: regrasDoScript(meta),
            fonte,
            editado: Boolean(item.embutido) && sha(fonte) !== sha(embutidoPorId(item.id)?.fonte || '')
        };
        if (config.scripts[item.id] === undefined) config.scripts[item.id] = item.embutido ? item.defaultOn !== false : true;
    }
    SCRIPTS = novos;
}

let CODIGO = '';

function montarCodigo() {
    carregarListaScripts();
    const partes = [];
    for (const s of Object.values(SCRIPTS)) {
        if (!s.regras.inclui.length) { log(`O script "${s.nome}" não tem @match: ele não vai rodar em nenhum site.`); continue; }
        const cfg = {
            id: s.id, armazem: s.armazem, nome: s.nome, versao: s.meta.version || '',
            regras: s.regras, runAt: s.meta.runAt || 'document-idle',
            temModulo: /\bregistrarModulo\s*\(/.test(s.fonte)
        };
        partes.push(PONTE
            .replace('__CONFIG__', () => JSON.stringify(cfg))
            .replace('/*__USERSCRIPT__*/', () => lerRequires(s.meta) + '\n' + s.fonte));
    }
    // O runtime (funções GM_*, ligar/desligar, etc.) vai uma vez só; cada script é só um pedacinho.
    CODIGO = RUNTIME + '\n;\n' + partes.join('\n;\n');
    if (process.env.PAINEL_DEBUG) log(`Código injetado: ${Math.round(CODIGO.length / 1024)} KB, ${partes.length} scripts`);
}

// Confere se o código é JavaScript válido (sem rodar).
function conferirSintaxe(fonte) {
    try {
        new (require('vm').Script)('(function(){\n' + fonte + '\n})', { filename: 'script.user.js' });
        return null;
    } catch (e) {
        const linha = (String(e.stack || '').match(/script\.user\.js:(\d+)/) || [])[1];
        return `${e.message}${linha ? ` (linha ${Number(linha) - 1})` : ''}`;
    }
}

function validarScript(fonte) {
    const { meta, temCabecalho } = lerCabecalho(fonte);
    if (!temCabecalho) return { erro: 'Falta o cabeçalho // ==UserScript== ... // ==/UserScript== no começo do script.' };
    if (!meta.name) return { erro: 'Falta o nome do script (// @name ...) no cabeçalho.' };
    if (!meta.match.length && !meta.include.length) return { erro: 'Falta dizer em quais sites o script roda (// @match ...) no cabeçalho.' };
    const sintaxe = conferirSintaxe(fonte);
    if (sintaxe) return { erro: `O código tem um erro: ${sintaxe}` };
    return { meta };
}


// ---------- Valores guardados ----------
const store = Object.assign({ painel: {} }, lerJSON(ARQ_DADOS, {}));
let timerSalvar = null;
function salvarAgora() {
    clearTimeout(timerSalvar);
    timerSalvar = null;
    try { gravarJSON(ARQ_DADOS, store); } catch (e) { log('Falha ao salvar dados:', e.message); }
}
function agendarSalvar() {
    clearTimeout(timerSalvar);
    timerSalvar = setTimeout(salvarAgora, 1500);
}

// ---------- Navegador (Edge ou Chrome): executável, perfis e porta de controle ----------
const NAVEGADORES = {
    edge: {
        id: 'edge', nome: 'Edge', imagem: 'msedge.exe', porta: Number(process.env.PAINEL_PORTA_EDGE || 9333),
        dados: process.env.PAINEL_EDGE_DADOS || path.join(LOCALAPPDATA, 'Microsoft', 'Edge', 'User Data'),
        copia: process.env.PAINEL_EDGE_COPIA || path.join(BASE, 'edge-perfis'),
        exes: () => [
            process.env.PAINEL_EDGE || '',
            path.join(process.env['ProgramFiles(x86)'] || '', 'Microsoft/Edge/Application/msedge.exe'),
            path.join(process.env['ProgramFiles'] || '', 'Microsoft/Edge/Application/msedge.exe'),
            path.join(LOCALAPPDATA, 'Microsoft/Edge/Application/msedge.exe')
        ]
    },
    chrome: {
        id: 'chrome', nome: 'Chrome', imagem: 'chrome.exe', porta: Number(process.env.PAINEL_PORTA_CHROME || 9334),
        dados: process.env.PAINEL_CHROME_DADOS || path.join(LOCALAPPDATA, 'Google', 'Chrome', 'User Data'),
        copia: process.env.PAINEL_CHROME_COPIA || path.join(BASE, 'chrome-perfis'),
        exes: () => [
            process.env.PAINEL_CHROME || '',
            path.join(process.env['ProgramFiles'] || '', 'Google/Chrome/Application/chrome.exe'),
            path.join(process.env['ProgramFiles(x86)'] || '', 'Google/Chrome/Application/chrome.exe'),
            path.join(LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe')
        ]
    }
};
const nav = () => NAVEGADORES[config.navegador === 'chrome' ? 'chrome' : 'edge'];
const acharNavegador = (n = nav()) => n.exes().find(p => p && fs.existsSync(p)) || null;

// O Painel usa uma CÓPIA dos perfis do navegador numa pasta própria: no perfil
// normal o navegador ignora a porta de controle, mas numa pasta separada ele aceita.
// Perfis da SmartBus: a lista fica salva na configuração (dá para adicionar pelo hub)
// Listas de perfis de cada sistema (dá para escanear, adicionar e tirar pelo hub)
const LISTAS = { smartbus: 'perfisSmartbus', tallos: 'perfisTallos' };
// Cada navegador tem as suas listas (no Chrome os perfis têm outros nomes)
const chaveLista = site => LISTAS[site] + (nav().id === 'chrome' ? '_chrome' : '');
const PADRAO = { smartbus: PERFIS_SMARTBUS_PADRAO, tallos: [PERFIL_TALLOS] };
const perfisDe = site => {
    const lista = config[chaveLista(site)];
    if (Array.isArray(lista)) return lista;
    return nav().id === 'chrome' ? [] : PADRAO[site];
};
const definirPerfis = (site, lista) => { config[chaveLista(site)] = lista; salvarConfig(); };
const perfisSmartbus = () => perfisDe('smartbus');
const nomesPerfis = () => [...new Set([...perfisDe('tallos'), ...perfisDe('smartbus')])];
// Perfil onde o hub abre: o primeiro da Tallos, senão o primeiro da SmartBus
const perfilDoHub = () => [...perfisDe('tallos'), ...perfisDe('smartbus')].find(n => perfilPorNome(n)) || null;
// "gilmario7" e "Gilmario 7" contam como o mesmo nome
const chaveNome = n => String(n || '').toLowerCase().replace(/\s+/g, '');
// Pastas que não precisam ser copiadas (cache, que o Edge recria sozinho)
const NAO_COPIAR = new Set(['cache', 'code cache', 'gpucache', 'dawncache', 'dawngraphitecache', 'dawnwebgpucache',
    'grshadercache', 'graphitedawncache', 'shadercache', 'cachestorage', 'scriptcache', 'crashpad',
    'component_crx_cache', 'extensions_crx_cache', 'optimizationhints', 'safe browsing', 'blob_storage']);

const copiaPronta = () => fs.existsSync(path.join(nav().copia, 'Local State'));

// Lista os perfis de uma pasta de dados do Edge. Lê o "Local State" e também o
// arquivo Preferences de cada pasta de perfil, porque um perfil criado agora
// pode ainda não ter sido gravado no Local State (o Edge só grava depois).
// Nome que o navegador mostra para o perfil. Perfis logados numa conta (Microsoft/Google)
// que ficaram com o nome padrão ("Perfil 1", "Pessoa 1") aparecem com o nome da conta.
const NOME_PADRAO = /^(perfil|pessoa|person|profile|usu[aá]rio|user)\s*\d*$/i;
function montarPerfil(dir, nomeSalvo, padrao, conta) {
    const nome = String(nomeSalvo || '').trim();
    const daConta = String(conta.nome || conta.email || '').trim();
    const usaConta = daConta && (padrao || !nome || NOME_PADRAO.test(nome));
    const exibido = usaConta ? daConta : (nome || dir);
    const apelidos = [...new Set([exibido, nome, conta.nome, conta.email].filter(Boolean))];
    return { dir, nome: exibido, email: conta.email || '', logado: Boolean(conta.email || conta.nome), apelidos };
}

function lerPerfisDeSemCache(dirDados) {
    const lista = new Map();
    const estado = lerJSON(path.join(dirDados, 'Local State'), {});
    for (const [dir, info] of Object.entries(estado?.profile?.info_cache || {})) {
        lista.set(dir, montarPerfil(dir, info?.name, info?.is_using_default_name, {
            nome: info?.gaia_name || info?.gaia_given_name || info?.edge_account_name || '',
            email: info?.user_name || info?.edge_account_email || ''
        }));
    }
    // Perfis que ainda não estão no "Local State" (criados há pouco): lê o Preferences da pasta.
    let pastas = [];
    try { pastas = fs.readdirSync(dirDados, { withFileTypes: true }); } catch {}
    for (const it of pastas) {
        if (!it.isDirectory() || !/^(Default|Profile \d+)$/i.test(it.name) || lista.has(it.name)) continue;
        const prefs = lerJSON(path.join(dirDados, it.name, 'Preferences'), null);
        if (!prefs?.profile) continue;
        const conta = (Array.isArray(prefs.account_info) && prefs.account_info[0]) || {};
        lista.set(it.name, montarPerfil(it.name, prefs.profile.name, prefs.profile.using_default_name,
            { nome: conta.full_name || conta.given_name || '', email: conta.email || '' }));
    }
    return [...lista.values()].filter(p => p.nome);
}
function lerPerfis() {
    return lerPerfisDe(copiaPronta() ? nav().copia : nav().dados);
}
// Procura perfis numa pasta do Edge: pelo "Local State" e também lendo o
// Preferences de cada pasta de perfil (pega perfis criados há pouco).
function escanearPastaSemCache(dirDados, origem) {
    return lerPerfisDe(dirDados).map(p => ({ ...p, origem }));
}

// Todos os perfis: os do Edge normal e os criados direto no Edge do Painel.
// Os perfis mudam pouco: guarda a leitura das pastas por alguns segundos
// (o hub atualiza com frequência e cada leitura abre vários arquivos).
const cachePerfis = new Map();
function comCache(chave, fn) {
    const c = cachePerfis.get(chave);
    if (c && Date.now() - c.em < 4000) return c.valor;
    const valor = fn();
    cachePerfis.set(chave, { em: Date.now(), valor });
    return valor;
}
const limparCachePerfis = () => cachePerfis.clear();
const lerPerfisDe = dir => comCache('ler|' + dir, () => lerPerfisDeSemCache(dir));
const escanearPasta = (dir, origem) => comCache(`esc|${origem}|${dir}`, () => escanearPastaSemCache(dir, origem));

// O nome procurado bate com o perfil pelo nome mostrado, pelo nome salvo ou pelo e-mail da conta.
const bate = (p, nome) => (p.apelidos || [p.nome]).some(a => chaveNome(a) === chaveNome(nome));

function todosPerfis() {
    const porNome = new Map();
    for (const p of escanearPasta(nav().dados, 'edge')) porNome.set(chaveNome(p.nome), p);
    if (copiaPronta()) {
        for (const p of escanearPasta(nav().copia, 'painel')) {
            if (![...porNome.values()].some(x => x.dir === p.dir || bate(x, p.nome))) porNome.set(chaveNome(p.nome), p);
        }
    }
    return [...porNome.values()].sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR', { numeric: true }));
}

function perfilPorNome(nome) {
    const alvo = chaveNome(nome);
    // Dentro do Edge do Painel vale a pasta que está na cópia.
    if (copiaPronta()) {
        const naCopia = escanearPasta(nav().copia, 'painel').find(p => bate(p, nome));
        if (naCopia) return naCopia;
    }
    return todosPerfis().find(p => bate(p, nome)) || null;
}
function perfilDisponivel(nome) {
    const p = perfilPorNome(nome);
    if (!p) return false;
    return !copiaPronta() || p.origem === 'painel' || fs.existsSync(path.join(nav().copia, p.dir));
}

function edgeRodando() {
    if (process.platform !== 'win32') return Promise.resolve(false);
    return new Promise(resolve => {
        execFile('tasklist', ['/FI', `IMAGENAME eq ${nav().imagem}`, '/NH'], { windowsHide: true }, (err, out) => {
            resolve(!err && String(out).toLowerCase().includes(nav().imagem));
        });
    });
}

function wsDoEdge() {
    return new Promise(resolve => {
        const req = http.get(`http://127.0.0.1:${nav().porta}/json/version`, { timeout: 1200 }, res => {
            let b = '';
            res.on('data', c => { b += c; });
            res.on('end', () => { try { resolve(JSON.parse(b).webSocketDebuggerUrl || null); } catch { resolve(null); } });
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
    });
}

function executarEdge(args, { doPainel = true } = {}) {
    const exe = acharNavegador();
    if (!exe) throw new Error(`${nav().nome} não encontrado neste computador.`);
    const extras = process.env.PAINEL_EDGE_ARGS ? JSON.parse(process.env.PAINEL_EDGE_ARGS) : [];
    const base = doPainel
        ? [`--user-data-dir=${nav().copia}`, `--remote-debugging-port=${nav().porta}`, '--no-first-run', '--no-default-browser-check']
        : [];
    spawn(exe, [...base, ...extras, ...args], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
}

function argsPerfil(perfil) {
    return perfil ? [`--profile-directory=${perfil.dir}`] : [];
}

let browser = null;
let conectando = null;

async function conectarEdge() {
    if (browser?.connected) return true;
    if (conectando) return conectando;
    conectando = (async () => {
        const ws = await wsDoEdge();
        if (!ws) return false;
        try {
            browser = await puppeteer.connect({ browserWSEndpoint: ws, defaultViewport: null });
            wsAtual = ws;
        } catch (e) {
            log(`Não consegui conectar no ${nav().nome}:`, e.message);
            browser = null;
            return false;
        }
        log(`Conectado ao ${nav().nome} do Painel.`);
        browser.on('targetcreated', async alvo => {
            if (process.env.PAINEL_DEBUG) log('[alvo novo]', alvo.type(), alvo.url());
            if (alvo.type() !== 'page') return;
            const p = await alvo.page().catch(e => { log('[alvo.page falhou]', e.message); return null; });
            if (process.env.PAINEL_DEBUG) log('[alvo.page]', Boolean(p));
            if (p) preparar(p);
        });
        browser.on('targetchanged', () => notificarHub());
        const esteBrowser = browser;
        esteBrowser.on('disconnected', () => {
            if (browser !== esteBrowser) return; // foi trocado de navegador pelo hub
            log(`O ${nav().nome} do Painel foi fechado.`);
            browser = null;
            paginas.clear();
            notificarHub();
        });
        for (const alvo of browser.targets()) {
            if (alvo.type() !== 'page') continue;
            const p = await alvo.page().catch(() => null);
            if (p) preparar(p);
        }
        notificarHub();
        return true;
    })();
    try { return await conectando; } finally { conectando = null; }
}

// A conexão pode ficar "zumbi" (socket preso, sem fechar limpo) depois de uma ausência longa,
// sem nunca disparar o 'disconnected' acima — e nesse caso o loop de reconexão (que só reage
// quando `browser` fica null) nunca age. Esta função testa de verdade com um comando CDP e,
// se não responder, força o reset.
async function verificarVivo() {
    if (!browser?.connected) return;
    const esteBrowser = browser;
    const vivo = await comTimeout(browser.version().then(() => true), 5000, false);
    if (!vivo && browser === esteBrowser) {
        log(`O ${nav().nome} do Painel parou de responder (provável ausência longa); reconectando.`);
        try { browser.disconnect(); } catch {}
        browser = null;
        paginas.clear();
        notificarHub();
    }
}

async function esperarEdge(segundos) {
    for (let i = 0; i < segundos * 2; i++) {
        if (await conectarEdge()) return true;
        await sleep(500);
    }
    return false;
}

// Abre uma URL no Edge do Painel, no perfil pedido.
// ---------- Qual perfil é cada aba ----------
// No Edge, cada perfil é um "contexto" separado. O Painel aprende o contexto de cada
// perfil quando abre uma aba nele, e guarda isso enquanto o Edge do Painel ficar aberto
// (mesmo que o exe seja fechado e aberto de novo).
const ARQ_SESSAO = path.join(BASE, 'sessao-navegador.json');
let sessao = lerJSON(ARQ_SESSAO, { ws: '', contextos: {} });
let wsAtual = '';

async function alvosDoEdge() {
    if (!browser?.connected) return [];
    try {
        return await comTimeout((async () => {
            const s = await browser.target().createCDPSession();
            const { targetInfos } = await s.send('Target.getTargets');
            s.detach().catch(() => {});
            return targetInfos.filter(t => t.type === 'page');
        })(), 5000, []);
    } catch { return []; }
}

function guardarContexto(dir, ctx) {
    if (!dir || !ctx) return;
    if (sessao.ws !== wsAtual) sessao = { ws: wsAtual, contextos: {} };
    sessao.contextos[dir] = ctx;
    try { gravarJSON(ARQ_SESSAO, sessao); } catch {}
}

async function aprenderContexto(dir, antes) {
    for (let i = 0; i < 16; i++) {
        await sleep(500);
        const nova = (await alvosDoEdge()).find(t => !antes.has(t.targetId));
        if (nova) return guardarContexto(dir, nova.browserContextId);
    }
}

async function perfilTemAba(dir, site) {
    if (sessao.ws !== wsAtual) return false;
    const ctx = sessao.contextos[dir];
    if (!ctx) return false;
    const host = new URL(SITES[site]).hostname;
    const info = (await alvosDoEdge()).find(t => {
        try { return t.browserContextId === ctx && new URL(t.url).hostname === host; } catch { return false; }
    });
    if (!info) return false;
    // A aba pode continuar existindo (mesma URL) mas descartada/congelada pelo navegador depois
    // de um período longo sem uso — nesse caso ela não conta como "já aberta": tenta recarregar.
    const alvoPuppeteer = browser?.targets()?.find(t => t._targetId === info.targetId);
    const page = alvoPuppeteer ? await alvoPuppeteer.page().catch(() => null) : null;
    if (!page) return true; // não achei a Page do puppeteer: assume ok para não duplicar aba
    const viva = await comTimeout(page.evaluate(() => true), 4000, false);
    if (viva) return true;
    log(`Aba de ${site} parece travada no perfil ${dir}; recarregando.`);
    const recarregou = await comTimeout(page.reload({ timeout: 15000 }).then(() => true), 16000, false);
    if (!recarregou) log(`Não consegui recarregar a aba de ${site} no perfil ${dir}; vou abrir outra.`);
    return recarregou;
}

async function abrirNoEdge(url, nomePerfil, { app = false } = {}) {
    if (!copiaPronta()) return { ok: false, erro: `Copie os perfis do ${nav().nome} primeiro (botão no topo do hub).` };
    const alvo = app ? [`--app=${url}`] : [url];
    const perfil = nomePerfil ? perfilPorNome(nomePerfil) : null;
    if (nomePerfil && !perfil) return { ok: false, erro: `Perfil "${nomePerfil}" não encontrado.` };

    const jaConectado = await conectarEdge();
    const antes = new Set((await alvosDoEdge()).map(t => t.targetId));
    executarEdge([...argsPerfil(perfil), ...alvo]);
    const ok = jaConectado || await esperarEdge(20);
    if (!ok) return { ok: false, erro: `O ${nav().nome} abriu, mas não liberou a conexão do Painel.` };
    if (perfil) await aprenderContexto(perfil.dir, antes);
    return { ok: true };
}

async function abrirTodos() {
    const lista = [
        ...perfisDe('tallos').map(perfil => ({ site: 'tallos', perfil })),
        ...perfisDe('smartbus').map(perfil => ({ site: 'smartbus', perfil }))
    ].filter(x => perfilDisponivel(x.perfil));
    let abertas = 0;
    log(`Abrindo a Tallos e a SmartBus nos perfis cadastrados (${lista.length})...`);
    for (const x of lista) {
        const p = perfilPorNome(x.perfil);
        if (p && await perfilTemAba(p.dir, x.site)) continue; // já tem essa aba aberta nesse perfil
        const r = await abrirNoEdge(SITES[x.site], x.perfil).catch(e => ({ ok: false, erro: e.message }));
        if (r.ok) abertas++;
        else log(`Não abriu ${x.site} em ${x.perfil}: ${r.erro}`);
        await sleep(600);
    }
    log(abertas === 1 ? "1 aba aberta." : `${abertas} abas abertas.`);
}

// ---------- Cópia dos perfis ----------
const copia = { rodando: false, arquivos: 0, bytes: 0, erro: '', terminouEm: 0, pulados: 0 };

async function copiarPasta(origem, destino) {
    await fs.promises.mkdir(destino, { recursive: true });
    let itens = [];
    try { itens = await fs.promises.readdir(origem, { withFileTypes: true }); } catch { return; }
    for (const it of itens) {
        if (NAO_COPIAR.has(it.name.toLowerCase())) continue;
        const de = path.join(origem, it.name), para = path.join(destino, it.name);
        if (it.isDirectory()) {
            await copiarPasta(de, para);
        } else if (it.isFile()) {
            try {
                await fs.promises.copyFile(de, para);
                copia.arquivos++;
                try { copia.bytes += (await fs.promises.stat(para)).size; } catch {}
            } catch {
                copia.pulados++; // arquivo em uso: o Edge recria
            }
            if (copia.arquivos % 50 === 0) notificarHub();
            if (copia.arquivos % 1000 === 0) log(`Copiando perfis... ${copia.arquivos} arquivos`);
        }
    }
}

async function copiarPerfis({ fecharEdge }) {
    if (copia.rodando) return { ok: true };
    if (!fs.existsSync(path.join(nav().dados, 'Local State'))) {
        return { ok: false, erro: `Não achei os perfis do ${nav().nome} neste computador.` };
    }
    if (await edgeRodando()) {
        if (!fecharEdge) return { ok: false, precisaFechar: true };
        if (browser) { try { browser.disconnect(); } catch {} browser = null; }
        await new Promise(r => execFile('taskkill', ['/IM', nav().imagem, '/F', '/T'], { windowsHide: true }, () => r()));
        for (let i = 0; i < 20 && await edgeRodando(); i++) await sleep(300);
        await sleep(800);
    }

    // Copia os perfis das listas; com as listas vazias (primeiro uso), copia todos.
    const todos = lerPerfisDe(nav().dados);
    const daLista = todos.filter(p => nomesPerfis().some(n => bate(p, n)));
    const origens = daLista.length ? daLista : todos;
    if (!origens.length) return { ok: false, erro: `Não achei nenhum perfil no ${nav().nome}.` };

    Object.assign(copia, { rodando: true, arquivos: 0, bytes: 0, erro: '', pulados: 0 });
    log(`Copiando os perfis do ${nav().nome}. O ${nav().nome} do Painel abre sozinho quando terminar...`);
    notificarHub();
    (async () => {
        try {
            const tmp = nav().copia + '.novo';
            await fs.promises.rm(tmp, { recursive: true, force: true });
            await fs.promises.mkdir(tmp, { recursive: true });
            for (const p of origens) await copiarPasta(path.join(nav().dados, p.dir), path.join(tmp, p.dir));
            await fs.promises.copyFile(path.join(nav().dados, 'Local State'), path.join(tmp, 'Local State'));
            await fs.promises.rm(nav().copia, { recursive: true, force: true });
            await fs.promises.rename(tmp, nav().copia);
            copia.terminouEm = Date.now();
            limparCachePerfis();
            log(`Perfis copiados: ${origens.map(p => p.nome).join(', ')} (${copia.arquivos} arquivos).`);
            const doHub = perfilDoHub();
            executarEdge(argsPerfil(doHub ? perfilPorNome(doHub) : null));
            esperarEdge(20).catch(() => {});
        } catch (e) {
            copia.erro = e.message;
            log('Falha ao copiar os perfis:', e.message);
        } finally {
            copia.rodando = false;
            notificarHub();
        }
    })();
    return { ok: true };
}

// Copia só um perfil (usado ao adicionar um perfil novo pelo hub).
async function copiarUmPerfil(origem) {
    const antes = copia.pulados;
    copia.rodando = true;
    notificarHub();
    log(`Copiando o perfil ${origem.nome}...`);
    try {
        await copiarPasta(path.join(nav().dados, origem.dir), path.join(nav().copia, origem.dir));
    } finally {
        copia.rodando = false;
        limparCachePerfis();
        notificarHub();
    }
    log(`Perfil ${origem.nome} copiado.`);
    return { pulados: copia.pulados - antes };
}

// ---------- Abas ----------
const paginas = new Set();
const verificando = new WeakSet();
const registros = new WeakMap();
const carregados = new WeakMap();
const recarregadas = new WeakMap();
const preparando = new WeakMap();
const prontas = new WeakSet();

function hostDe(page) {
    try { return new URL(page.url()).hostname; } catch { return ''; }
}
function casaHost(host, hosts) {
    return hosts.some(h => h.startsWith('.') ? (host === h.slice(1) || host.endsWith(h)) : host === h);
}
function ehSiteDeTrabalho(page) {
    const url = page.url();
    return Object.values(SCRIPTS).some(s => casaUrl(url, s.regras));
}

// Avisa todas as abas (inclusive a de origem, onde outros scripts do mesmo armazém
// precisam saber); cada ponte ignora a mudança que ela mesma fez (pelo "token").
function transmitir(armazem, chave, valor, token = '') {
    const doArmazem = Object.values(SCRIPTS).filter(s => s.armazem === armazem);
    for (const p of paginas) {
        if (p.isClosed()) continue;
        const url = p.url();
        if (!doArmazem.some(s => casaUrl(url, s.regras))) continue;
        p.evaluate((a, k, v, t) => {
            for (const f of ((window.__gmOuvintes || {})[a] || [])) { try { f(k, v, t); } catch {} }
        }, armazem, chave, valor === undefined ? null : valor, token).catch(() => {});
    }
}

function definirValor(armazem, chave, valor, token = '') {
    store[armazem] = store[armazem] || {};
    store[armazem][chave] = valor;
    agendarSalvar();
    transmitir(armazem, chave, valor, token);
}

// Liga/desliga na hora, nas abas abertas, os scripts que são módulos (registrarModulo).
// Retorna false se algum script precisa de recarregar a aba para mudar.
async function alternarAoVivo(ids, ativo) {
    let tudoAoVivo = true;
    for (const p of paginas) {
        if (p.isClosed() || !ehSiteDeTrabalho(p)) continue;
        try {
            const r = await p.evaluate((ids, ativo) => ids.map(id => {
                const f = (window.__painelAlternar || {})[id];
                if (typeof f !== 'function') return null;   // script não está nesta aba
                return f(ativo);
            }), ids, ativo);
            if (r.some(x => x === false)) tudoAoVivo = false;
        } catch { tudoAoVivo = false; }
    }
    return tudoAoVivo;
}

// GM_xmlhttpRequest: a requisição é feita pelo Painel (sem bloqueio de CORS),
// só para os sites que o script declara em @connect (ou o próprio site da aba).
async function requisitar({ method, url, headers, data, timeout }, script, page) {
    let u;
    try { u = new URL(url, page.url()); } catch { return { erro: 'URL_INVALIDA' }; }
    const host = u.hostname;
    const permitidos = [...(script?.meta?.connect || []), hostDe(page)];
    const ok = permitidos.some(c => c === '*' || host === c || host.endsWith('.' + c) || c === 'self' && host === hostDe(page));
    if (!ok) return { erro: `HOST_NAO_PERMITIDO: adicione "// @connect ${host}" no cabeçalho do script` };
    const ctrl = new AbortController();
    const t = timeout > 0 ? setTimeout(() => ctrl.abort(), timeout) : null;
    try {
        const metodo = String(method || 'GET').toUpperCase();
        const r = await fetch(u.href, { method: metodo, headers, body: data == null || metodo === 'GET' ? undefined : data, signal: ctrl.signal });
        const texto = await r.text();
        const cab = [...r.headers.entries()].map(([k, v]) => `${k}: ${v}`).join('\r\n');
        return { status: r.status, statusText: r.statusText, responseText: texto, responseHeaders: cab, finalUrl: r.url };
    } catch (e) {
        return { erro: e?.name === 'AbortError' ? 'timeout' : String(e?.message || e) };
    } finally {
        if (t) clearTimeout(t);
    }
}

async function tratar(page, bruto) {
    const msg = JSON.parse(bruto);
    const script = SCRIPTS[msg.script] ? msg.script : null;
    const armazem = script ? SCRIPTS[script].armazem : null;
    switch (msg.tipo) {
        case 'snapshotTudo': {
            const ativos = {}, dados = {};
            for (const sc of Object.values(SCRIPTS)) {
                ativos[sc.id] = Boolean(config.scripts[sc.id]);
                if (!(sc.armazem in dados)) dados[sc.armazem] = store[sc.armazem] || {};
            }
            return JSON.stringify({ ativos, dados });
        }
        case 'snapshot':
            if (!script) return JSON.stringify({ desativado: true });
            return JSON.stringify({ ativo: Boolean(config.scripts[script]), dados: store[armazem] || {} });
        case 'set':
            if (!script) return 'null';
            definirValor(armazem, msg.key, msg.value, msg.token);
            return 'true';
        case 'del':
            if (!script) return 'null';
            if (store[armazem]) delete store[armazem][msg.key];
            agendarSalvar();
            transmitir(armazem, msg.key, undefined, msg.token);
            return 'true';
        case 'xhr':
            if (!script) return JSON.stringify({ erro: 'SCRIPT_DESCONHECIDO' });
            return JSON.stringify(await requisitar(msg, SCRIPTS[script], page));
        case 'carregado':
            if (script) {
                if (!carregados.has(page)) carregados.set(page, new Set());
                carregados.get(page).add(script);
                notificarHub();
            }
            return 'true';
        case 'fechar':
            setTimeout(() => page.close().catch(() => {}), 0);
            return 'true';
        default:
            return 'null';
    }
}

async function injetarSeFaltar(page) {
    if (page.isClosed() || verificando.has(page) || !ehSiteDeTrabalho(page) || !prontas.has(page)) return;
    verificando.add(page);
    try {
        const url = page.url();
        const devem = Object.values(SCRIPTS).filter(s => casaUrl(url, s.regras)).map(s => s.id);
        const r = await page.evaluate(ids => ({
            ponte: typeof window.__gmPonte === 'function',
            faltando: ids.some(id => !window['__painelHub_' + id])
        }), devem);
        if (process.env.PAINEL_DEBUG) log('[injetar]', url, JSON.stringify(r));
        if (!r.ponte) {
            if (recarregadas.get(page) !== page.url()) {
                recarregadas.set(page, page.url());
                page.reload().catch(() => {});
            }
        } else if (r.faltando) {
            await page.evaluate(CODIGO);
        }
    } catch (e) { if (process.env.PAINEL_DEBUG) log('[injetar erro]', e.message); } finally {
        verificando.delete(page);
    }
}

function preparar(page) {
    if (!page) return Promise.resolve();
    if (!preparando.has(page)) preparando.set(page, prepararAgora(page));
    return preparando.get(page);
}

async function prepararAgora(page) {
    paginas.add(page);
    page.on('close', () => { paginas.delete(page); notificarHub(); });
    page.on('framenavigated', f => {
        if (f === page.mainFrame()) { carregados.delete(page); notificarHub(); }
    });
    page.on('domcontentloaded', () => injetarSeFaltar(page));
    page.on('load', () => { notificarHub(); injetarSeFaltar(page); });
    if (process.env.PAINEL_DEBUG) {
        page.on('console', m => log('[console]', m.type(), m.text().slice(0, 300)));
        page.on('pageerror', e => log('[pageerror]', String(e?.message || e).slice(0, 300)));
    }
    const dbg = (...a) => { if (process.env.PAINEL_DEBUG) log('[preparar]', page.url(), ...a); };
    try {
        dbg('expondo ponte');
        await page.exposeFunction('__gmPonte', bruto => tratar(page, bruto));
        dbg('registrando código');
        const r = await page.evaluateOnNewDocument(CODIGO);
        registros.set(page, r?.identifier);
        dbg('pronto');
    } catch (e) {
        dbg('erro', e.message);
        if (!page.isClosed() && !/already exists/i.test(e.message)) log('Falha ao preparar aba:', e.message);
    }
    prontas.add(page);
    await injetarSeFaltar(page);
    notificarHub();
}

async function recarregarScripts({ recarregarAbas = true } = {}) {
    montarCodigo();
    for (const p of paginas) {
        if (p.isClosed()) continue;
        try {
            const antigo = registros.get(p);
            if (antigo) await p.removeScriptToEvaluateOnNewDocument(antigo);
            const r = await p.evaluateOnNewDocument(CODIGO);
            registros.set(p, r?.identifier);
            if (recarregarAbas && ehSiteDeTrabalho(p)) p.reload().catch(() => {});
        } catch {}
    }
}

// ---------- Perfis do app: criar, trocar, editar e excluir ----------
// Solta o navegador atual (sem fechar as janelas dele) para o Painel passar a usar outro.
function soltarNavegador() {
    const antigo = browser;
    browser = null;
    if (antigo) { try { antigo.disconnect(); } catch {} }
    paginas.clear();
}

function validarNomePerfil(bruto, idAtual) {
    const nome = String(bruto || '').trim();
    if (!nome) return { erro: 'Digite o nome do perfil.' };
    if (nome.length > 30) return { erro: 'Use um nome com até 30 letras.' };
    if (perfisApp.perfis.some(p => p.id !== idAtual && p.nome.toLowerCase() === nome.toLowerCase())) {
        return { erro: `Já existe um perfil chamado "${nome}".` };
    }
    return { nome };
}

const scriptsLigados = scripts => Object.keys(SCRIPTS).filter(id => scripts?.[id]).length;

function criarPerfilApp(nome, cor, base) {
    const perfil = montarPerfilApp(nome, cor, config);
    if (base === 'vazio' || base === 'todos') {
        perfil.scripts = {};
        for (const id of [...EMBUTIDOS.map(e => e.id), ...Object.keys(SCRIPTS)]) perfil.scripts[id] = base === 'todos';
    }
    perfisApp.perfis.push(perfil);
    salvarConfig();
    log(`Perfil criado: ${nome}.`);
    return perfil;
}

// Troca o perfil sem fechar nada: só o que mudou de estado é ligado ou desligado nas abas abertas.
async function trocarPerfilApp(id) {
    const novo = perfisApp.perfis.find(p => p.id === id);
    if (id === perfisApp.ativo) return { aoVivo: true };
    salvarConfig();
    const antes = config.scripts;
    const navAntes = nav().id;
    perfisApp.ativo = id;
    copiarCamposDoPerfil(novo, config);
    config.scripts = config.scripts || {};
    if (!acharNavegador()) config.navegador = navAntes;
    limparCachePerfis();
    carregarListaScripts();
    salvarConfig();
    log(`Perfil em uso: ${novo.nome}.`);

    let aoVivo = true;
    if (nav().id !== navAntes) {
        soltarNavegador();
        if (copiaPronta()) conectarEdge().catch(() => {});
    } else {
        const ids = Object.keys(SCRIPTS);
        const desligar = ids.filter(i => antes[i] && !config.scripts[i]);
        const ligar = ids.filter(i => !antes[i] && config.scripts[i]);
        if (desligar.length) aoVivo = await alternarAoVivo(desligar, false);
        if (ligar.length) aoVivo = await alternarAoVivo(ligar, true) && aoVivo;
    }
    return { aoVivo };
}

// ---------- Exportar e importar perfis (levar para outra máquina) ----------
// O arquivo leva a escolha de scripts do perfil e o código de todos os scripts adicionados,
// mais os módulos do app que foram editados. As listas de perfis do navegador ficam de fora:
// são de cada máquina.
const TIPO_EXPORTACAO = 'painel-de-scripts/perfil';

function exportarPerfilApp(id) {
    const perfil = perfisApp.perfis.find(p => p.id === id);
    const escolha = id === perfisApp.ativo ? config.scripts : (perfil.scripts || {});
    const scripts = Object.values(SCRIPTS)
        .filter(s => !s.embutido || s.editado)
        .map(s => ({ id: s.id, nome: s.nome, embutido: s.embutido, codigo: s.fonte }));
    return {
        tipo: TIPO_EXPORTACAO, formato: 1, versaoApp: VERSAO, exportadoEm: new Date().toISOString(),
        perfil: { nome: perfil.nome, cor: perfil.cor, scripts: escolha },
        scripts
    };
}

async function importarPerfilApp(dados) {
    if (dados?.tipo !== TIPO_EXPORTACAO || !dados.perfil || !Array.isArray(dados.scripts)) {
        return { erro: 'Este arquivo não é um perfil exportado pelo Painel de Scripts.' };
    }
    const nome = String(dados.perfil.nome || '').trim().slice(0, 30) || 'Importado';
    const res = { nome, novos: 0, atualizados: 0, iguais: 0, invalidos: [], falhasRequire: [] };
    const idNovo = {};

    for (const sc of dados.scripts) {
        const codigo = String(sc.codigo || '');
        const v = validarScript(codigo);
        if (v.erro) { res.invalidos.push(`${sc.nome || sc.id}: ${v.erro}`); continue; }
        if (sc.embutido) {
            const e = embutidoPorId(sc.id);
            if (!e || MODULOS_RETIRADOS.includes(sc.id)) { res.invalidos.push(`${sc.nome}: o módulo não existe nesta versão do app.`); continue; }
            const arq = path.join(PASTA_MODULOS, e.arquivo);
            if (fs.existsSync(arq) && sha(fs.readFileSync(arq, 'utf8')) === sha(codigo)) res.iguais++;
            else { fs.writeFileSync(arq, codigo); res.atualizados++; }
            idNovo[sc.id] = sc.id;
            continue;
        }
        // Mesmo código já instalado: reaproveita. Mesmo id: é o mesmo script, atualiza o código.
        const mesmoCodigo = config.scriptsExtras.find(x => SCRIPTS[x.id] && sha(SCRIPTS[x.id].fonte) === sha(codigo));
        const mesmoId = config.scriptsExtras.find(x => x.id === sc.id);
        let id;
        if (mesmoCodigo) { id = mesmoCodigo.id; res.iguais++; }
        else if (mesmoId) {
            id = mesmoId.id;
            fs.writeFileSync(path.join(PASTA_SCRIPTS, mesmoId.arquivo), codigo);
            res.atualizados++;
        } else {
            const base = (String(sc.id || '').replace(/[^a-zA-Z0-9_-]/g, '') || 'script').slice(0, 40);
            id = base;
            for (let i = 2; SCRIPTS[id] || config.scriptsExtras.some(x => x.id === id) || id === 'painel' || id.startsWith('mod-'); i++) id = `${base}-${i}`;
            config.scriptsExtras.push({ id, arquivo: `${id}.user.js` });
            fs.writeFileSync(path.join(PASTA_SCRIPTS, `${id}.user.js`), codigo);
            for (const p of perfisApp.perfis) (p.scripts = p.scripts || {})[id] = false;
            config.scripts[id] = false;
            res.novos++;
        }
        idNovo[sc.id] = id;
        res.falhasRequire.push(...await baixarRequires(v.meta));
    }

    carregarListaScripts();
    const escolha = {};
    for (const [id, ligado] of Object.entries(dados.perfil.scripts || {})) {
        const alvo = idNovo[id] || id;
        if (SCRIPTS[alvo]) escolha[alvo] = Boolean(ligado);
    }

    let perfil = perfisApp.perfis.find(p => p.nome.toLowerCase() === nome.toLowerCase());
    res.perfilExistia = Boolean(perfil);
    if (!perfil) {
        const cor = CORES_PERFIL.includes(dados.perfil.cor) ? dados.perfil.cor : CORES_PERFIL[0];
        perfil = montarPerfilApp(nome, cor, config);
        // Perfil novo: só fica ligado o que estava ligado no arquivo.
        perfil.scripts = Object.fromEntries(Object.keys(SCRIPTS).map(id => [id, false]));
        perfisApp.perfis.push(perfil);
    }
    if (perfil.id === perfisApp.ativo) Object.assign(config.scripts, escolha);
    else perfil.scripts = { ...(perfil.scripts || {}), ...escolha };
    res.ligados = Object.values(escolha).filter(Boolean).length;
    res.ativo = perfil.id === perfisApp.ativo;
    salvarConfig();
    await recarregarScripts({ recarregarAbas: false });
    log(`Perfil importado: ${nome} (${res.novos} scripts novos, ${res.atualizados} atualizados, ${res.iguais} já existiam).`);
    for (const x of res.invalidos) log('Não importado:', x);
    return res;
}

async function excluirPerfilApp(id) {
    if (id === perfisApp.ativo) await trocarPerfilApp(perfisApp.perfis.find(p => p.id !== id).id);
    const nome = perfisApp.perfis.find(p => p.id === id).nome;
    perfisApp.perfis = perfisApp.perfis.filter(p => p.id !== id);
    salvarConfig();
    log(`Perfil excluído: ${nome}.`);
}

// ---------- Estado para o hub ----------
function infoAtalho(n) {
    const p = perfilPorNome(n);
    return { nome: n, rotulo: p ? p.nome : n, email: p ? p.email : '', existe: perfilDisponivel(n) };
}

let cacheRodando = { em: 0, valor: false };
async function edgeRodandoCache() {
    if (Date.now() - cacheRodando.em > 3000) cacheRodando = { em: Date.now(), valor: await edgeRodando() };
    return cacheRodando.valor;
}

async function estadoAtual() {

    const perfis = lerPerfis();
    const acha = nome => perfis.find(p => p.nome.toLowerCase() === nome.toLowerCase()) || null;

    let smartbus = 0, tallos = 0;
    for (const p of paginas) {
        if (p.isClosed()) continue;
        const h = hostDe(p);
        if (h.endsWith('smarttravelit.com')) smartbus++;
        else if (h.endsWith('tallos.com.br')) tallos++;
    }

    const conectado = Boolean(browser?.connected);
    return {
        versao: VERSAO,
        pasta: PASTA_SCRIPTS,
        edge: {
            instalado: Boolean(acharNavegador()),
            navegador: nav().id,
            nomeNavegador: nav().nome,
            navegadores: Object.values(NAVEGADORES).map(n => ({ id: n.id, nome: n.nome, instalado: Boolean(acharNavegador(n)) })),
            conectado,
            copiaPronta: copiaPronta(),
            copiaPasta: nav().copia,
            abrirAoIniciar: Boolean(config.abrirAoIniciar),
            copia: { rodando: copia.rodando, arquivos: copia.arquivos, mb: Math.round(copia.bytes / 1048576), erro: copia.erro },
            abas: { smartbus, tallos }
        },
        atalhos: {
            tallos: perfisDe('tallos').map(infoAtalho),
            smartbus: perfisDe('smartbus').map(infoAtalho),
            disponiveis: [...new Set([...lerPerfisDe(nav().dados), ...lerPerfisDe(nav().copia)].map(p => p.nome))]
                .filter(n => !nomesPerfis().some(x => chaveNome(x) === chaveNome(n)))
        },
        perfisApp: {
            ativo: perfisApp.ativo,
            cores: CORES_PERFIL,
            lista: perfisApp.perfis.map(p => ({
                id: p.id, nome: p.nome, cor: p.cor,
                ligados: scriptsLigados(p.id === perfisApp.ativo ? config.scripts : p.scripts)
            }))
        },
        modulosRemovidos: config.modulosRemovidos.length,
        scripts: Object.values(SCRIPTS).map(s => ({
            id: s.id, nome: s.nome, ativo: Boolean(config.scripts[s.id]), versao: s.meta.version || '',
            descricao: s.meta.description || '', sites: sitesCurtos(s.meta), embutido: s.embutido, grupo: s.grupo,
            editado: s.editado
        }))
    };
}

// ---------- Hub ----------
let ganchos = { aoMudar() {}, sair() {} };
let timerHub = null;
function notificarHub() {
    clearTimeout(timerHub);
    timerHub = setTimeout(() => ganchos.aoMudar(), 250);
}

const resp = (status, dados) => ({ status, dados });

function abrirPasta(dir) {
    const cmd = process.platform === 'win32' ? 'explorer' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    try { spawn(cmd, [dir], { detached: true, stdio: 'ignore', windowsHide: true }).unref(); } catch {}
}

// Atende um pedido do hub (vem pelo IPC) e devolve { status, dados }.
async function tratarApi(caminho, corpoRecebido) {
    if (caminho === '/api/estado') return resp(200, await estadoAtual());
    const corpo = corpoRecebido && typeof corpoRecebido === 'object' ? corpoRecebido : {};

    switch (caminho) {
        case '/api/sair':
            log('Painel fechado pelo hub.');
            setTimeout(() => ganchos.sair(), 300);
            return resp(200, { ok: true });

        case '/api/registro':
            if (process.platform === 'win32') spawn('notepad.exe', [ARQ_LOG], { detached: true, stdio: 'ignore' }).unref();
            return resp(200, { ok: true });

        case '/api/navegador': {
            limparCachePerfis();
            const id = corpo.id === 'chrome' ? 'chrome' : 'edge';
            if (!acharNavegador(NAVEGADORES[id])) return resp(400, { erro: `${NAVEGADORES[id].nome} não está instalado neste computador.` });
            if (config.navegador !== id) {
                soltarNavegador();
                config.navegador = id;
                salvarConfig();
                log(`Navegador escolhido: ${NAVEGADORES[id].nome}.`);
                if (copiaPronta()) conectarEdge().catch(() => {});
            }
            notificarHub();
            return resp(200, { ok: true });
        }

        case '/api/config':
            if ('abrirAoIniciar' in corpo) config.abrirAoIniciar = Boolean(corpo.abrirAoIniciar);
            salvarConfig();
            notificarHub();
            return resp(200, { ok: true });

        case '/api/scripts/codigo': {
            const sc = SCRIPTS[corpo.id];
            if (!sc) return resp(404, { erro: 'Script não encontrado.' });
            return resp(200, { id: sc.id, nome: sc.nome, codigo: sc.fonte, embutido: sc.embutido, original: sc.embutido ? (embutidoPorId(sc.id)?.fonte || null) : null });
        }

        case '/api/scripts/renomear': {
            const sc = SCRIPTS[corpo.id];
            if (!sc) return resp(404, { erro: 'Script não encontrado.' });
            const nome = String(corpo.nome || '').trim();
            if (!nome) return resp(400, { erro: 'Digite o nome do script.' });
            const descricao = String(corpo.descricao || '').trim();
            let codigo = alterarCabecalho(sc.fonte, 'name', nome);
            codigo = alterarCabecalho(codigo, 'description', descricao);
            const v = validarScript(codigo);
            if (v.erro) return resp(400, { erro: v.erro });
            fs.writeFileSync(path.join(PASTA_SCRIPTS, sc.arquivo), codigo);
            await recarregarScripts({ recarregarAbas: false });
            notificarHub();
            return resp(200, { ok: true });
        }

        case '/api/scripts/salvar':
        case '/api/scripts/novo': {
            const codigo = String(corpo.codigo || '');
            const v = validarScript(codigo);
            if (v.erro) return resp(400, { erro: v.erro });
            let id = corpo.id;
            if (caminho === '/api/scripts/novo') {
                const base = (v.meta.name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'script').slice(0, 40);
                id = base;
                for (let i = 2; SCRIPTS[id] || config.scriptsExtras.some(x => x.id === id) || id === 'painel' || id.startsWith('mod-'); i++) id = `${base}-${i}`;
                config.scriptsExtras.push({ id, arquivo: `${id}.user.js` });
                // O script novo fica ligado só no perfil em uso: cada perfil escolhe os seus.
                for (const p of perfisApp.perfis) (p.scripts = p.scripts || {})[id] = false;
                config.scripts[id] = true;
                salvarConfig();
            } else if (!SCRIPTS[id]) {
                return resp(404, { erro: 'Script não encontrado.' });
            }
            const arquivo = SCRIPTS[id]?.arquivo || config.scriptsExtras.find(x => x.id === id).arquivo;
            fs.writeFileSync(path.join(PASTA_SCRIPTS, arquivo), codigo);
            const falhas = await baixarRequires(v.meta);
            await recarregarScripts({ recarregarAbas: false });
            log(`Script ${caminho.endsWith('novo') ? 'adicionado' : 'salvo'}: ${v.meta.name}`);
            notificarHub();
            return resp(200, { ok: true, id, nome: v.meta.name, falhas });
        }

        case '/api/scripts/remover': {
            const id = String(corpo.id || '');
            const sc = SCRIPTS[id];
            if (!sc) return resp(404, { erro: 'Script não encontrado.' });
            // Primeiro desliga nas abas abertas (sem recarregar), depois tira da lista.
            await alternarAoVivo([id], false);
            if (sc.embutido) {
                // Módulo que vem com o app: fica guardado e pode ser restaurado depois.
                if (!config.modulosRemovidos.includes(id)) config.modulosRemovidos.push(id);
            } else {
                const extra = config.scriptsExtras.find(x => x.id === id);
                config.scriptsExtras = config.scriptsExtras.filter(x => x.id !== id);
                delete config.scripts[id];
                for (const p of perfisApp.perfis) delete p.scripts?.[id];
                try { fs.renameSync(path.join(PASTA_SCRIPTS, extra.arquivo), path.join(PASTA_SCRIPTS, extra.arquivo + '.removido')); } catch {}
            }
            salvarConfig();
            await recarregarScripts({ recarregarAbas: false });
            notificarHub();
            return resp(200, { ok: true });
        }

        case '/api/scripts/restaurar-removidos': {
            const n = config.modulosRemovidos.length;
            config.modulosRemovidos = [];
            salvarConfig();
            await recarregarScripts({ recarregarAbas: false });
            notificarHub();
            return resp(200, { ok: true, n });
        }

        case '/api/script':
        case '/api/scripts/todos': {
            const ids = caminho === '/api/script'
                ? (SCRIPTS[corpo.id] ? [corpo.id] : [])
                : Object.values(SCRIPTS).filter(x => !corpo.grupo || x.grupo === corpo.grupo).map(x => x.id);
            if (!ids.length) return resp(400, { erro: 'Script desconhecido' });
            for (const id of ids) config.scripts[id] = Boolean(corpo.ativo);
            salvarConfig();
            const aoVivo = await alternarAoVivo(ids, Boolean(corpo.ativo));
            notificarHub();
            return resp(200, { ok: true, aoVivo });
        }

        case '/api/perfis-app/criar': {
            const v = validarNomePerfil(corpo.nome);
            if (v.erro) return resp(400, { erro: v.erro });
            const cor = CORES_PERFIL.includes(corpo.cor) ? corpo.cor : CORES_PERFIL[0];
            const perfil = criarPerfilApp(v.nome, cor, corpo.base);
            notificarHub();
            return resp(200, { ok: true, id: perfil.id });
        }

        case '/api/perfis-app/trocar': {
            if (!perfisApp.perfis.some(p => p.id === corpo.id)) return resp(404, { erro: 'Perfil não encontrado.' });
            const r = await trocarPerfilApp(corpo.id);
            notificarHub();
            return resp(200, { ok: true, aoVivo: r.aoVivo, nome: perfilAtivo().nome, ligados: scriptsLigados(config.scripts) });
        }

        case '/api/perfis-app/editar': {
            const perfil = perfisApp.perfis.find(p => p.id === corpo.id);
            if (!perfil) return resp(404, { erro: 'Perfil não encontrado.' });
            const v = validarNomePerfil(corpo.nome, perfil.id);
            if (v.erro) return resp(400, { erro: v.erro });
            perfil.nome = v.nome;
            if (CORES_PERFIL.includes(corpo.cor)) perfil.cor = corpo.cor;
            salvarConfig();
            notificarHub();
            return resp(200, { ok: true });
        }

        case '/api/perfis-app/excluir': {
            if (!perfisApp.perfis.some(p => p.id === corpo.id)) return resp(404, { erro: 'Perfil não encontrado.' });
            if (perfisApp.perfis.length === 1) return resp(400, { erro: 'O último perfil não pode ser excluído.' });
            await excluirPerfilApp(corpo.id);
            notificarHub();
            return resp(200, { ok: true });
        }

        case '/api/perfis-app/exportar': {
            if (!perfisApp.perfis.some(p => p.id === corpo.id)) return resp(404, { erro: 'Perfil não encontrado.' });
            return resp(200, { ok: true, dados: exportarPerfilApp(corpo.id) });
        }

        case '/api/perfis-app/importar': {
            const r = await importarPerfilApp(corpo.dados);
            if (r.erro) return resp(400, { erro: r.erro });
            notificarHub();
            return resp(200, { ok: true, ...r });
        }

        case '/api/abrir': {
            const site = corpo.site;
            if (!SITES[site]) return resp(400, { erro: 'Site desconhecido' });
            const perfil = perfisDe(site).includes(corpo.perfil) ? corpo.perfil : null;
            if (!perfil) return resp(400, { erro: 'Perfil desconhecido' });
            try {
                const r = await abrirNoEdge(SITES[site], perfil);
                if (!r.ok) return resp(400, { erro: r.erro });
                notificarHub();
                return resp(200, r);
            } catch (e) {
                return resp(500, { erro: e.message });
            }
        }

        case '/api/perfil/adicionar': {
            limparCachePerfis();
            const nome = String(corpo.nome || '').trim();
            if (!nome) return resp(400, { erro: `Digite o nome do perfil, igual aparece no ${nav().nome}.` });
            const doEdge = lerPerfisDe(nav().dados).find(p => bate(p, nome));
            const doPainel = lerPerfisDe(nav().copia).find(p => bate(p, nome));
            const origem = doEdge || doPainel;
            if (!origem) {
                const nomes = [...new Set([...lerPerfisDe(nav().dados), ...lerPerfisDe(nav().copia)].map(p => p.nome))];
                return resp(400, { erro: `Não achei o perfil "${nome}". Se você acabou de criar ou renomear, feche e abra o ${nav().nome} uma vez para ele salvar. Perfis encontrados: ${nomes.join(', ') || 'nenhum'}.` });
            }
            const site = LISTAS[corpo.site] ? corpo.site : 'smartbus';
            if (perfisDe(site).some(n => chaveNome(n) === chaveNome(origem.nome))) {
                return resp(400, { erro: `O perfil "${origem.nome}" já está nessa lista.` });
            }
            definirPerfis(site, [...perfisDe(site), origem.nome]);
            let aviso = '';
            if (doEdge && copiaPronta() && !fs.existsSync(path.join(nav().copia, doEdge.dir))) {
                const r = await copiarUmPerfil(origem);
                if (r.pulados) aviso = ' Alguns arquivos estavam em uso; se pedir login, entre uma vez nesse perfil.';
            }
            notificarHub();
            return resp(200, { ok: true, nome: origem.nome, aviso });
        }

        case '/api/perfis/escanear': {
            limparCachePerfis();
            const site = LISTAS[corpo.site] ? corpo.site : 'smartbus';
            const achados = todosPerfis();
            definirPerfis(site, achados.map(p => p.nome));
            let pulados = 0;
            if (copiaPronta()) {
                for (const p of achados) {
                    if (p.origem === 'edge' && !fs.existsSync(path.join(nav().copia, p.dir))) {
                        pulados += (await copiarUmPerfil(p)).pulados;
                    }
                }
            }
            notificarHub();
            return resp(200, { ok: true, nomes: perfisDe(site), pulados });
        }

        case '/api/perfil/remover': {
            const nome = String(corpo.nome || '');
            const site = LISTAS[corpo.site] ? corpo.site : 'smartbus';
            if (!perfisDe(site).includes(nome)) return resp(400, { erro: 'Esse perfil não está nessa lista.' });
            definirPerfis(site, perfisDe(site).filter(n => n !== nome));
            notificarHub();
            return resp(200, { ok: true });
        }

        case '/api/copiar-perfis': {
            const r = await copiarPerfis({ fecharEdge: Boolean(corpo.fecharEdge) });
            return resp(r.ok || r.precisaFechar ? 200 : 400, r);
        }

        case '/api/recarregar-scripts':
            await recarregarScripts();
            notificarHub();
            return resp(200, { ok: true });

        case '/api/pasta':
            abrirPasta(PASTA_SCRIPTS);
            return resp(200, { ok: true });

        default:
            return resp(404, { erro: 'Não encontrado' });
    }
}

// ---------- Versão antiga ----------
// A 6.x fica no ar pela porta 47321 e também injeta scripts: precisa sair antes da 7 começar.
const URL_ANTIGA = 'http://127.0.0.1:47321/';

function versaoAntigaAberta() {
    return new Promise(resolve => {
        const req = http.get(URL_ANTIGA + 'api/ping', { timeout: 800 }, res => {
            let b = '';
            res.on('data', c => { b += c; });
            res.on('end', () => { try { resolve(JSON.parse(b).app === 'painel-de-scripts'); } catch { resolve(false); } });
        });
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
    });
}

async function fecharVersaoAntiga() {
    if (!(await versaoAntigaAberta())) return;
    log('Fechando a versão antiga do Painel, que estava aberta.');
    await new Promise(resolve => {
        const req = http.request(URL_ANTIGA + 'api/sair', {
            method: 'POST', headers: { 'X-Painel': '1', 'Content-Type': 'application/json' }, timeout: 3000
        }, res => { res.resume(); res.on('end', resolve); });
        req.on('error', resolve);
        req.end('{}');
    });
    for (let i = 0; i < 20 && await versaoAntigaAberta(); i++) await sleep(300);
}

// ---------- Início ----------
async function iniciar(novosGanchos) {
    ganchos = novosGanchos;
    log(`Painel de Scripts ${VERSAO} iniciando.`);
    await fecharVersaoAntiga();

    if (!acharNavegador()) {
        const outro = Object.values(NAVEGADORES).find(n => acharNavegador(n));
        if (!outro) throw new Error('Nem o Edge nem o Chrome foram encontrados neste computador.');
        log(`${nav().nome} não encontrado. Usando o ${outro.nome}.`);
        config.navegador = outro.id;
        salvarConfig();
    }

    prepararArquivosScripts();
    montarCodigo();
    log(`Script em ${PASTA_SCRIPTS}`);

    await conectarEdge().catch(() => {});

    // "Abrir sozinho ao iniciar": abre a Tallos e a SmartBus em todos os perfis cadastrados.
    // Se uma aba já estiver aberta naquele perfil, ela não é aberta de novo.
    if (copiaPronta() && config.abrirAoIniciar) abrirTodos().catch(e => log('Falha ao abrir as abas:', e.message));
    if (!copiaPronta()) log(`Primeiro uso: no hub, clique em "Copiar perfis do ${nav().nome}".`);

    // Tenta reconectar sozinho se o Edge for aberto pela porta depois.
    setInterval(() => { if (!browser) conectarEdge().catch(() => {}); }, 4000);
    setInterval(() => { for (const p of paginas) injetarSeFaltar(p); }, 8000);
    setInterval(notificarHub, 10000);
    // Confirma de verdade que a conexão ainda responde (pega o caso de conexão "zumbi" depois
    // de uma ausência longa, que não dispara 'disconnected' por conta própria).
    setInterval(() => { verificarVivo().catch(() => {}); }, 30000);
}

// Chamado pelo processo principal quando o Windows acorda de suspensão/tela bloqueada: a
// ausência pode ter deixado a conexão zumbi, então confirma na hora em vez de esperar o próximo
// tique do heartbeat.
function aoRetomar() {
    verificarVivo().catch(() => {});
}

function salvarPendente() {
    if (timerSalvar) salvarAgora();
}

module.exports = { iniciar, tratarApi, salvarPendente, log, aoRetomar };
