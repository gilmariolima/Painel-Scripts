// Painel de Scripts — executável com hub, usando o Microsoft Edge do usuário.
// Abre o Edge com a porta de controle ligada, nos perfis já existentes
// (Gilmario 1–6 para a SmartBus, Gilmario para a Tallos), e injeta o
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
const HUB_HTML = require('./hub.html');
// Módulos que vêm com o app: um script por módulo (gerados por gerar-modulos.js)
const EMBUTIDOS = require('./embutidos/modulos/index.js');
const PAINEL_ANTIGO = require('./embutidos/painel.user.txt');
const ICONE_ICO = Buffer.from(require('./icone/painel.ico'));
const ICONE_PNG = Buffer.from(require('./icone/painel.png'));
const CM_JS = require('./vendor/codemirror.js.txt');
const CM_CSS = require('./vendor/codemirror.css.txt');

const VERSAO = '6.5.6';
const PORTA = Number(process.env.PAINEL_PORTA || 47321);
const HUB_URL = `http://127.0.0.1:${PORTA}/`;

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
const PERFIS_SMARTBUS_PADRAO = ['Gilmario 1', 'Gilmario 2', 'Gilmario 3', 'Gilmario 4', 'Gilmario 5', 'Gilmario 6'];
const PERFIL_TALLOS = 'Gilmario';

const K = { painelEstado: 'tmm_painel_scripts_state_v1' };

const LOCALAPPDATA = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
const BASE = path.join(LOCALAPPDATA, 'PainelDeScripts');
const PASTA_SCRIPTS = path.join(BASE, 'scripts');
const ARQ_DADOS = path.join(BASE, 'dados.json');
const ARQ_CONFIG = path.join(BASE, 'config.json');

const ARQ_LOG = path.join(BASE, 'painel.log');
const doisDig = n => String(n).padStart(2, '0');
// Sem janela preta: o registro vai para o arquivo painel.log (e para o console, se houver um).
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

function lerJSON(arq, padrao) {
    try { return JSON.parse(fs.readFileSync(arq, 'utf8')); } catch { return padrao; }
}
function gravarJSON(arq, dados) {
    fs.writeFileSync(arq + '.tmp', JSON.stringify(dados));
    fs.renameSync(arq + '.tmp', arq);
}

// Caixa de mensagem do Windows (o app não tem janela de console).
function caixaMensagem(texto, { titulo = 'Painel de Scripts', simNao = false, icone = 'Information' } = {}) {
    if (process.platform !== 'win32') { log(texto); return Promise.resolve(false); }
    const aspas = t => `'${String(t).replace(/'/g, "''")}'`;
    const script = [
        'Add-Type -AssemblyName PresentationFramework',
        `$r = [System.Windows.MessageBox]::Show(${aspas(texto)}, ${aspas(titulo)}, '${simNao ? 'YesNo' : 'OK'}', '${icone}')`,
        'Write-Output $r'
    ].join('; ');
    return new Promise(resolve => {
        execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
            { windowsHide: true }, (err, out) => resolve(!err && /Yes/i.test(String(out))));
    });
}

async function sairComPausa(msg) {
    log(msg);
    await caixaMensagem(`${msg}\n\nDetalhes no registro: ${ARQ_LOG}`, { icone: 'Error' });
    process.exit(1);
}

// ---------- Configuração e script em disco ----------
fs.mkdirSync(PASTA_SCRIPTS, { recursive: true });
const config = Object.assign({ scripts: {}, hashes: {} }, lerJSON(ARQ_CONFIG, {}));
config.scripts = config.scripts || {};
config.hashes = config.hashes || {};
config.scriptsExtras = Array.isArray(config.scriptsExtras) ? config.scriptsExtras : [];
config.modulosRemovidos = Array.isArray(config.modulosRemovidos) ? config.modulosRemovidos : [];
const salvarConfig = () => { try { gravarJSON(ARQ_CONFIG, config); } catch (e) { log('Falha ao salvar config:', e.message); } };

const PASTA_MODULOS = path.join(PASTA_SCRIPTS, 'modulos');

// Grava os módulos que vêm com o app na pasta. Se o arquivo em disco é uma versão
// antiga sem edição, troca pela nova; se você editou, mantém a sua versão.
// Módulos que já vieram no app e foram tirados: apaga o arquivo e o liga/desliga deles.
const MODULOS_RETIRADOS = ['mod-leitor_documento', 'mod-idade_nascimento', 'mod-arrasto_promo'];

