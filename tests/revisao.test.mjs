import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ambiente } from './ajuda.mjs';
import vm from 'node:vm';

test('Carrinho converte fator e mantém o id e envio ao recarregar', () => {
  const contexto = vm.createContext({ PAGINAS: {}, MENU_PAI: {}, localStorage: { getItem: () => JSON.stringify({ itens: [], operacao_id: 'tentativa', envio: { itens: [1] } }) } });
  vm.runInContext(readFileSync(new URL('../public/baixa.js', import.meta.url), 'utf8'), contexto);
  assert.equal(vm.runInContext("atualizarItemCarrinho({ fator: 12, quantidade: '2', quantidade_menor: '5' }, { fator: null }).quantidade", contexto), '2,417');
  assert.equal(vm.runInContext("atualizarItemCarrinho({ fator: null, quantidade: '2', quantidade_menor: '5' }, { fator: 12 }).quantidade_menor", contexto), '');
  assert.equal(vm.runInContext("atualizarItemCarrinho({ fator: 12, quantidade: '2', quantidade_menor: '5' }, { fator: 24 }).quantidade_menor", contexto), '5');
  assert.equal(vm.runInContext('lerCarrinho().operacao_id', contexto), 'tentativa');
  assert.equal(vm.runInContext('lerCarrinho().envio.itens[0]', contexto), 1);
  assert.ok(vm.runInContext('novoIdOperacao()', contexto));
});

test('Correção de lote preserva seis casas e saldo do histórico', async t => {
  const a = await ambiente(t, 3981);
  const id = await a.produto({ fator: 12, unidade_menor: 'und' });
  await a.mover(id, 'entrada', 0, { quantidade_menor: 1 });
  await a.api(`/api/produtos/${id}`, 'PUT', { ...(await a.ficha(id)), fator: null });
  const lote = (await a.ficha(id)).lotes[0];
  assert.equal(lote.quantidade, 0.083333);
  await a.api(`/api/lotes/${lote.id}`, 'PATCH', { quantidade: 0.123456 });
  await a.saldo(id, 0.123456);
  await a.api(`/api/lotes/${lote.id}`, 'PATCH', { validade: '2030-01-01' });
  await a.saldo(id, 0.123456);
});

test('Listas convertem soltas ao desligar fator e limpam ao ligar', async t => {
  const a = await ambiente(t, 3982);
  const id = await a.produto({ fator: 12, unidade_menor: 'und' });
  const lista = await a.api('/api/listas', 'POST', { nome: 'Freezer', itens: [{ produto_id: id, quantidade: 2, quantidade_menor: 5 }] }, 201);
  await a.api(`/api/produtos/${id}`, 'PUT', { ...(await a.ficha(id)), fator: null });
  let item = (await a.api(`/api/listas/${lista.id}`)).itens[0];
  assert.equal(item.quantidade, 2.417);
  assert.equal(item.quantidade_menor, null);
  await a.api(`/api/produtos/${id}`, 'PUT', { ...(await a.ficha(id)), fator: 24, unidade_menor: 'und' });
  item = (await a.api(`/api/listas/${lista.id}`)).itens[0];
  assert.equal(item.quantidade, 2.417);
  assert.equal(item.quantidade_menor, null);
});

test('Reenvio de baixa devolve resposta original e desconta uma vez', async t => {
  const a = await ambiente(t, 3983);
  const id = await a.produto();
  await a.mover(id, 'entrada', 3);
  const corpo = { operacao_id: 'baixa-teste', itens: [{ produto_id: id, quantidade: 2 }] };
  const primeira = await a.api('/api/baixa', 'POST', corpo);
  assert.deepEqual(await a.api('/api/baixa', 'POST', corpo), primeira);
  await a.saldo(id, 1);
  assert.equal(a.sql("SELECT * FROM movimentacoes WHERE tipo='saida'").length, 1);
});

test('NF-e confere fator, compara unidades e lembra a nova unidade', async t => {
  const a = await ambiente(t, 3984);
  const id = await a.produto({ nome: 'Leite', fator: 12, unidade_menor: 'und' });
  const xml1 = readFileSync(new URL('./fixtures/nota-lactalis-1.xml', import.meta.url), 'utf8');
  const xml2 = readFileSync(new URL('./fixtures/nota-lactalis-2.xml', import.meta.url), 'utf8');
  const importar = async xml => {
    const r = await fetch('http://127.0.0.1:3984/api/nfe/importar', { method: 'POST', headers: { 'Content-Type': 'application/xml' }, body: xml });
    assert.equal(r.status, 201);
    return (await r.json()).id;
  };
  const nota1 = await importar(xml1.replace('<uCom>CX</uCom>', '<uCom> cx </uCom>'));
  const escolhas = n => Array.from({ length: n }, (_, i) => i ? { n: i + 1, acao: 'ignorar' } : { n: 1, acao: 'produto', produto_id: id, multiplicador: 12, fator: 12 });
  await a.api(`/api/produtos/${id}`, 'PUT', { ...(await a.ficha(id)), fator: 24 });
  const erro = await a.api(`/api/nfe/notas/${nota1}/lancar`, 'POST', { itens: escolhas(4) }, 409);
  assert.equal(erro.erro, 'O produto Leite mudou (caixa/unidade) enquanto a nota estava aberta. Abra a nota de novo.');
  await a.saldo(id, 0);
  const itens = escolhas(4); itens[0].fator = 24;
  await a.api(`/api/nfe/notas/${nota1}/lancar`, 'POST', { itens });
  const igual = await importar(xml2);
  const lembrada = (await a.api(`/api/nfe/notas/${igual}`)).itens[0].sugestao;
  assert.equal(lembrada.multiplicador, 12);
  assert.equal(lembrada.aviso, undefined);
  await a.api(`/api/nfe/notas/${igual}`, 'DELETE');
  const nota2 = await importar(xml2.replace('<uCom>CX</uCom>', '<uCom> un </uCom>'));
  const sugestao = (await a.api(`/api/nfe/notas/${nota2}`)).itens[0].sugestao;
  assert.equal(sugestao.produto.id, id);
  assert.equal(sugestao.multiplicador, 1);
  assert.equal(sugestao.aviso, 'unidade diferente da última nota: confira');
  const segunda = escolhas(3); segunda[0].multiplicador = 1; delete segunda[0].fator;
  await a.api(`/api/nfe/notas/${nota2}/lancar`, 'POST', { itens: segunda });
  assert.equal(a.sql('SELECT unidade_nota FROM nfe_associacoes WHERE produto_id=?', id)[0].unidade_nota, 'un');
});
