# Painel de Scripts (versão 6.5.6)

App para Windows (`PainelDeScripts.exe`). Abre o Edge ou o Chrome nos perfis do usuário e injeta
userscripts no SmartBus (Guanabara) e na Tallos, sem precisar do Tampermonkey. O hub, que é a
página de controle, roda em http://127.0.0.1:47321.

## Estrutura

| Caminho | O que é |
|---|---|
| `src/app.js` | Servidor Node. Faz a instalação/desinstalação, a cópia dos perfis, abre o navegador (puppeteer-core via `--remote-debugging-port`), injeta os scripts, emula o GM_* e serve a API do hub. |
| `src/runtime.txt` | Código injetado uma vez por aba: funções GM_*, `registrarModulo`, liga/desliga ao vivo e as "zonas", que desfazem scripts comuns ao desligar. |
| `src/ponte.txt` | Casca colocada em volta de cada userscript (`/*__USERSCRIPT__*/`). |
| `src/hub.html` | Interface do hub: perfis, lista de scripts e editor CodeMirror. |
| `src/embutidos/painel.user.txt` | Script unificado original. `gerar-modulos.js` corta ele em um módulo por arquivo. |
| `src/embutidos/substituicoes/` | Versões novas de módulos, que entram no lugar do trecho do unificado. Exemplo: `mod-reserva_automatica.user.txt`, o **Copiar e Refazer Reserva**. |
| `src/embutidos/extras/` | Módulos que não vêm do unificado. Exemplo: `fast_loading.user.txt`. |
| `src/embutidos/modulos/` | **Gerado** por `gerar-modulos.js`. Não edite aqui, edite em `substituicoes/` ou `extras/`. |
| `src/icone/`, `src/vendor/` | Ícone do app e CodeMirror 5.65.16 embutido. |
| `gerar-modulos.js` | Gera `src/embutidos/modulos/` e o `index.js`. |
| `patch-gui.js` | Troca o subsistema do exe de console para janela, para não abrir a janela preta. |

## Módulos (userscripts)

- Um módulo chama `registrarModulo({ init, destroy })` e liga e desliga na hora pelo hub.
- Um script comum, sem `registrarModulo`, também funciona: o runtime registra o que ele cria e desfaz ao desligar.
- Cabeçalhos aceitos: `@name`, `@version`, `@description`, `@match`/`@include`/`@exclude`, `@run-at`, `@require`, `@connect` e `@grupo` (SmartBus/Tallos).

## Como gerar o exe

```bash
npm install
node gerar-modulos.js
npm run build          # esbuild -> dist/painel.js
npx @yao-pkg/pkg dist/painel.js -t node22-win-x64 --no-bytecode --public --public-packages "*" -o out/PainelDeScripts.exe
node patch-gui.js out/PainelDeScripts.exe
```

Antes de gerar, suba a versão em `const VERSAO` (`src/app.js`) e o `@version` do módulo alterado.

## Dados no Windows

Ficam em `%LOCALAPPDATA%\PainelDeScripts`:

- `config.json` e `dados.json`
- a pasta `scripts/`
- `painel.log`
- as cópias de perfil: `edge-perfis`, `chrome-perfis`
- o exe instalado: `app\PainelDeScripts.exe`
