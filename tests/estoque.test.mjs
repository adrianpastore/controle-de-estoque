import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ambiente, data } from './ajuda.mjs';

test('Migração preserva dados, backup antigo e reinício sem nova migração', async t => {
  let original, lotes;
  const a = await ambiente(t, 3994, caminho => {
    const db = new DatabaseSync(caminho);
    try {
      db.exec(`CREATE TABLE produtos (id INTEGER PRIMARY KEY, nome TEXT NOT NULL, fornecedor TEXT);
        CREATE TABLE lotes (id INTEGER PRIMARY KEY, produto_id INTEGER REFERENCES produtos(id), quantidade REAL, validade TEXT, custo_unit REAL, criado_em TEXT);
        CREATE TABLE movimentacoes (id INTEGER PRIMARY KEY, produto_id INTEGER REFERENCES produtos(id), tipo TEXT CHECK(tipo IN ('entrada','saida','ajuste','importacao')), quantidade REAL, observacao TEXT, usuario TEXT, criado_em TEXT);
        INSERT INTO produtos VALUES (7,'Farinha antiga',NULL),(8,'Leite antigo',NULL);
        INSERT INTO lotes VALUES (11,7,8,'2030-01-01',2.5,'2026-01-01'),(12,8,3,NULL,NULL,'2026-01-02');
        INSERT INTO movimentacoes VALUES (21,7,'entrada',10,'compra','Ana','2026-01-01'),(22,7,'saida',-2,NULL,'Bia','2026-01-02'),(23,8,'importacao',4,'inicial',NULL,'2026-01-01'),(24,8,'ajuste',-1,'contagem','Caio','2026-01-03');`);
      original = db.prepare('SELECT * FROM movimentacoes ORDER BY id').all().map(r => ({ ...r }));
      lotes = db.prepare('SELECT * FROM lotes ORDER BY id').all().map(r => ({ ...r }));
    } finally { db.close(); }
  });
  const campos = 'id,produto_id,tipo,quantidade,observacao,usuario,criado_em';
  assert.deepEqual(a.sql(`SELECT ${campos} FROM movimentacoes ORDER BY id`), original);
  assert.deepEqual(a.sql('SELECT id,produto_id,quantidade,validade,custo_unit,criado_em FROM lotes ORDER BY id'), lotes);
  assert.ok(a.sql('PRAGMA table_info(movimentacoes)').some(c => c.name === 'nota_id'));
  const arquivos = await readdir(join(a.pasta, 'backup'));
  assert.equal(arquivos.length, 1); assert.match(arquivos[0], /^antes-migracao-movimentacoes-.*\.db$/);
  const backup = new DatabaseSync(join(a.pasta, 'backup', arquivos[0]), { readOnly: true });
  try {
    assert.deepEqual(backup.prepare(`SELECT ${campos} FROM movimentacoes ORDER BY id`).all().map(r => ({ ...r })), original);
    assert.ok(!backup.prepare('PRAGMA table_info(movimentacoes)').all().some(c => c.name === 'nota_id'));
    assert.ok(!backup.prepare("SELECT sql FROM sqlite_master WHERE name='movimentacoes'").get().sql.includes("'perda'"));
  } finally { backup.close(); }
  await a.parar(); await a.iniciar();
  assert.deepEqual(await readdir(join(a.pasta, 'backup')), arquivos);
  assert.deepEqual(a.sql(`SELECT ${campos} FROM movimentacoes ORDER BY id`), original);
  // Exercitar os dois novos tipos no banco efetivamente migrado.
  await a.api('/api/lotes/11', 'PATCH', { validade: data(-1) });
  await a.api('/api/lotes/11/vencido', 'POST', {});
  assert.deepEqual(a.sql('SELECT tipo,quantidade FROM movimentacoes WHERE id>24 ORDER BY id'), [{ tipo: 'correcao', quantidade: 0 }, { tipo: 'perda', quantidade: -8 }]);
});

