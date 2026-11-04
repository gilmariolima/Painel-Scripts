# Painel de Scripts

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
npm test
node gerar-modulos.js
npm run build          # esbuild -> dist/painel.js
npm run empacotar      # pkg -> out/PainelDeScripts.exe, sem a janela preta
```

## Publicar uma versão

1. Suba o `version` no `package.json` e no `package-lock.json`, e o `@version` do módulo alterado. A versão do app vem do `package.json`.
2. Faça o commit e o push no `main`.
3. Crie e envie a tag: `git tag v<versão>` e `git push origin v<versão>`.

O workflow `publicar.yml` confere a versão, roda os testes, gera o exe e cria a Release com o `PainelDeScripts.exe`. No hub, o botão **Verificar atualizações** procura a última Release, baixa, troca o exe e reinicia. O repositório precisa ser público para o app baixar sem token.

## Dados no Windows

Ficam em `%LOCALAPPDATA%\PainelDeScripts`:

- `config.json` e `dados.json`
- a pasta `scripts/`
- `painel.log`
- as cópias de perfil: `edge-perfis`, `chrome-perfis`
- o exe instalado: `app\PainelDeScripts.exe`
