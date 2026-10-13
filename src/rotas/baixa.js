// Rotas de baixa: baixa de vários produtos de uma vez e listas prontas (ex.: abastecimento do freezer).
// Baixa = abastecimento dos freezers / consumo interno (não é venda): vira movimentação "saida" com quantidade negativa.
const db = require('../db');
const { SELECT_PRODUTO, arredondar, buscarProduto, formatar, lerQuantidade, consumirLotes, registrar, transacao } = require('../estoque');

const textoLimpo = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
const lerNumero = (v) => { const s = String(v ?? '').trim(); return s === '' ? null : Number(s.replace(',', '.')); };

// Confere os itens (produto existe, quantidade > 0) e soma os repetidos.
// Devolve { itens: [{ p, base, quantidade, quantidade_menor }] } ou { erro }.
function lerItens(lista) {
  if (!Array.isArray(lista) || !lista.length) return { erro: 'Nenhum produto na lista' };
  if (lista.length > 500) return { erro: 'Produtos demais de uma vez' };
  const porProduto = new Map();
  for (const item of lista) {
    const id = Number(item?.produto_id);
    const p = Number.isInteger(id) ? buscarProduto(id) : null;
    if (!p) return { erro: `Produto não encontrado (código ${textoLimpo(item?.produto_id) || 'vazio'})` };
    const { base, erro } = lerQuantidade(p, item.quantidade, item.quantidade_menor);
    if (erro) return { erro: `${p.nome}: ${erro}` };
    if (!(base > 0)) return { erro: `${p.nome}: a quantidade precisa ser maior que zero` };
    const maior = lerNumero(item.quantidade) || 0;
    const menor = p.fator ? lerNumero(item.quantidade_menor) || 0 : 0;
    const junto = porProduto.get(p.id);
    if (junto) {
      junto.base = arredondar(junto.base + base);
      junto.quantidade = arredondar(junto.quantidade + maior);
      junto.quantidade_menor = arredondar(junto.quantidade_menor + menor);
    } else {
      porProduto.set(p.id, { p, base, quantidade: maior, quantidade_menor: menor });
    }
  }
  return { itens: [...porProduto.values()] };
}

// Itens de uma lista, com os dados do produto (produto excluído some sozinho: ON DELETE CASCADE e JOIN).
const itensDaLista = (listaId) => db.prepare(`
  SELECT li.produto_id, li.quantidade, li.quantidade_menor, p.nome, p.unidade, p.fator, p.unidade_menor, p.ativo, p.estoque_base
  FROM lista_itens li JOIN (${SELECT_PRODUTO}) p ON p.id = li.produto_id
  WHERE li.lista_id = ? ORDER BY p.nome COLLATE NOCASE`).all(listaId);

function lerNomeLista(nome, idAtual = 0) {
  const n = textoLimpo(nome);
  if (!n) return { erro: 'Informe o nome da lista' };
  if (n.length > 80) return { erro: 'Nome da lista muito comprido' };
  if (db.prepare('SELECT 1 FROM listas WHERE nome = ? AND id <> ?').get(n, idAtual)) return { erro: `Já existe uma lista "${n}"` };
  return { nome: n };
}

// Itens de uma lista pronta: pode vir vazio (lista sem produtos). Sem "itens" no corpo = não mexe ({ itens: null }).
function lerItensDaLista(lista) {
  if (lista === undefined) return { itens: null };
  if (!Array.isArray(lista)) return { erro: 'Itens inválidos' };
  return lista.length ? lerItens(lista) : { itens: [] };
}

function gravarItens(listaId, itens) {
  db.prepare('DELETE FROM lista_itens WHERE lista_id = ?').run(listaId);
  const inserir = db.prepare('INSERT INTO lista_itens (lista_id, produto_id, quantidade, quantidade_menor) VALUES (?,?,?,?)');
  for (const i of itens) inserir.run(listaId, i.p.id, i.quantidade || null, i.quantidade_menor || null);
}