for (const fator of [null, 12]) test(`Manual: entrada, FEFO, ajustes e sinais (fator ${fator})`, async t => {
  const a = await ambiente(t, fator ? 3996 : 3995);
  const id = await a.produto({ fator, unidade: fator ? 'cx' : 'kg', unidade_menor: 'und', nao_contado: true, em_falta: true });
  const mult = fator || 1;
  await a.mover(id, 'entrada', 4); await a.mover(id, 'entrada', 3, { validade: data(20) });
  await a.mover(id, 'entrada', 2, { validade: data(5) });
  assert.equal((await a.ficha(id)).em_falta, 0);
  await a.mover(id, 'saida', 3);
  const p = await a.ficha(id);
  assert.deepEqual(p.lotes.map(l => [l.validade, l.quantidade]), [[data(20), 2*mult], [null, 4*mult]]);
  await a.saldo(id, 6*mult);
  await a.mover(id, 'ajuste', 8); await a.mover(id, 'ajuste', 5); await a.mover(id, 'ajuste', 5);
  assert.equal((await a.ficha(id)).nao_contado, 0);
  assert.deepEqual(a.sql('SELECT tipo,quantidade FROM movimentacoes ORDER BY id'), [
    ['entrada',4],['entrada',3],['entrada',2],['saida',-3],['ajuste',2],['ajuste',-3],['ajuste',0],
  ].map(([tipo,n]) => ({ tipo, quantidade:n*mult })));
  await a.saldo(id, 5*mult);
  if (fator) { await a.mover(id, 'entrada', '', { quantidade_menor: 5 }); await a.mover(id, 'saida', 1, { quantidade_menor: 2 }); await a.saldo(id, 51); }
  const antes = a.snapshot();
  for (const body of [{ tipo:'invalido',quantidade:1 },{ tipo:'entrada',quantidade:0 },{ tipo:'saida',quantidade:999 },{ tipo:'entrada',quantidade:-1 },{ tipo:'entrada',quantidade:'abc' },{ tipo:'entrada' }])
    await a.api(`/api/produtos/${id}/movimentar`, 'POST', body, 400);
  assert.deepEqual(a.snapshot(), antes);
  await a.api('/api/produtos/999999/movimentar','POST',{tipo:'entrada',quantidade:1},404);
});

test('Validades: corrigir, sem mudança, excluir, perdas e invariantes', async t => {
  const a = await ambiente(t, 3997);
  for (const fator of [null,12]) {
    const id = await a.produto({ fator }); await a.mover(id,'entrada',2,{validade:data(5)});
    const lote = (await a.ficha(id)).lotes[0].id;
    await a.api(`/api/lotes/${lote}`,'PATCH',{validade:data(10)});
    assert.equal((await a.ficha(id)).movimentacoes[0].quantidade,0);
    await a.api(`/api/lotes/${lote}`,'PATCH',{quantidade:'3,5', ...(fator ? {quantidade_menor:2} : {})});
    const total = fator ? 44 : 3.5; await a.saldo(id,total);
    assert.equal((await a.ficha(id)).movimentacoes[0].tipo,'correcao');
    assert.equal((await a.ficha(id)).movimentacoes[0].quantidade,total - 2*(fator||1));
    const antes = a.snapshot();
    assert.deepEqual(await a.api(`/api/lotes/${lote}`,'PATCH',{}),{ok:true,mudou:false});
    await a.api(`/api/lotes/${lote}`,'PATCH',{quantidade:'3,5',...(fator ? {quantidade_menor:2} : {}),validade:data(10)});
    assert.deepEqual(a.snapshot(),antes);
    for (const body of [{validade:'2026-02-30'},{validade:'10/10/2026'},{quantidade:-1},{quantidade:0},{quantidade:'abc'},...(fator ? [{quantidade_menor:-1}] : [])])
      await a.api(`/api/lotes/${lote}`,'PATCH',body,400);
    await a.api(`/api/lotes/${lote}/vencido`,'POST',{},400);
    assert.deepEqual(a.snapshot(),antes);
    await a.api(`/api/lotes/${lote}`,'PATCH',fator ? {quantidade_menor:5} : {quantidade:1.5});
    const reduzido = fator ? 5 : 1.5;
    await a.saldo(id,reduzido);
    assert.equal((await a.ficha(id)).movimentacoes[0].quantidade,reduzido-total);
    await a.api(`/api/lotes/${lote}`,'PATCH',{validade:null});
    assert.equal((await a.ficha(id)).lotes[0].validade,null);
    await a.api(`/api/lotes/${lote}/vencido`,'POST',{},400);
    await a.api(`/api/lotes/${lote}`,'DELETE'); await a.saldo(id,0);
    assert.equal((await a.ficha(id)).movimentacoes[0].quantidade,-reduzido);
    await a.api(`/api/lotes/${lote}`,'DELETE',undefined,404);
    await a.mover(id,'entrada',1,{validade:data(-1)});
    const vencido = (await a.ficha(id)).lotes[0].id;
    await a.api(`/api/lotes/${vencido}/vencido`,'POST',{}); await a.saldo(id,0);
    assert.equal((await a.ficha(id)).movimentacoes[0].tipo,'perda');
    assert.equal((await a.ficha(id)).movimentacoes[0].quantidade,-(fator||1));
    await a.api(`/api/lotes/${vencido}/vencido`,'POST',{},404);
  }
  for (const metodo of ['PATCH','DELETE','POST']) await a.api(`/api/lotes/999999${metodo==='POST'?'/vencido':''}`,metodo,metodo==='DELETE'?undefined:{},404);
});

