// Teste de ponta a ponta da entrada pela nota: sobe o servidor com um banco NOVO e vazio numa pasta temporária
// (nunca o dados/estoque.db), importa as notas de exemplo de tests/fixtures, confere, lança e lança de novo.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const PORTA = 3900 + Math.floor(Math.random() * 90);
const URL_BASE = `http://127.0.0.1:${PORTA}`;
const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'nfe-api-'));
const fixture = (nome) => fs.readFileSync(path.join(__dirname, 'fixtures', nome));
let servidor;

async function chamar(metodo, url, corpo, tipo = 'application/json') {
  const r = await fetch(URL_BASE + url, {
    method: metodo,
    headers: corpo === undefined ? {} : { 'Content-Type': tipo },
    body: corpo === undefined ? undefined : tipo === 'application/json' ? JSON.stringify(corpo) : corpo,
  });
  return { status: r.status, corpo: await r.json().catch(() => null) };
}

test.before(async () => {
  servidor = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, BANCO: path.join(pasta, 'teste.db'), PORTA: String(PORTA), CONFIG_SEFAZ: path.join(pasta, 'sem-config.json') },
    stdio: 'ignore',
  });
  for (let i = 0; i < 100; i++) {
    try { await fetch(`${URL_BASE}/api/nfe/notas`); return; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error('O servidor de teste não subiu');
});
test.after(() => servidor?.kill());