module.exports = function (app) {
  // Baixa de vários produtos de uma vez: confere tudo antes; se algum não tem estoque, nada é lançado.
  app.post('/api/baixa', (req, res) => {
    const { itens, erro } = lerItens(req.body?.itens);
    if (erro) return res.status(400).json({ erro });
    const observacao = textoLimpo(req.body.observacao).slice(0, 300) || null;

    const faltando = itens.filter((i) => i.base > arredondar(i.p.estoque_base)).map((i) => ({
      produto_id: i.p.id, nome: i.p.nome, pedido: formatar(i.base, i.p), tem: formatar(arredondar(i.p.estoque_base), i.p),
    }));
    if (faltando.length) {
      const lista = faltando.map((f) => `${f.nome} (pediu ${f.pedido}, tem ${f.tem})`).join('; ');
      return res.status(400).json({ erro: `Nada foi lançado. Estoque não dá para: ${lista}`, faltando });
    }

    transacao(() => {
      for (const i of itens) {
        consumirLotes(i.p.id, i.base);
        registrar(i.p.id, 'saida', -i.base, observacao);
      }
    });
    const lancados = itens.map((i) => ({
      produto_id: i.p.id, nome: i.p.nome, lancado: i.base, estoque_base: arredondar(buscarProduto(i.p.id).estoque_base),
    }));
    res.json({ ok: true, lancados });
  });

  // ---------- listas prontas ----------
  app.get('/api/listas', (req, res) => {
    res.json(db.prepare(`SELECT l.id, l.nome,
      (SELECT COUNT(*) FROM lista_itens li JOIN produtos p ON p.id = li.produto_id WHERE li.lista_id = l.id) AS total
      FROM listas l ORDER BY l.nome COLLATE NOCASE`).all());
  });

  app.post('/api/listas', (req, res) => {
    const { nome, erro } = lerNomeLista(req.body?.nome);
    if (erro) return res.status(400).json({ erro });
    const lidos = lerItensDaLista(req.body.itens);
    if (lidos.erro) return res.status(400).json({ erro: lidos.erro });
    const id = transacao(() => {
      const novo = Number(db.prepare('INSERT INTO listas (nome) VALUES (?)').run(nome).lastInsertRowid);
      gravarItens(novo, lidos.itens || []);
      return novo;
    });
    res.status(201).json({ id, nome });
  });

  app.get('/api/listas/:id', (req, res) => {
    const lista = db.prepare('SELECT id, nome FROM listas WHERE id = ?').get(req.params.id);
    if (!lista) return res.status(404).json({ erro: 'Lista não encontrada' });
    res.json({ ...lista, itens: itensDaLista(lista.id) });
  });

  // Muda o nome e/ou troca todos os itens da lista (o que vier em "itens" substitui o que tinha).
  app.put('/api/listas/:id', (req, res) => {
    const lista = db.prepare('SELECT id, nome FROM listas WHERE id = ?').get(req.params.id);
    if (!lista) return res.status(404).json({ erro: 'Lista não encontrada' });
    let nome = lista.nome;
    if (req.body?.nome !== undefined) {
      const r = lerNomeLista(req.body.nome, lista.id);
      if (r.erro) return res.status(400).json({ erro: r.erro });
      nome = r.nome;
    }
    const lidos = lerItensDaLista(req.body?.itens);
    if (lidos.erro) return res.status(400).json({ erro: lidos.erro });
    const { itens } = lidos;
    transacao(() => {
      db.prepare('UPDATE listas SET nome = ? WHERE id = ?').run(nome, lista.id);
      if (itens) gravarItens(lista.id, itens);
    });
    res.json({ id: lista.id, nome, itens: itensDaLista(lista.id) });
  });

  app.delete('/api/listas/:id', (req, res) => {
    const r = db.prepare('DELETE FROM listas WHERE id = ?').run(req.params.id);
    if (!r.changes) return res.status(404).json({ erro: 'Lista não encontrada' });
    res.json({ ok: true });
  });
};