test('Validades: limites de dias, hoje, vencidos e baixa coletiva idempotente', async t => {
  const a = await ambiente(t,3998);
  const ids = [await a.produto(),await a.produto({fator:12})];
  for (const id of ids) for (const dias of [-2,-1,0,3,4,null]) await a.mover(id,'entrada',1,{validade:dias===null?null:data(dias)});
  const v = await a.api('/api/validades?dias=3');
  assert.equal(v.hoje,data(0)); assert.equal(v.dias,3);
  assert.deepEqual(v.vencidos.map(l=>l.dias),[-2,-2,-1,-1]);
  assert.deepEqual(v.vencendo.map(l=>l.dias),[0,0,3,3]);
  assert.equal((await a.api('/api/validades?dias=0')).vencendo.length,2);
  assert.equal((await a.api('/api/validades')).dias,7);
  for (const dias of ['-1','366','1.5','abc']) await a.api(`/api/validades?dias=${dias}`,'GET',undefined,400);
  const hojeLote=v.vencendo[0].id; await a.api(`/api/lotes/${hojeLote}/vencido`,'POST',{},400);
  assert.deepEqual(await a.api('/api/vencidos/baixa','POST',{}),{ok:true,lotes:4,produtos:2});
  assert.equal((await a.api('/api/validades')).vencidos.length,0);
  await a.saldo(ids[0],4); await a.saldo(ids[1],48);
  const antes=a.snapshot(); assert.deepEqual(await a.api('/api/vencidos/baixa','POST',{}),{ok:true,lotes:0,produtos:0});
  assert.deepEqual(a.snapshot(),antes);
  assert.deepEqual(a.sql("SELECT quantidade FROM movimentacoes WHERE tipo='perda' ORDER BY quantidade").map(r=>r.quantidade),[-12,-12,-1,-1]);
});