function prepararArquivosScripts() {
    fs.mkdirSync(PASTA_MODULOS, { recursive: true });
    for (const id of MODULOS_RETIRADOS) {
        try { fs.rmSync(path.join(PASTA_MODULOS, id + '.user.js'), { force: true }); } catch {}
        delete config.scripts[id];
        delete config.hashes[id];
    }
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
        if (sha(texto) !== sha(PAINEL_ANTIGO) && sha(texto) !== config.hashes.painel) {
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
        const s = await browser.target().createCDPSession();
        const { targetInfos } = await s.send('Target.getTargets');
        s.detach().catch(() => {});
        return targetInfos.filter(t => t.type === 'page');
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
    return (await alvosDoEdge()).some(t => {
        try { return t.browserContextId === ctx && new URL(t.url).hostname === host; } catch { return false; }
    });
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
            executarEdge([...argsPerfil(doHub ? perfilPorNome(doHub) : null), `--app=${HUB_URL}`]);
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
        modulosRemovidos: config.modulosRemovidos.length,
        scripts: Object.values(SCRIPTS).map(s => ({
            id: s.id, nome: s.nome, ativo: Boolean(config.scripts[s.id]), versao: s.meta.version || '',
            descricao: s.meta.description || '', sites: sitesCurtos(s.meta), embutido: s.embutido, grupo: s.grupo,
            editado: s.editado
        }))
    };
}

// ---------- Hub ----------
const clientesSSE = new Set();
let timerHub = null;
function notificarHub() {
    clearTimeout(timerHub);
    timerHub = setTimeout(() => {
        for (const res of clientesSSE) { try { res.write('data: x\n\n'); } catch {} }
    }, 250);
}

function lerCorpo(req) {
    return new Promise(resolve => {
        let b = '';
        req.on('data', c => { b += c; if (b.length > 1e6) req.destroy(); });
        req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
    });
}

function responder(res, status, dados) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(dados));
}

function abrirPasta(dir) {
    const cmd = process.platform === 'win32' ? 'explorer' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    try { spawn(cmd, [dir], { detached: true, stdio: 'ignore', windowsHide: true }).unref(); } catch {}
}

