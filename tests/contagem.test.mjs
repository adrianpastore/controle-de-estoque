import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import vm from 'node:vm';
import { ambiente } from './ajuda.mjs';

test('Contagem: acha produtos pelo nome, separa nome e quantidade e pede confirmação na dúvida', async t => {
  const a = await ambiente(t, 3975);
  const coca = await a.produto({ nome: 'COCA 600', unidade: 'und' });
  await a.produto({ nome: 'COCA LATA 220ML', unidade: 'und' });
  await a.produto({ nome: 'COCA LATA 220ML ZERO', unidade: 'und' });
  const salame = await a.produto({ nome: 'Salame', unidade: 'cx', fator: 12, unidade_menor: 'und' });
  const caldo = await a.produto({ nome: 'caldo de galinha', unidade: 'pct' });
  const texto = ['COCA 600 = 12', 'coca 600', 'Salame 3 cx 4 und', 'caldo galinha: 2,5', 'coca lata 6', 'abacaxi 3', '', '- coca 600 1'].join('\n');
  const { linhas } = await a.api('/api/contagem/conferir', 'POST', { texto });
  const por = Object.fromEntries(linhas.map(l => [l.texto, l]));
  assert.equal(linhas.length, 7);
  assert.equal(por['COCA 600 = 12'].produto.id, coca);
  assert.deepEqual(por['COCA 600 = 12'].numeros, [{ valor: 12, unidade: null }]);
  assert.equal(por['coca 600'].produto.id, coca); // "600" é do nome: ficou sem quantidade
  assert.deepEqual(por['coca 600'].numeros, []);
  assert.equal(por['Salame 3 cx 4 und'].produto.id, salame);
  assert.deepEqual(por['Salame 3 cx 4 und'].numeros, [{ valor: 3, unidade: 'cx' }, { valor: 4, unidade: 'und' }]);
  assert.equal(por['caldo galinha: 2,5'].produto.id, caldo);
  assert.equal(por['caldo galinha: 2,5'].numeros[0].valor, 2.5);
  assert.equal(por['coca lata 6'].situacao, 'confirmar');
  assert.equal(por['coca lata 6'].produto, null);
  assert.deepEqual(por['coca lata 6'].sugestoes.slice(0, 2).map(s => s.nome), ['COCA LATA 220ML', 'COCA LATA 220ML ZERO']);
  assert.equal(por['abacaxi 3'].situacao, 'nao_achou');
  assert.equal(por['- coca 600 1'].produto.id, coca);
  await a.api('/api/contagem/conferir', 'POST', { texto: '  ' }, 400);
});

test('Contagem: grava ajustes com backup, soma linhas repetidas e não grava nada se algo estiver errado', async t => {
  const a = await ambiente(t, 3976);
  const leite = await a.produto({ nome: 'Leite', unidade: 'cx', fator: 12, unidade_menor: 'und' });
  const farinha = await a.produto({ nome: 'Farinha' });
  const outro = await a.produto({ nome: 'Não contado' });
  await a.mover(leite, 'entrada', 5);
  await a.mover(farinha, 'entrada', 10);
  await a.mover(outro, 'entrada', 7);
  const antes = a.snapshot();

  await a.api('/api/contagem/aplicar', 'POST', { itens: [{ produto_id: leite, quantidade: 1 }, { produto_id: 9999, quantidade: 1 }] }, 400);
  await a.api('/api/contagem/aplicar', 'POST', { itens: [{ produto_id: leite, quantidade: 'x' }] }, 400);
  assert.deepEqual(a.snapshot(), antes);

  const corpo = { operacao_id: 'contagem-1', itens: [
    { produto_id: leite, quantidade: 2, quantidade_menor: 4 },
    { produto_id: farinha, quantidade: '3,5' },
    { produto_id: farinha, quantidade: 1 },
  ] };
  const r = await a.api('/api/contagem/aplicar', 'POST', corpo);
  assert.equal(r.ajustados.length, 2);
  assert.equal(r.mudaram, 2);
  assert.match(r.backup, /^antes-contagem-.*\.db$/);
  assert.deepEqual(await a.api('/api/contagem/aplicar', 'POST', corpo), r); // reenvio não grava de novo
  await a.saldo(leite, 28);
  await a.saldo(farinha, 4.5);
  await a.saldo(outro, 7);
  const ajustes = a.sql("SELECT produto_id, quantidade, observacao FROM movimentacoes WHERE tipo = 'ajuste' ORDER BY produto_id");
  assert.deepEqual(ajustes.map(m => [m.produto_id, m.quantidade]), [[leite, -32], [farinha, -5.5]]);
  assert.match(ajustes[0].observacao, /contou 2 cx \+ 4 und \(sistema tinha 5 cx\) — contagem/);
  const backups = await readdir(join(a.pasta, 'backup'));
  assert.equal(backups.filter(b => b.startsWith('antes-contagem-')).length, 1);
});

test('Contagem na tela: números escritos viram caixas e unidades soltas do produto', () => {
  const contexto = vm.createContext({ PAGINAS: {}, MENU_PAI: {}, localStorage: { getItem: () => null, setItem() {} } });
  vm.runInContext(readFileSync(new URL('../public/contagem.js', import.meta.url), 'utf8'), contexto);
  const q = (p, numeros) => JSON.parse(vm.runInContext(`JSON.stringify(quantidadesPara(${JSON.stringify(p)}, ${JSON.stringify(numeros)}))`, contexto));
  const cx = { fator: 12, unidade: 'cx', unidade_menor: 'und' };
  assert.deepEqual(q(cx, [{ valor: 3, unidade: 'cx' }, { valor: 4, unidade: 'und' }]), { quantidade: '3', quantidade_menor: '4', aviso: '' });
  assert.deepEqual(q(cx, [{ valor: 40, unidade: 'unid' }]), { quantidade: '', quantidade_menor: '40', aviso: '' });
  assert.deepEqual(q(cx, [{ valor: 4, unidade: 'un' }, { valor: 3, unidade: 'caixas' }]), { quantidade: '3', quantidade_menor: '4', aviso: '' });
  assert.deepEqual(q(cx, [{ valor: 2, unidade: null }]), { quantidade: '2', quantidade_menor: '', aviso: '' });
  assert.deepEqual(q({ fator: null, unidade: 'kg' }, [{ valor: 2.5, unidade: null }]), { quantidade: '2,5', quantidade_menor: '', aviso: '' });
  assert.match(q({ fator: null, unidade: 'kg' }, [{ valor: 2, unidade: 'cx' }, { valor: 1, unidade: null }]).aviso, /confira/);
  assert.equal(vm.runInContext('csvParaTexto(\'produto;quantidade\\nLeite;"2,5"\\nCoca 600;12\')', contexto), 'Leite\t2,5\nCoca 600\t12');
});