test('Baixa: atomicidade, repetidos, fator, FEFO e validações', async t => {
  const a=await ambiente(t,3999); const p=await a.produto(), q=await a.produto({fator:12,unidade:'cx',unidade_menor:'und'});
  await a.mover(p,'entrada',5,{validade:data(3)}); await a.mover(p,'entrada',5);
  await a.mover(q,'entrada',2,{quantidade_menor:4});
  const antes=a.snapshot();
  const r=await a.api('/api/baixa','POST',{itens:[{produto_id:p,quantidade:2},{produto_id:q,quantidade:3}]},400);
  assert.equal(r.faltando[0].produto_id,q); assert.deepEqual(a.snapshot(),antes);
  await a.api('/api/baixa','POST',{itens:[{produto_id:p,quantidade:6},{produto_id:p,quantidade:6}]},400);
  await a.api('/api/baixa','POST',{itens:[{produto_id:q,quantidade:1,quantidade_menor:3},{produto_id:q,quantidade:1,quantidade_menor:2}]},400);
  for (const itens of [[],null,[null],[{produto_id:999999,quantidade:1}],[{produto_id:p,quantidade:0}],[{produto_id:p,quantidade:-1}],[{produto_id:p,quantidade:'abc'}],Array(501).fill({produto_id:p,quantidade:1})]) await a.api('/api/baixa','POST',{itens},400);
  assert.deepEqual(a.snapshot(),antes);
  const ok=await a.api('/api/baixa','POST',{observacao:'  freezer   manhã ',itens:[{produto_id:p,quantidade:3},{produto_id:p,quantidade:3},{produto_id:q,quantidade:1,quantidade_menor:2}]});
  assert.deepEqual(ok.lancados.map(i=>[i.produto_id,i.lancado,i.estoque_base]),[[p,6,4],[q,14,14]]);
  assert.deepEqual((await a.ficha(p)).lotes.map(l=>[l.validade,l.quantidade]),[[null,4]]);
  assert.deepEqual(a.sql("SELECT tipo,quantidade,observacao FROM movimentacoes WHERE tipo='saida' ORDER BY id"),[-6,-14].map(quantidade=>({tipo:'saida',quantidade,observacao:'freezer manhã'})));
  await a.saldo(p,4); await a.saldo(q,14);
});

test('Listas: CRUD, repetidos, nomes, erros e exclusão de produto em cascata',async t=>{
  const a=await ambiente(t,4000); const p=await a.produto(),q=await a.produto({fator:12});
  const l=await a.api('/api/listas','POST',{nome:'  Freezer   manhã ',itens:[{produto_id:p,quantidade:2},{produto_id:p,quantidade:3},{produto_id:q,quantidade:1,quantidade_menor:2}]},201);
  assert.equal(l.nome,'Freezer manhã'); const url=`/api/listas/${l.id}`;
  assert.equal((await a.api('/api/listas')).find(i=>i.id===l.id).total,2);
  let ficha=await a.api(url); assert.equal(ficha.itens.find(i=>i.produto_id===p).quantidade,5);
  assert.equal(ficha.itens.find(i=>i.produto_id===q).quantidade_menor,2);
  await a.api('/api/listas','POST',{nome:'freezer manhã'},400);
  const outra=await a.api('/api/listas','POST',{nome:'Outra'},201);
  await a.api(url,'PUT',{nome:'outra'},400);
  for (const body of [{nome:''},{nome:'x'.repeat(81)},{nome:'Erro',itens:{}},{nome:'Erro',itens:[{produto_id:999999,quantidade:1}]},{nome:'Erro',itens:[{produto_id:p,quantidade:-1}]}]) await a.api('/api/listas','POST',body,400);
  await a.api(url,'PUT',{nome:'Mudança inválida',itens:[{produto_id:p,quantidade:0}]},400);
  assert.deepEqual(await a.api(url),ficha);
  await a.api(url,'PUT',{nome:'Renomeada'}); assert.deepEqual((await a.api(url)).itens,ficha.itens);
  await a.api(`/api/produtos/${p}`,'DELETE'); ficha=await a.api(url);
  assert.deepEqual(ficha.itens.map(i=>i.produto_id),[q]);
  assert.equal((await a.api('/api/listas')).find(i=>i.id===l.id).total,1);
  assert.equal(a.sql('SELECT * FROM lista_itens WHERE produto_id=?',p).length,0);
  await a.api(url,'PUT',{itens:[{produto_id:q,quantidade_menor:3}]});
  assert.equal((await a.api(url)).itens[0].quantidade_menor,3);
  await a.api(url,'PUT',{itens:[]}); assert.deepEqual((await a.api(url)).itens,[]);
  await a.api(url,'DELETE'); await a.api(`/api/listas/${outra.id}`,'DELETE');
  assert.deepEqual(await a.api('/api/listas'),[]);
  for (const metodo of ['GET','PUT','DELETE']) await a.api(url,metodo,metodo==='PUT'?{}:undefined,404);
});