async function rota(req, res) {
    const url = new URL(req.url, HUB_URL);

    if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(HUB_HTML);
    }
    if (url.pathname === '/vendor/codemirror.js' || url.pathname === '/vendor/codemirror.css') {
        const js = url.pathname.endsWith('.js');
        res.writeHead(200, { 'Content-Type': (js ? 'application/javascript' : 'text/css') + '; charset=utf-8', 'Cache-Control': 'max-age=86400' });
        return res.end(js ? CM_JS : CM_CSS);
    }
    if (url.pathname === '/favicon.ico' || url.pathname === '/icone.png') {
        const ico = url.pathname === '/favicon.ico';
        res.writeHead(200, { 'Content-Type': ico ? 'image/x-icon' : 'image/png', 'Cache-Control': 'max-age=86400' });
        return res.end(ico ? ICONE_ICO : ICONE_PNG);
    }
    if (req.method === 'GET' && url.pathname === '/api/ping') {
        return responder(res, 200, { ok: true, app: 'painel-de-scripts' });
    }
    if (req.method === 'GET' && url.pathname === '/eventos') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        res.write('retry: 2000\n\n');
        clientesSSE.add(res);
        req.on('close', () => clientesSSE.delete(res));
        return;
    }

    const origem = req.headers.origin;
    if (req.headers['x-painel'] !== '1' || (origem && origem !== HUB_URL.slice(0, -1))) {
        return responder(res, 403, { erro: 'Acesso negado' });
    }

    if (req.method === 'GET' && url.pathname === '/api/estado') {
        return responder(res, 200, await estadoAtual());
    }
    if (req.method !== 'POST') return responder(res, 404, { erro: 'Não encontrado' });

    const corpo = await lerCorpo(req);

    switch (url.pathname) {
        case '/api/mostrar-hub':
            garantirHubVisivel(8).catch(() => {});
            if (copiaPronta()) await abrirNoEdge(HUB_URL, perfilDoHub(), { app: true }).catch(() => {});
            else executarEdge([`--app=${HUB_URL}`], { doPainel: false });
            return responder(res, 200, { ok: true });

        case '/api/sair':
            responder(res, 200, { ok: true });
            log('Painel fechado pelo hub.');
            setTimeout(() => { if (timerSalvar) salvarAgora(); process.exit(0); }, 300);
            return;

        case '/api/registro':
            if (process.platform === 'win32') spawn('notepad.exe', [ARQ_LOG], { detached: true, stdio: 'ignore' }).unref();
            return responder(res, 200, { ok: true });

        case '/api/navegador': {
            limparCachePerfis();
            const id = corpo.id === 'chrome' ? 'chrome' : 'edge';
            if (!acharNavegador(NAVEGADORES[id])) return responder(res, 400, { erro: `${NAVEGADORES[id].nome} não está instalado neste computador.` });
            if (config.navegador !== id) {
                // Solta o navegador atual (sem fechar as janelas dele) e passa a usar o outro.
                const antigo = browser;
                browser = null;
                if (antigo) { try { antigo.disconnect(); } catch {} }
                paginas.clear();
                config.navegador = id;
                salvarConfig();
                log(`Navegador escolhido: ${NAVEGADORES[id].nome}.`);
                if (copiaPronta()) conectarEdge().catch(() => {});
            }
            notificarHub();
            return responder(res, 200, { ok: true });
        }

        case '/api/config':
            if ('abrirAoIniciar' in corpo) config.abrirAoIniciar = Boolean(corpo.abrirAoIniciar);
            salvarConfig();
            notificarHub();
            return responder(res, 200, { ok: true });

        case '/api/scripts/codigo': {
            const sc = SCRIPTS[corpo.id];
            if (!sc) return responder(res, 404, { erro: 'Script não encontrado.' });
            return responder(res, 200, { id: sc.id, nome: sc.nome, codigo: sc.fonte, embutido: sc.embutido, original: sc.embutido ? (embutidoPorId(sc.id)?.fonte || null) : null });
        }

        case '/api/scripts/salvar':
        case '/api/scripts/novo': {
            const codigo = String(corpo.codigo || '');
            const v = validarScript(codigo);
            if (v.erro) return responder(res, 400, { erro: v.erro });
            let id = corpo.id;
            if (url.pathname === '/api/scripts/novo') {
                const base = (v.meta.name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'script').slice(0, 40);
                id = base;
                for (let i = 2; SCRIPTS[id] || config.scriptsExtras.some(x => x.id === id) || id === 'painel' || id.startsWith('mod-'); i++) id = `${base}-${i}`;
                config.scriptsExtras.push({ id, arquivo: `${id}.user.js` });
                config.scripts[id] = true;
                salvarConfig();
            } else if (!SCRIPTS[id]) {
                return responder(res, 404, { erro: 'Script não encontrado.' });
            }
            const arquivo = SCRIPTS[id]?.arquivo || config.scriptsExtras.find(x => x.id === id).arquivo;
            fs.writeFileSync(path.join(PASTA_SCRIPTS, arquivo), codigo);
            const falhas = await baixarRequires(v.meta);
            await recarregarScripts({ recarregarAbas: false });
            log(`Script ${url.pathname.endsWith('novo') ? 'adicionado' : 'salvo'}: ${v.meta.name}`);
            notificarHub();
            return responder(res, 200, { ok: true, id, nome: v.meta.name, falhas });
        }

        case '/api/scripts/remover': {
            const id = String(corpo.id || '');
            const sc = SCRIPTS[id];
            if (!sc) return responder(res, 404, { erro: 'Script não encontrado.' });
            // Primeiro desliga nas abas abertas (sem recarregar), depois tira da lista.
            await alternarAoVivo([id], false);
            if (sc.embutido) {
                // Módulo que vem com o app: fica guardado e pode ser restaurado depois.
                if (!config.modulosRemovidos.includes(id)) config.modulosRemovidos.push(id);
            } else {
                const extra = config.scriptsExtras.find(x => x.id === id);
                config.scriptsExtras = config.scriptsExtras.filter(x => x.id !== id);
                delete config.scripts[id];
                try { fs.renameSync(path.join(PASTA_SCRIPTS, extra.arquivo), path.join(PASTA_SCRIPTS, extra.arquivo + '.removido')); } catch {}
            }
            salvarConfig();
            await recarregarScripts({ recarregarAbas: false });
            notificarHub();
            return responder(res, 200, { ok: true });
        }

        case '/api/scripts/restaurar-removidos': {
            const n = config.modulosRemovidos.length;
            config.modulosRemovidos = [];
            salvarConfig();
            await recarregarScripts({ recarregarAbas: false });
            notificarHub();
            return responder(res, 200, { ok: true, n });
        }

        case '/api/script':
        case '/api/scripts/todos': {
            const ids = url.pathname === '/api/script'
                ? (SCRIPTS[corpo.id] ? [corpo.id] : [])
                : Object.values(SCRIPTS).filter(x => !corpo.grupo || x.grupo === corpo.grupo).map(x => x.id);
            if (!ids.length) return responder(res, 400, { erro: 'Script desconhecido' });
            for (const id of ids) config.scripts[id] = Boolean(corpo.ativo);
            salvarConfig();
            const aoVivo = await alternarAoVivo(ids, Boolean(corpo.ativo));
            notificarHub();
            return responder(res, 200, { ok: true, aoVivo });
        }

        case '/api/abrir': {
            const site = corpo.site;
            if (!SITES[site]) return responder(res, 400, { erro: 'Site desconhecido' });
            const perfil = perfisDe(site).includes(corpo.perfil) ? corpo.perfil : null;
            if (!perfil) return responder(res, 400, { erro: 'Perfil desconhecido' });
            try {
                const r = await abrirNoEdge(SITES[site], perfil);
                if (!r.ok) return responder(res, 400, { erro: r.erro });
                notificarHub();
                return responder(res, 200, r);
            } catch (e) {
                return responder(res, 500, { erro: e.message });
            }
        }

        case '/api/perfil/adicionar': {
            limparCachePerfis();
            const nome = String(corpo.nome || '').trim();
            if (!nome) return responder(res, 400, { erro: `Digite o nome do perfil, igual aparece no ${nav().nome}.` });
            const doEdge = lerPerfisDe(nav().dados).find(p => bate(p, nome));
            const doPainel = lerPerfisDe(nav().copia).find(p => bate(p, nome));
            const origem = doEdge || doPainel;
            if (!origem) {
                const nomes = [...new Set([...lerPerfisDe(nav().dados), ...lerPerfisDe(nav().copia)].map(p => p.nome))];
                return responder(res, 400, { erro: `Não achei o perfil "${nome}". Se você acabou de criar ou renomear, feche e abra o ${nav().nome} uma vez para ele salvar. Perfis encontrados: ${nomes.join(', ') || 'nenhum'}.` });
            }
            const site = LISTAS[corpo.site] ? corpo.site : 'smartbus';
            if (perfisDe(site).some(n => chaveNome(n) === chaveNome(origem.nome))) {
                return responder(res, 400, { erro: `O perfil "${origem.nome}" já está nessa lista.` });
            }
            definirPerfis(site, [...perfisDe(site), origem.nome]);
            let aviso = '';
            if (doEdge && copiaPronta() && !fs.existsSync(path.join(nav().copia, doEdge.dir))) {
                const r = await copiarUmPerfil(origem);
                if (r.pulados) aviso = ' Alguns arquivos estavam em uso; se pedir login, entre uma vez nesse perfil.';
            }
            notificarHub();
            return responder(res, 200, { ok: true, nome: origem.nome, aviso });
        }

        case '/api/perfis/escanear': {
            limparCachePerfis();
            const site = LISTAS[corpo.site] ? corpo.site : 'smartbus';
            // Na SmartBus, o perfil "Gilmario" (da Tallos) fica de fora.
            const achados = todosPerfis().filter(p => site !== 'smartbus' || !bate(p, PERFIL_TALLOS));
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
            return responder(res, 200, { ok: true, nomes: perfisDe(site), pulados });
        }

        case '/api/perfil/remover': {
            const nome = String(corpo.nome || '');
            const site = LISTAS[corpo.site] ? corpo.site : 'smartbus';
            if (!perfisDe(site).includes(nome)) return responder(res, 400, { erro: 'Esse perfil não está nessa lista.' });
            definirPerfis(site, perfisDe(site).filter(n => n !== nome));
            notificarHub();
            return responder(res, 200, { ok: true });
        }

        case '/api/copiar-perfis': {
            const r = await copiarPerfis({ fecharEdge: Boolean(corpo.fecharEdge) });
            return responder(res, r.ok || r.precisaFechar ? 200 : 400, r);
        }

        case '/api/recarregar-scripts':
            await recarregarScripts();
            notificarHub();
            return responder(res, 200, { ok: true });

        case '/api/pasta':
            abrirPasta(PASTA_SCRIPTS);
            return responder(res, 200, { ok: true });

        default:
            return responder(res, 404, { erro: 'Não encontrado' });
    }
}

