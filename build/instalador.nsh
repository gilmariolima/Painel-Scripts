; Ajustes no instalador NSIS gerado pelo electron-builder (ligado em "nsis.include" no package.json).
;
; Atualização pelo Painel (o instalador recebe --updated): em vez de rodar escondido (/S), mostra
; só a tela com a barra de progresso, fecha sozinho no fim e reabre o Painel (quando também recebe
; --force-run). Instalação normal, pelo arquivo baixado: continua igual, com todas as telas.

; Tela "Instalar para quem?": na atualização mantém a instalação do usuário atual (o app é
; instalado por usuário, perMachine: false) sem perguntar de novo.
!macro customInstallMode
  ${if} ${isUpdated}
    StrCpy $isForceCurrentInstall "1"
  ${endif}
!macroend

; Fim da cópia dos arquivos. Na atualização, fecha a janela sozinho em vez de esperar o "Próximo"
; e abre o Painel. No modo silencioso o próprio electron-builder já abre, então não repete.
!macro customInstall
  ${if} ${isUpdated}
    SetAutoClose true
    ${ifNot} ${Silent}
    ${andIf} ${isForceRun}
      HideWindow
      ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "--updated"
    ${endIf}
  ${endif}
!macroend

; Tela final igual à padrão (com "Executar Painel de Scripts"), mas pulada na atualização.
!macro customFinishPage
  Function PainelAbrirNoFim
    ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" ""
  FunctionEnd

  Function PainelPularFimSeAtualizacao
    ${if} ${isUpdated}
      Abort
    ${endif}
  FunctionEnd

  !define MUI_FINISHPAGE_RUN
  !define MUI_FINISHPAGE_RUN_FUNCTION "PainelAbrirNoFim"
  !define MUI_PAGE_CUSTOMFUNCTION_PRE PainelPularFimSeAtualizacao
  !insertmacro MUI_PAGE_FINISH
!macroend
