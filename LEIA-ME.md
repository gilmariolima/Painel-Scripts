# Painel de Scripts

App para Windows, feito em Electron. Abre o Edge ou o Chrome nos perfis do usuário e injeta
userscripts no SmartBus (Guanabara) e na Tallos, sem precisar do Tampermonkey. O hub, que é a
tela de controle, é a janela do app. A versão fica em `version` no `package.json`.


## Estrutura

| Caminho | O que é |
|---|---|
| `src/principal/index.js` | Processo principal do Electron: janela, bandeja, instância única e o protocolo `painel://`, que entrega o hub. |
| `src/preload/index.js` | Ponte entre a janela e o processo principal (`window.painel`). |
| `src/app.js` | Núcleo. Faz a cópia dos perfis, abre o navegador (puppeteer-core via `--remote-debugging-port`), injeta os scripts, emula o GM_* e responde aos pedidos do hub (`tratarApi`). |
| `src/runtime.txt` | Código injetado uma vez por aba: funções GM_*, `registrarModulo`, liga/desliga ao vivo e as "zonas", que desfazem scripts comuns ao desligar. |
| `src/ponte.txt` | Casca colocada em volta de cada userscript (`/*__USERSCRIPT__*/`). |
| `src/hub.html` | Interface do hub: perfis, lista de scripts e editor CodeMirror. |
| `src/embutidos/modulos/` | Os scripts que vêm com o app, um por arquivo (`mod-<id>.user.txt`). Para trocar um script padrão, edite ou troque o arquivo e rode `npm run gerar`. Para tirar um script das máquinas que já o têm, apague o arquivo e ponha o id em `MODULOS_RETIRADOS` (`src/app.js`). |
| `src/icone/`, `src/vendor/` | Ícone do app e CodeMirror 5.65.16 embutido. |
| `gerar-modulos.js` | Monta `src/embutidos/modulos/index.js` a partir dos arquivos da pasta. |
| `src/principal/atualizador.js` | Atualização automática (electron-updater). O botão "Reiniciar e instalar" mostra a tela "Atualizando" e roda o instalador visível: só a barra de progresso, que fecha sozinha e reabre o Painel. |
| `build/instalador.nsh` | Ajustes no instalador NSIS para a atualização: pula as telas "para quem" e final, fecha sozinho e reabre o app. A instalação normal continua igual. |
| `src/scriptsPerfil.js` | Pasta e listas de scripts de cada perfil do app: módulos por perfil, migração da pasta única, cópia e exclusão. Testado em `tests/`. |
| `.github/workflows/publicar.yml` | Publicação: a tag `v<versão>` gera o instalador e cria a Release com o `latest.yml` (atualização automática). |

## Módulos (userscripts)

- Um módulo chama `registrarModulo({ init, destroy })` e liga e desliga na hora pelo hub.
- Um script comum, sem `registrarModulo`, também funciona: o runtime registra o que ele cria e desfaz ao desligar.
- Cabeçalhos aceitos: `@name`, `@version`, `@description`, `@match`/`@include`/`@exclude`, `@run-at`, `@require`, `@connect` e `@grupo` (SmartBus/Tallos/ChatPro).

## Como rodar e gerar o instalador

```bash
npm install
npm test               # testes dos scripts por perfil
npm run gerar          # só se adicionou ou tirou script em src/embutidos/modulos
npm start              # abre o app sem instalar
npm run dist           # gera out/PainelDeScripts-Setup-<versão>.exe (sem publicar)
```

## Publicar uma versão

1. Suba `version` no `package.json` e no `package-lock.json`: as máquinas só atualizam para uma versão maior que a instalada.
2. Commit e push no `main`.
3. `git tag v<versão>` e `git push origin v<versão>`.

O workflow confere a versão, roda os testes, gera o instalador e cria a Release. O app instalado encontra a versão nova sozinho.

Se o Electron abrir como Node puro (erro ao carregar `electron`), a variável
`ELECTRON_RUN_AS_NODE` está definida no terminal: rode `unset ELECTRON_RUN_AS_NODE` antes.

## Dados no Windows

Ficam em `%LOCALAPPDATA%\PainelDeScripts`:

- `config.json` e `dados.json`
- `perfis.json`: os perfis do app, cada um com os seus scripts (ligados, adicionados, módulos removidos), listas de perfis do navegador e navegador
- `scripts\perfis\<id do perfil>\`: os scripts de cada perfil (módulos do app em `modulos\` e os adicionados). Perfil excluído vai para `scripts\perfis\_excluidos\`
- `scripts\requires\`: bibliotecas dos `@require`, para todos os perfis
- `scripts-antes-1.1.0\`: a pasta única de scripts de antes da 1.1.0, guardada na primeira abertura
- `painel.log`
- as cópias de perfil: `edge-perfis`, `chrome-perfis`

O app instalado fica em outro lugar (por padrão `%LOCALAPPDATA%\Programs`), então desinstalar
pelo Windows não apaga esses dados. A pasta `app\` ali dentro só existe em máquinas que tiveram a 6.x.