// Confere se o hub apareceu de verdade. Se em alguns segundos nenhuma janela do hub
// se conectar, abre o hub numa aba do Edge do Painel ou, sem ele, no navegador padrão.
function abrirNoNavegadorPadrao(url) {
    try {
        if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
        else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    } catch {}
}

async function garantirHubVisivel(segundos = 12) {
    for (let i = 0; i < segundos * 2; i++) {
        if (clientesSSE.size > 0) return;
        await sleep(500);
    }
    log('A janela do hub não apareceu. Abrindo o hub de outro jeito...');
    if (browser?.connected) {
        try {
            const page = await browser.newPage();
            await page.goto(HUB_URL);
            await page.bringToFront();
            await sleep(3000);
            if (clientesSSE.size > 0) return;
        } catch {}
    }
    abrirNoNavegadorPadrao(HUB_URL);
}

// ---------- Outra cópia já aberta? ----------
function outraInstanciaAberta() {
    return new Promise(resolve => {
        const req = http.get(HUB_URL + 'api/ping', { timeout: 800 }, res => {
            let b = '';
            res.on('data', c => { b += c; });
            res.on('end', () => { try { resolve(JSON.parse(b).app === 'painel-de-scripts'); } catch { resolve(false); } });
        });
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
    });
}

function pedirHubDaOutra() {
    return new Promise(resolve => {
        const req = http.request(HUB_URL + 'api/mostrar-hub', {
            method: 'POST', headers: { 'X-Painel': '1', 'Content-Type': 'application/json' }, timeout: 20000
        }, res => { res.resume(); res.on('end', resolve); });
        req.on('error', resolve);
        req.end('{}');
    });
}

