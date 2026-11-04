// Decide quando o Painel pode se fechar por não ter hub nem navegador conectados.
'use strict';

// Um salto grande no relógio entre duas checagens é o PC voltando da suspensão:
// esse tempo não conta como sem uso.
function criarVigiaOcioso({ limite, salto, emUso, agora = Date.now }) {
    let ultimoUso = agora();
    let ultimaChecagem = ultimoUso;
    return () => {
        const t = agora();
        const voltouDaSuspensao = t - ultimaChecagem > salto;
        ultimaChecagem = t;
        if (voltouDaSuspensao || emUso()) { ultimoUso = t; return false; }
        return t - ultimoUso > limite;
    };
}

module.exports = { criarVigiaOcioso };
