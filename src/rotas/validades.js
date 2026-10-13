// Validades: corrigir ou excluir um lote lançado errado e dar baixa em vencidos como perda.
// Lotes guardam a quantidade na unidade menor (se o produto tem fator); o texto sai de formatar.
const db = require('../db');
const { arredondar, buscarProduto, formatar, lerQuantidade, registrar, transacao, hoje } = require('../estoque');

// AAAA-MM-DD → dd/mm/aaaa (para as observações do histórico)
const dataBr = (d) => (d ? d.split('-').reverse().join('/') : '(sem)');
// "lote de val. 10/10/2026" ou "lote sem validade"
const nomeLote = (v) => (v ? `lote de val. ${dataBr(v)}` : 'lote sem validade');

// Data AAAA-MM-DD que existe de verdade (não aceita 2026-02-30).
function dataValida(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [a, m, d] = s.split('-').map(Number);
  const t = new Date(Date.UTC(a, m - 1, d));
  return t.getUTCFullYear() === a && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

// Dias de hoje até a validade (negativo = já venceu).
const diasAte = (validade) => Math.round((Date.parse(validade) - Date.parse(hoje())) / 86400000);

// Lote com saldo + o produto dele. Lote zerado conta como não encontrado (não aparece na tela).
function buscarLote(id) {
  const lote = db.prepare('SELECT * FROM lotes WHERE id = ? AND quantidade > 0').get(id);
  return lote ? { lote, p: buscarProduto(lote.produto_id) } : {};
}

// Baixa de um lote vencido: zera o lote e registra a perda (quantidade negativa).
function baixarVencido(lote) {
  db.prepare('UPDATE lotes SET quantidade = 0 WHERE id = ?').run(lote.id);
  registrar(lote.produto_id, 'perda', -lote.quantidade, `vencido em ${dataBr(lote.validade)}`);
}

const SELECT_LOTES_COM_VALIDADE = `
  SELECT l.id, l.produto_id, l.quantidade, l.validade, p.nome, p.unidade, p.fator, p.unidade_menor, e.nome AS empresa
  FROM lotes l JOIN produtos p ON p.id = l.produto_id LEFT JOIN empresas e ON e.id = p.empresa_id
  WHERE l.quantidade > 0 AND l.validade IS NOT NULL`;

module.exports = function (app) {
  // Lotes vencidos (validade antes de hoje) e os que vencem de hoje até daqui a N dias.
  app.get('/api/validades', (req, res) => {
    const dias = req.query.dias == null || req.query.dias === '' ? 7 : Number(req.query.dias);
    if (!Number.isInteger(dias) || dias < 0 || dias > 365) return res.status(400).json({ erro: 'Número de dias inválido' });
    const hojeTxt = hoje();
    const ate = new Date(Date.parse(hojeTxt) + dias * 86400000).toISOString().slice(0, 10);
    const ordem = ' ORDER BY l.validade, p.nome COLLATE NOCASE, l.id';
    const comDias = (l) => ({ ...l, dias: diasAte(l.validade) });
    const vencidos = db.prepare(`${SELECT_LOTES_COM_VALIDADE} AND l.validade < ?${ordem}`).all(hojeTxt).map(comDias);
    const vencendo = db.prepare(`${SELECT_LOTES_COM_VALIDADE} AND l.validade >= ? AND l.validade <= ?${ordem}`)
      .all(hojeTxt, ate).map(comDias);
    res.json({ hoje: hojeTxt, dias, vencidos, vencendo });
  });

  // Corrige a validade e/ou a quantidade de um lote. Validade vazia = sem validade.
  // Quantidade como no lançamento: "quantidade" (cx, fardo…) + "quantidade_menor" (soltas, só com fator).
  app.patch('/api/lotes/:id', (req, res) => {
    const { lote, p } = buscarLote(req.params.id);
    if (!lote) return res.status(404).json({ erro: 'Lote não encontrado' });
    const body = req.body || {};

    let validade = lote.validade;
    if ('validade' in body) {
      validade = body.validade == null ? '' : String(body.validade).trim();
      if (validade === '') validade = null;
      else if (!dataValida(validade)) return res.status(400).json({ erro: 'Validade inválida' });
    }

    let quantidade = lote.quantidade;
    const vazio = (v) => v == null || String(v).trim() === '';
    if (!vazio(body.quantidade) || (p.fator && !vazio(body.quantidade_menor))) {
      const r = lerQuantidade(p, body.quantidade, body.quantidade_menor, 6);
      if (r.erro) return res.status(400).json({ erro: r.erro });
      if (r.base <= 0) return res.status(400).json({ erro: 'A quantidade precisa ser maior que zero. Para tirar o lote, use Excluir.' });
      quantidade = r.base;
    }

    quantidade = Math.round(quantidade * 1e6) / 1e6;
    const diferenca = Math.round((quantidade - lote.quantidade) * 1e6) / 1e6;
    const mudouQuantidade = Math.abs(diferenca) >= 1e-6;
    const mudouValidade = validade !== lote.validade;
    if (!mudouQuantidade && !mudouValidade) return res.json({ ok: true, mudou: false });

    const partes = [];
    if (mudouQuantidade) partes.push(`${nomeLote(lote.validade)} corrigido: ${formatar(lote.quantidade, p)} → ${formatar(quantidade, p)}`);
    if (mudouValidade) partes.push(`validade ${dataBr(lote.validade)} → ${dataBr(validade)}`);
    transacao(() => {
      db.prepare('UPDATE lotes SET quantidade = ?, validade = ? WHERE id = ?').run(quantidade, validade, lote.id);
      registrar(p.id, 'correcao', diferenca, partes.join('; '));
    });
    res.json({ ok: true, mudou: true });
  });

  // Exclui um lote lançado errado: o saldo dele sai do estoque como correção.
  app.delete('/api/lotes/:id', (req, res) => {
    const { lote, p } = buscarLote(req.params.id);
    if (!lote) return res.status(404).json({ erro: 'Lote não encontrado' });
    transacao(() => {
      db.prepare('DELETE FROM lotes WHERE id = ?').run(lote.id);
      registrar(p.id, 'correcao', -lote.quantidade, `${nomeLote(lote.validade)} excluído (tinha ${formatar(lote.quantidade, p)})`);
    });
    res.json({ ok: true });
  });

  // Baixa de um lote vencido como perda.
  app.post('/api/lotes/:id/vencido', (req, res) => {
    const { lote } = buscarLote(req.params.id);
    if (!lote) return res.status(404).json({ erro: 'Lote não encontrado' });
    if (!lote.validade || lote.validade >= hoje()) return res.status(400).json({ erro: 'Este lote ainda não venceu' });
    transacao(() => baixarVencido(lote));
    res.json({ ok: true });
  });

  // Baixa em todos os lotes vencidos de uma vez (tudo ou nada).
  app.post('/api/vencidos/baixa', (req, res) => {
    const lotes = db.prepare('SELECT * FROM lotes WHERE quantidade > 0 AND validade IS NOT NULL AND validade < ?').all(hoje());
    transacao(() => lotes.forEach(baixarVencido));
    res.json({ ok: true, lotes: lotes.length, produtos: new Set(lotes.map((l) => l.produto_id)).size });
  });
};