// ---------- Instalação (como um app do Windows) ----------
const PASTA_APP = path.join(BASE, 'app');
const EXE_APP = path.join(PASTA_APP, 'PainelDeScripts.exe');
const ARQ_ICONE = path.join(PASTA_APP, 'painel.ico');
const CHAVE_DESINSTALAR = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\PainelDeScripts';
const ehExe = () => Boolean(process.pkg) && process.platform === 'win32';
const mesmoArquivo = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

function powershell(script) {
    return new Promise(resolve => {
        execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
            { windowsHide: true }, err => { if (err) log('PowerShell:', err.message); resolve(!err); });
    });
}

const aspasPs = t => `'${String(t).replace(/'/g, "''")}'`;

// Atalhos no Menu Iniciar e na Área de Trabalho, com ícone, e o registro em "Aplicativos instalados".
function registrarApp() {
    try { fs.writeFileSync(ARQ_ICONE, ICONE_ICO); } catch {}
    const atalho = destino => [
        `$a = $sh.CreateShortcut(${destino})`,
        `$a.TargetPath = ${aspasPs(EXE_APP)}`,
        `$a.WorkingDirectory = ${aspasPs(PASTA_APP)}`,
        `$a.IconLocation = ${aspasPs(ARQ_ICONE + ',0')}`,
        `$a.Description = 'Painel de Scripts — SmartBus e Tallos'`,
        '$a.Save()'
    ].join('; ');
    return powershell([
        "$ProgressPreference = 'SilentlyContinue'",
        '$sh = New-Object -ComObject WScript.Shell',
        atalho(`(Join-Path ([Environment]::GetFolderPath('Programs')) 'Painel de Scripts.lnk')`),
        atalho(`(Join-Path ([Environment]::GetFolderPath('Desktop')) 'Painel de Scripts.lnk')`),
        `$k = ${aspasPs(CHAVE_DESINSTALAR)}`,
        'New-Item -Path $k -Force | Out-Null',
        `Set-ItemProperty -Path $k -Name DisplayName -Value 'Painel de Scripts'`,
        `Set-ItemProperty -Path $k -Name DisplayVersion -Value ${aspasPs(VERSAO)}`,
        `Set-ItemProperty -Path $k -Name Publisher -Value 'Gilmario'`,
        `Set-ItemProperty -Path $k -Name DisplayIcon -Value ${aspasPs(ARQ_ICONE)}`,
        `Set-ItemProperty -Path $k -Name InstallLocation -Value ${aspasPs(PASTA_APP)}`,
        `Set-ItemProperty -Path $k -Name UninstallString -Value ${aspasPs('"' + EXE_APP + '" --desinstalar')}`,
        'Set-ItemProperty -Path $k -Name NoModify -Value 1 -Type DWord',
        'Set-ItemProperty -Path $k -Name NoRepair -Value 1 -Type DWord'
    ].join('\n'));
}

