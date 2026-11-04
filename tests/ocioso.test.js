'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { criarVigiaOcioso } = require('../src/ocioso');

const MIN = 60 * 1000;
function vigia(emUso) {
    let t = 0;
    const checar = criarVigiaOcioso({ limite: 3 * MIN, salto: MIN, emUso, agora: () => t });
    return { checar, em: novo => { t = novo; return checar(); } };
}

test('fecha depois de 3 minutos reais sem uso', () => {
    const v = vigia(() => false);
    for (let t = 15000; t <= 3 * MIN; t += 15000) assert.equal(v.em(t), false);
    assert.equal(v.em(3 * MIN + 15000), true);
});

test('nao fecha enquanto estiver em uso', () => {
    const v = vigia(() => true);
    for (let t = 15000; t <= 10 * MIN; t += 15000) assert.equal(v.em(t), false);
});

test('voltar da suspensao sem conexao nao fecha na hora: recomeca os 3 minutos', () => {
    const v = vigia(() => false);
    assert.equal(v.em(60 * MIN), false);
    let t = 60 * MIN;
    while (t < 63 * MIN) { t += 15000; assert.equal(v.em(t), false); }
    assert.equal(v.em(t + 15000), true);
});
