// Verifica e instala atualizações publicadas como GitHub Release, usando electron-updater.
// Fica fora do núcleo (src/app.js) de propósito: é um assunto só do Electron, não da lógica
// de scripts/perfis/navegador, e assim não mexe no arquivo grande por causa disto.
'use strict';

const { app } = require('electron');
const { autoUpdater } = require('electron-updater');

let log = () => {};
let avisarMudanca = () => {};
let empacotado = false;
let estado = { situacao: 'ociosa', versaoAtual: '', versaoNova: '', progresso: 0, erro: '', reabrir: true };

// A barra de progresso dispara várias vezes por segundo: não vale a pena avisar a janela
// a cada uma, então agrupa como o "notificarHub" do núcleo já faz.
let timerAviso = null;
function mudar(novo, { agora = false } = {}) {
    estado = { ...estado, ...novo };
    clearTimeout(timerAviso);
    if (agora) avisarMudanca();
    else timerAviso = setTimeout(avisarMudanca, 200);
}

function configurar({ versaoAtual, empacotado: emp, logger, aoMudar }) {
    log = logger || log;
    avisarMudanca = aoMudar || avisarMudanca;
    empacotado = Boolean(emp);
    estado.versaoAtual = versaoAtual;

    // Manda o que o electron-updater conta para o painel.log: sem isso, quando a instalação
    // falha, não fica rastro nenhum do motivo.
    // Só a primeira linha: os erros de HTTP vêm com a resposta inteira do GitHub junto.
    const linha = m => String(m).split('\n')[0].slice(0, 300);
    autoUpdater.logger = {
        info: m => log('[atualizador]', linha(m)),
        warn: m => log('[atualizador] aviso:', linha(m)),
        error: m => log('[atualizador] erro:', linha(m)),
        debug: () => {}
    };
    autoUpdater.autoDownload = true;
    // A instalação só acontece pelo botão (ou ao fechar pelo Painel), sempre com a janela de
    // progresso à vista. Instalar escondido ao sair deixava a pessoa abrir o Painel no meio da
    // instalação, e o instalador então fechava o app à força ou desistia sem avisar.
    autoUpdater.autoInstallOnAppQuit = false;

    autoUpdater.on('checking-for-update', () => mudar({ situacao: 'verificando', erro: '' }));
    autoUpdater.on('update-available', info => {
        log(`Atualização disponível: versão ${info.version}. Baixando...`);
        mudar({ situacao: 'baixando', versaoNova: info.version, progresso: 0, erro: '' });
    });
    autoUpdater.on('update-not-available', () => mudar({ situacao: 'ociosa', versaoNova: '' }));
    autoUpdater.on('download-progress', p => mudar({ situacao: 'baixando', progresso: Math.round(p.percent) }));
    autoUpdater.on('update-downloaded', info => {
        log(`Atualização baixada: versão ${info.version}. Pronta para instalar.`);
        mudar({ situacao: 'pronta', versaoNova: info.version, progresso: 100 });
    });
    autoUpdater.on('error', err => {
        // Falhar na instalação não perde o download: volta a 'pronta' para dar para tentar de novo.
        const instalando = estado.situacao === 'instalando';
        log(instalando ? 'Falha ao instalar a atualização:' : 'Falha ao verificar atualização:', err.message);
        mudar({ situacao: instalando ? 'pronta' : 'erro', erro: err.message }, { agora: true });
    });
}

async function verificar() {
    if (!empacotado) {
        // Rodando com "npm start" não há instalador nem arquivo de atualização: a verificação
        // não funciona e não deveria tentar, para não poluir o registro com um erro esperado.
        mudar({ situacao: 'erro', erro: 'A verificação de atualização só funciona no app instalado, não em "npm start".' });
        return;
    }
    // Uma verificação por vez: duas juntas baixavam a mesma versão duas vezes.
    if (['verificando', 'baixando', 'pronta', 'instalando'].includes(estado.situacao)) return;
    try { await autoUpdater.checkForUpdates(); }
    catch { /* o evento 'error' já guardou o motivo em estado.erro */ }
}

const temAtualizacaoPronta = () => estado.situacao === 'pronta';

// Fecha o Painel e roda o instalador com a janela de progresso à vista (não silencioso).
// Com "reabrir", o instalador abre o Painel de novo ao terminar (ver build/instalador.nsh).
function instalarAgora({ reabrir = true } = {}) {
    if (!temAtualizacaoPronta()) {
        return { ok: false, erro: 'Não há atualização baixada para instalar.' };
    }
    log(`Instalando a atualização ${estado.versaoNova}${reabrir ? '' : ' (sem reabrir)'}.`);
    mudar({ situacao: 'instalando', reabrir, erro: '' }, { agora: true });

    // Um instante para a janela mostrar a tela de "Atualizando" antes de fechar.
    setTimeout(() => {
        let saiu = false;
        app.once('before-quit', () => { saiu = true; });
        try {
            // Fora do modo silencioso o electron-updater ignora o 2º parâmetro do quitAndInstall
            // e usa autoRunAppAfterInstall para decidir se passa --force-run ao instalador.
            autoUpdater.autoRunAppAfterInstall = reabrir;
            autoUpdater.quitAndInstall(false, reabrir);
        } catch (e) {
            log('Falha ao iniciar o instalador:', e.message);
            mudar({ situacao: 'pronta', erro: e.message }, { agora: true });
            return;
        }
        // Se o instalador não chegou a abrir, o app nem começa a fechar: avisa em vez de
        // deixar a tela de "Atualizando" girando para sempre.
        setTimeout(() => {
            if (saiu || estado.situacao !== 'instalando') return;
            log('O instalador não iniciou: o app não começou a fechar.');
            mudar({ situacao: 'pronta', erro: 'Não consegui abrir o instalador da atualização. Tente de novo ou reinicie o Painel.' }, { agora: true });
        }, 8000);
        // Se começou a fechar mas travou no caminho, fecha à força: o instalador já está
        // rodando e espera o app sair para trocar os arquivos.
        setTimeout(() => {
            if (!saiu) return;
            log('O app não fechou sozinho para a atualização: fechando à força.');
            app.exit(0);
        }, 15000);
    }, 600);
    return { ok: true };
}

const obterEstado = () => estado;

// Primeira checagem pouco depois de abrir (dá tempo da janela aparecer antes), e depois a
// cada 4 horas: não precisa ser mais frequente, e assim evita bater no GitHub sem necessidade.
function iniciarVerificacoesPeriodicas() {
    if (!empacotado) return;
    setTimeout(verificar, 10000);
    setInterval(verificar, 4 * 60 * 60 * 1000);
}

module.exports = { configurar, verificar, instalarAgora, temAtualizacaoPronta, obterEstado, iniciarVerificacoesPeriodicas };