test('importar, conferir, lançar e lembrar na próxima nota', async () => {
  // produtos do estoque: leite em cx de 12 und (fator), creme de leite com código de barras, cx de 27 und
  const emp = (await chamar('POST', '/api/empresas', { nome: 'Lactalis' })).corpo;
  const leite = (await chamar('POST', '/api/produtos', { nome: 'leite elege integral', unidade: 'cx', fator: 12, unidade_menor: 'und', empresa_id: emp.id, em_falta: true })).corpo.id;
  const creme = (await chamar('POST', '/api/produtos', { nome: 'creme de leite', unidade: 'cx', fator: 27, unidade_menor: 'und', codigo_barras: '7896000000017' })).corpo.id;

  // importar o XML (bytes, como o navegador manda)
  let r = await chamar('POST', '/api/nfe/importar', fixture('nota-lactalis-1.xml'), 'application/xml');
  assert.strictEqual(r.status, 201);
  const nota1 = r.corpo.id;
  r = await chamar('POST', '/api/nfe/importar', fixture('nota-lactalis-1.xml'), 'application/xml');
  assert.deepStrictEqual([r.status, r.corpo.id, r.corpo.nova, r.corpo.status], [200, nota1, false, 'pendente'], 'mesma chave abre a mesma nota');
  r = await chamar('POST', '/api/nfe/importar', Buffer.from('<html></html>'), 'application/xml');
  assert.strictEqual(r.status, 400);

  // conferência: sugestões
  r = await chamar('GET', `/api/nfe/notas/${nota1}`);
  assert.strictEqual(r.corpo.emitente_nome, 'LACTALIS TESTE COMERCIO DE LATICINIOS LTDA');
  assert.strictEqual(r.corpo.empresa_sugerida, emp.id, 'empresa sugerida pelo nome do fornecedor');
  assert.strictEqual(r.corpo.xml, undefined, 'não manda o XML inteiro para a tela');
  const [i1, i2, i3] = r.corpo.itens;
  assert.strictEqual(i1.sugestao.acao, null);
  assert.deepStrictEqual([i2.sugestao.acao, i2.sugestao.origem, i2.sugestao.produto.id, i2.sugestao.multiplicador], ['produto', 'ean', creme, 1]);
  assert.strictEqual(i2.validade, '2027-01-15');
  assert.strictEqual(i3.descricao, 'QUEIJO MUSSARELA & PRATO FATIADO KG');

  // faltou escolher um item → não lança nada
  r = await chamar('POST', `/api/nfe/notas/${nota1}/lancar`, { itens: [{ n: 1, acao: 'produto', produto_id: leite, multiplicador: 12 }] });
  assert.strictEqual(r.status, 400);
  assert.match(r.corpo.erro, /Item 2/);

  const escolhas = [
    { n: 1, acao: 'produto', produto_id: leite, multiplicador: 12, validade: '2026-12-01' }, // 1 CX da nota = 12 und
    { n: 2, acao: 'produto', produto_id: creme, multiplicador: '1', validade: '2027-01-15' },
    { n: 3, acao: 'novo', multiplicador: 1, novo: { nome: 'Queijo mussarela fatiado', unidade: 'KG', empresa_id: emp.id } },
    { n: 4, acao: 'ignorar' },
  ];
  r = await chamar('POST', `/api/nfe/notas/${nota1}/lancar`, { itens: escolhas });
  assert.deepStrictEqual(r.corpo, { ok: true, lancados: 3, ignorados: 1 });

  const pLeite = (await chamar('GET', `/api/produtos/${leite}`)).corpo;
  assert.strictEqual(pLeite.estoque_base, 36, '3 CX × 12 = 36 und');
  assert.strictEqual(pLeite.estoque, 3);
  assert.strictEqual(pLeite.em_falta, 0, 'chegou: tira a marca de pedir');
  assert.strictEqual(pLeite.lotes[0].custo_unit, 4.99, 'R$ 59,88 a caixa = R$ 4,99 a unidade');
  assert.strictEqual(pLeite.lotes[0].nota_id, nota1);
  assert.strictEqual(pLeite.lotes[0].validade, '2026-12-01');
  assert.strictEqual(pLeite.movimentacoes[0].tipo, 'entrada');
  assert.strictEqual(pLeite.movimentacoes[0].nota_id, nota1);
  assert.strictEqual(pLeite.movimentacoes[0].observacao, 'NF 45871 – LACTALIS TESTE COMERCIO DE LATICINIOS LTDA');
  const pCreme = (await chamar('GET', `/api/produtos/${creme}`)).corpo;
  assert.strictEqual(pCreme.estoque_base, 27);
  assert.strictEqual(pCreme.estoque, 1, '27 und = 1 cx');
  const novos = (await chamar('GET', '/api/produtos?busca=queijo mussarela')).corpo;
  assert.strictEqual(novos.length, 1);
  assert.deepStrictEqual([novos[0].unidade, novos[0].empresa_id, novos[0].estoque_base], ['kg', emp.id, 4.25]);

  // a mesma nota não entra duas vezes
  r = await chamar('POST', `/api/nfe/notas/${nota1}/lancar`, { itens: escolhas });
  assert.strictEqual(r.status, 409);
  r = await chamar('POST', '/api/nfe/importar', fixture('nota-lactalis-1.xml'), 'application/xml');
  assert.deepStrictEqual([r.corpo.id, r.corpo.status], [nota1, 'lancada']);
  r = await chamar('DELETE', `/api/nfe/notas/${nota1}`);
  assert.strictEqual(r.status, 409);
  r = await chamar('GET', `/api/nfe/notas/${nota1}`);
  assert.strictEqual(r.corpo.lancamentos.length, 3);

  // segunda nota do mesmo fornecedor (NFe sem nfeProc): tudo já vem associado
  r = await chamar('POST', '/api/nfe/importar', fixture('nota-lactalis-2.xml'), 'application/xml');
  const nota2 = r.corpo.id;
  r = await chamar('GET', `/api/nfe/notas/${nota2}`);
  const s = r.corpo.itens.map((it) => it.sugestao);
  assert.deepStrictEqual(s.map((x) => [x.acao, x.origem, x.produto?.id ?? null, x.multiplicador ?? null]),
    [['produto', 'lembrada', leite, 12], ['produto', 'lembrada', novos[0].id, 1], ['ignorar', 'lembrada', null, null]]);
  r = await chamar('POST', `/api/nfe/notas/${nota2}/lancar`, {
    itens: r.corpo.itens.map((it) => ({ n: it.n, acao: it.sugestao.acao, produto_id: it.sugestao.produto?.id, multiplicador: it.sugestao.multiplicador })),
  });
  assert.strictEqual(r.corpo.lancados, 2);
  assert.strictEqual((await chamar('GET', `/api/produtos/${leite}`)).corpo.estoque_base, 60, '36 + 2 CX × 12');

  // lista: pendentes primeiro
  await chamar('POST', '/api/nfe/importar', fixture('nota-fritz-iso.xml'), 'application/xml');
  const lista = (await chamar('GET', '/api/nfe/notas')).corpo;
  assert.deepStrictEqual(lista.map((n) => n.status), ['pendente', 'lancada', 'lancada']);
  assert.strictEqual(lista[0].itens, 1);
  const fritz = (await chamar('GET', `/api/nfe/notas/${lista[0].id}`)).corpo;
  assert.strictEqual(fritz.itens[0].descricao, 'PÃO DE QUEIJO CONGELADO 1KG FD C/10', 'XML em ISO-8859-1 com acento');
  r = await chamar('DELETE', `/api/nfe/notas/${lista[0].id}`);
  assert.strictEqual(r.status, 200, 'nota pendente pode ser apagada');
});

test('chave digitada ou lida da foto', async () => {
  let r = await chamar('POST', '/api/nfe/chave', { chave: '4326 1011 2223 3300 0181 5500 1000 0458 7111 2345 6789' });
  assert.strictEqual(r.status, 400, 'dígito verificador errado');
  r = await chamar('POST', '/api/nfe/chave', { chave: '4326 1011 2223 3300 0181 5500 1000 0458 7111 2345 6788' });
  assert.deepStrictEqual([r.status, r.corpo.status], [200, 'lancada'], 'nota já importada: abre');
  r = await chamar('POST', '/api/nfe/chave', { chave: '43261044555666000172550020000012041556677880' });
  assert.strictEqual(r.status, 404);
  assert.strictEqual(r.corpo.sem_config, true, 'sem certificado: avisa para importar o XML');
  r = await chamar('GET', '/api/sefaz/status');
  assert.deepStrictEqual([r.corpo.configurado, r.corpo.sem_config], [false, true]);
  r = await chamar('GET', '/api/nfe/notas/99999');
  assert.strictEqual(r.status, 404);
});
