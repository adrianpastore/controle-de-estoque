// Contagem do estoque (pente fino): o estoquista escreve "produto  quantidade" numa lista,
// o sistema acha cada produto (e a empresa dele) e, depois da conferência na tela, ajusta o estoque de todos de uma vez.
// Produto que não está na lista não muda. Antes de gravar, faz backup do banco em dados/backup/.
const db = require('../db');
const { SELECT_PRODUTO, arredondar, buscarProduto, formatar, lerQuantidade, ajustarPara, transacao } = require('../estoque');
const { conferir } = require('../contagem');

const textoLimpo = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
const resumo = (p) => ({
  id: p.id, nome: p.nome, empresa: p.empresa, unidade: p.unidade, fator: p.fator, unidade_menor: p.unidade_menor,
  estoque_base: arredondar(p.estoque_base), ativo: p.ativo,
});

module.exports = function (app) {
  // Lê o texto e devolve o que entendeu de cada linha. Não grava nada.
  app.post('/api/contagem/conferir', (req, res) => {
    const texto = String(req.body?.texto ?? '');
    if (!texto.trim()) return res.status(400).json({ erro: 'Escreva ou cole a contagem' });
    if (texto.split('\n').length > 2000) return res.status(400).json({ erro: 'Linhas demais de uma vez (máximo 2000)' });
    const produtos = db.prepare(`${SELECT_PRODUTO} ORDER BY nome COLLATE NOCASE`).all();
    const linhas = conferir(texto, produtos).map((l) => ({
      ...l, produto: l.produto && resumo(l.produto), sugestoes: l.sugestoes.map(resumo),
    }));
    res.json({ linhas });
  });

  // Aplica a contagem: cada produto passa a ter a quantidade contada (ajuste). Tudo ou nada.
  // itens: [{ produto_id, quantidade, quantidade_menor }]. O mesmo produto em duas linhas soma (contado em dois lugares).
  app.post('/api/contagem/aplicar', (req, res) => {
    const operacaoId = typeof req.body?.operacao_id === 'string' ? req.body.operacao_id.trim() : '';
    const anterior = operacaoId && db.prepare('SELECT resposta FROM operacoes WHERE id = ?').get(operacaoId);
    if (anterior) return res.json(JSON.parse(anterior.resposta));

    const lista = req.body?.itens;
    if (!Array.isArray(lista) || !lista.length) return res.status(400).json({ erro: 'Nenhum produto na contagem' });
    if (lista.length > 2000) return res.status(400).json({ erro: 'Produtos demais de uma vez' });
    const porProduto = new Map();
    for (const item of lista) {
      const id = Number(item?.produto_id);
      const p = Number.isInteger(id) ? buscarProduto(id) : null;
      if (!p) return res.status(400).json({ erro: `Produto não encontrado (código ${textoLimpo(item?.produto_id) || 'vazio'})` });
      const { base, erro } = lerQuantidade(p, item.quantidade, item.quantidade_menor);
      if (erro) return res.status(400).json({ erro: `${p.nome}: ${erro}` });
      porProduto.set(p.id, arredondar((porProduto.get(p.id) || 0) + base));
    }
    const observacao = textoLimpo(req.body.observacao).slice(0, 300) || 'contagem';

    const backup = db.backupAntes('contagem');
    const resposta = transacao(() => {
      const ajustados = [];
      for (const [id, contado] of porProduto) {
        const p = buscarProduto(id);
        const antes = arredondar(p.estoque_base);
        const diferenca = ajustarPara(p, contado, null, observacao);
        ajustados.push({ produto_id: id, nome: p.nome, empresa: p.empresa, antes: formatar(antes, p), agora: formatar(contado, p), diferenca });
      }
      const r = { ok: true, ajustados, mudaram: ajustados.filter((a) => a.diferenca !== 0).length, backup: backup.split(/[\\/]/).pop() };
      if (operacaoId) db.prepare('INSERT INTO operacoes (id, resposta) VALUES (?, ?)').run(operacaoId, JSON.stringify(r));
      return r;
    });
    res.json(resposta);
  });
};
