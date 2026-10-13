// Contas de estoque usadas por várias rotas (lançamento, validades, baixa, nota fiscal).
const db = require('./db');

// Estoque atual = soma dos lotes; validade em destaque = a que vence primeiro entre os lotes com saldo.
// estoque_base = como está nos lotes (unidade menor, se o produto tem fator);
// estoque = na unidade do produto (cx, fardo…), que é a do mínimo e do Pedir.
const SELECT_PRODUTO = `
  SELECT *, estoque_base * 1.0 / COALESCE(fator, 1) AS estoque FROM (SELECT p.*, e.nome AS empresa,
    COALESCE((SELECT SUM(l.quantidade) FROM lotes l WHERE l.produto_id = p.id), 0) AS estoque_base,
    (SELECT MIN(l.validade) FROM lotes l WHERE l.produto_id = p.id AND l.quantidade > 0 AND l.validade IS NOT NULL) AS validade_proxima
  FROM produtos p LEFT JOIN empresas e ON e.id = p.empresa_id)`;

const arredondar = (n) => Math.round(n * 1000) / 1000;

const buscarProduto = (id) => db.prepare(`${SELECT_PRODUTO} WHERE id = ?`).get(id);

// Quantidade guardada nos lotes → texto: "3 cx + 4 und" com fator, "2,5 kg" sem. (Igual a qtdProduto na tela.)
function formatar(base, p) {
  const n = (v) => v.toLocaleString('pt-BR', { maximumFractionDigits: 3 });
  const comUn = (v, un) => `${n(v)}${un ? ' ' + un : ''}`;
  if (!p.fator) return comUn(base, p.unidade);
  const sinal = base < 0 ? '−' : '';
  const total = Math.abs(base);
  const cheias = Math.floor(arredondar(total / p.fator));
  const soltas = arredondar(total - cheias * p.fator);
  const partes = [cheias ? comUn(cheias, p.unidade) : '', soltas ? comUn(soltas, p.unidade_menor) : ''].filter(Boolean);
  return sinal + (partes.join(' + ') || comUn(0, p.unidade));
}

// Lê "quantidade" (na unidade do produto: cx, fardo…) e "quantidade_menor" (unidades soltas, só com fator)
// e devolve o total na unidade em que os lotes são guardados. { base } ou { erro }.
function lerQuantidade(p, quantidade, quantidadeMenor, casas = 3) {
  const ler = (v) => { const s = String(v ?? '').trim(); return s === '' ? null : Number(s.replace(',', '.')); };
  const [maior, menor] = [ler(quantidade), p.fator ? ler(quantidadeMenor) : null];
  if (maior == null && menor == null) return { erro: 'Informe a quantidade' };
  if ([maior, menor].some((n) => n != null && !(Number.isFinite(n) && n >= 0))) return { erro: 'Quantidade inválida' };
  const escala = 10 ** casas;
  return { base: Math.round(((maior || 0) * (p.fator || 1) + (menor || 0)) * escala) / escala };
}

// Tira quantidade dos lotes, primeiro os que vencem antes (sem validade por último).
function consumirLotes(produtoId, quantidade) {
  let falta = quantidade;
  const lotes = db.prepare(`SELECT id, quantidade FROM lotes WHERE produto_id = ? AND quantidade > 0
    ORDER BY validade IS NULL, validade, id`).all(produtoId);
  const atualizar = db.prepare('UPDATE lotes SET quantidade = ? WHERE id = ?');
  for (const l of lotes) {
    if (falta <= 0) break;
    const tirar = Math.min(l.quantidade, falta);
    atualizar.run(arredondar(l.quantidade - tirar), l.id);
    falta = arredondar(falta - tirar);
  }
}

const novoLote = (produtoId, quantidade, validade, custoUnit = null, notaId = null) =>
  Number(db.prepare('INSERT INTO lotes (produto_id, quantidade, validade, custo_unit, nota_id) VALUES (?,?,?,?,?)')
    .run(produtoId, quantidade, validade, custoUnit, notaId).lastInsertRowid);

// Em movimentacoes a quantidade fica com sinal: entrada +, saída e perda −, ajuste e correção = diferença.
const registrar = (produtoId, tipo, quantidade, observacao = null, notaId = null) =>
  db.prepare('INSERT INTO movimentacoes (produto_id, tipo, quantidade, observacao, nota_id) VALUES (?,?,?,?,?)')
    .run(produtoId, tipo, quantidade, observacao, notaId);

// Roda fn dentro de uma transação: tudo ou nada.
function transacao(fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

const hoje = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

module.exports = {
  SELECT_PRODUTO, arredondar, buscarProduto, formatar, lerQuantidade, consumirLotes, novoLote, registrar, transacao, hoje,
};