async function pararOutraInstancia() {
    if (!(await outraInstanciaAberta())) return;
    await new Promise(resolve => {
        const req = http.request(HUB_URL + 'api/sair', {
            method: 'POST', headers: { 'X-Painel': '1', 'Content-Type': 'application/json' }, timeout: 3000
        }, res => { res.resume(); res.on('end', resolve); });
        req.on('error', resolve);
        req.end('{}');
    });
    for (let i = 0; i < 20 && await outraInstanciaAberta(); i++) await sleep(300);
    // Versões antigas (com a janela preta) não sabem se fechar sozinhas.
    for (let tentativa = 0; tentativa < 3 && await outraInstanciaAberta(); tentativa++) {
        await caixaMensagem('Uma versão antiga do Painel de Scripts está aberta.\n\nFeche a janela preta do Painel (ou o programa antigo) e depois clique em OK.', { icone: 'Warning' });
        for (let i = 0; i < 10 && await outraInstanciaAberta(); i++) await sleep(300);
    }
    await sleep(500);
}

function iniciarApp(args = []) {
    spawn(EXE_APP, args, { detached: true, stdio: 'ignore', cwd: PASTA_APP }).unref();
}

async function desinstalar() {
    const apagarDados = await caixaMensagem(
        'Remover o Painel de Scripts deste computador?\n\nClique em Sim para apagar também as configurações e as cópias dos perfis.\nClique em Não para manter essas informações (útil se for instalar de novo).',
        { simNao: true, icone: 'Question' });
    await pararOutraInstancia();
    await powershell([
        "$ProgressPreference = 'SilentlyContinue'",
        `Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path ([Environment]::GetFolderPath('Programs')) 'Painel de Scripts.lnk')`,
        `Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Painel de Scripts.lnk')`,
        `Remove-Item -Recurse -Force -ErrorAction SilentlyContinue ${aspasPs(CHAVE_DESINSTALAR)}`
    ].join('\n'));
    // O exe não consegue apagar a si mesmo enquanto roda: um cmd escondido apaga depois.
    const alvo = apagarDados ? BASE : PASTA_APP;
    spawn('cmd.exe', ['/c', `ping -n 4 127.0.0.1 >nul & rmdir /s /q "${alvo}"`],
        { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    await caixaMensagem('O Painel de Scripts foi removido.');
    process.exit(0);
}

// Retorna true quando este processo deve parar aqui (instalou/atualizou e abriu a cópia instalada).
async function cuidarDaInstalacao() {
    if (!ehExe()) return false;
    if (process.argv.includes('--desinstalar')) { await desinstalar(); return true; }
    if (mesmoArquivo(process.execPath, EXE_APP)) {
        if (!fs.existsSync(ARQ_ICONE)) registrarApp().catch(() => {});
        return false;
    }
    // Rodando de fora da pasta do app (ex.: Downloads): instala ou atualiza.
    const atual = fs.readFileSync(process.execPath);
    let igual = false;
    try { igual = fs.statSync(EXE_APP).size === atual.length && sha(fs.readFileSync(EXE_APP)) === sha(atual); } catch {}
    const novo = !fs.existsSync(EXE_APP);
    if (!igual) {
        await pararOutraInstancia();
        fs.mkdirSync(PASTA_APP, { recursive: true });
        let ok = false;
        for (let i = 0; i < 10 && !ok; i++) {
            try { fs.writeFileSync(EXE_APP + '.novo', atual); fs.renameSync(EXE_APP + '.novo', EXE_APP); ok = true; }
            catch { await sleep(500); }
        }
        if (!ok) { await sairComPausa('Não consegui instalar o Painel (o arquivo antigo está em uso). Feche o Painel e tente de novo.'); return true; }
        log(novo ? `Instalado em ${PASTA_APP}.` : `Atualizado para a versão ${VERSAO}.`);
    }
    await registrarApp();
    iniciarApp();
    if (novo) {
        await caixaMensagem('O Painel de Scripts foi instalado.\n\nPara abrir das próximas vezes, use o atalho "Painel de Scripts" na Área de Trabalho ou no Menu Iniciar. Pode apagar o arquivo baixado.');
    }
    process.exit(0);
    return true;
}

// ---------- Início ----------
(async () => {
    process.title = 'Painel de Scripts';
    log(`Painel de Scripts ${VERSAO} iniciando.`);
    if (await cuidarDaInstalacao()) return;

    if (await outraInstanciaAberta()) {
        log('O Painel já está aberto. Mostrando o hub...');
        await pedirHubDaOutra();
        process.exit(0);
    }

    if (!acharNavegador()) {
        const outro = Object.values(NAVEGADORES).find(n => acharNavegador(n));
        if (!outro) return sairComPausa('Nem o Edge nem o Chrome foram encontrados neste computador.');
        log(`${nav().nome} não encontrado. Usando o ${outro.nome}.`);
        config.navegador = outro.id;
        salvarConfig();
    }

    prepararArquivosScripts();
    montarCodigo();
    log(`Script em ${PASTA_SCRIPTS}`);

    const servidor = http.createServer((req, res) => {
        rota(req, res).catch(e => { try { responder(res, 500, { erro: e.message }); } catch {} });
    });
    try {
        await new Promise((resolve, reject) => {
            servidor.once('error', reject);
            servidor.listen(PORTA, '127.0.0.1', resolve);
        });
    } catch (e) {
        return sairComPausa(`Não consegui abrir o hub na porta ${PORTA}: ${e.message}`);
    }

    log(`Hub em ${HUB_URL}`);

    // Abre o hub. Com a cópia dos perfis pronta, abre no Edge do Painel (perfil Gilmario);
    // senão, abre no Edge normal para o primeiro passo (copiar os perfis).
    if (copiaPronta()) {
        const r = await abrirNoEdge(HUB_URL, perfilDoHub(), { app: true })
            .catch(e => ({ ok: false, erro: e.message }));
        log(r?.ok ? 'Pronto! Use o hub para abrir a Tallos e a SmartBus.' : `Atenção: ${r?.erro}`);
        // "Abrir sozinho ao iniciar": abre a Tallos e a SmartBus em todos os perfis cadastrados.
        // Se uma aba já estiver aberta naquele perfil, ela não é aberta de novo.
        if (r?.ok && config.abrirAoIniciar) abrirTodos().catch(e => log('Falha ao abrir as abas:', e.message));
    } else {
        executarEdge([`--app=${HUB_URL}`], { doPainel: false });
        log(`Primeiro uso: no hub, clique em "Copiar perfis do ${nav().nome}".`);
    }

    garantirHubVisivel(copiaPronta() ? 30 : 12).catch(() => {});

    // Tenta reconectar sozinho se o Edge for aberto pela porta depois.
    setInterval(() => { if (!browser) conectarEdge().catch(() => {}); }, 4000);
    setInterval(() => { for (const p of paginas) injetarSeFaltar(p); }, 8000);
    setInterval(notificarHub, 10000);

    // Sem janela preta: quando o hub e o navegador do Painel ficam fechados por um tempo,
    // o Painel se fecha sozinho (abrir o atalho de novo liga tudo outra vez).
    let ultimoUso = Date.now();
    setInterval(() => {
        if (clientesSSE.size > 0 || browser?.connected || copia.rodando) { ultimoUso = Date.now(); return; }
        if (Date.now() - ultimoUso > 3 * 60 * 1000) {
            log('Hub e navegador fechados há 3 minutos. Fechando o Painel.');
            if (timerSalvar) salvarAgora();
            process.exit(0);
        }
    }, 15000);
})().catch(e => sairComPausa('Erro ao iniciar: ' + (e?.message || e)));

process.on('exit', () => { if (timerSalvar) salvarAgora(); });
process.on('SIGINT', () => process.exit(0));
