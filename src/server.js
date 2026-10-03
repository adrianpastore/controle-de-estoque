const os = require('node:os');
const path = require('node:path');
const express = require('express');
const db = require('./db');

const PORTA = Number(process.env.PORTA) || 3000;
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// Estoque atual = soma dos lotes; validade em destaque = a que vence primeiro entre os lotes com saldo.
const SELECT_PRODUTO = `
  SELECT p.*, e.nome AS empresa,
    COALESCE((SELECT SUM(l.quantidade) FROM lotes l WHERE l.produto_id = p.id), 0) AS estoque,
    (SELECT MIN(l.validade) FROM lotes l WHERE l.produto_id = p.id AND l.quantidade > 0 AND l.validade IS NOT NULL) AS validade_proxima
  FROM produtos p LEFT JOIN empresas e ON e.id = p.empresa_id`;

const FILTROS = {
  todos: 'ativo = 1',
  // automático quando o estoque fica abaixo do mínimo (como na planilha: pedir = mínimo − contagem),
  // ou marcado à mão (produtos sem mínimo / casos especiais)
  pedir: 'ativo = 1 AND (em_falta = 1 OR (nao_contado = 0 AND estoque_minimo IS NOT NULL AND estoque < estoque_minimo))',
  revisar: 'precisa_revisao = 1',
  inativos: 'ativo = 0',
  estoque: "ativo = 1 AND secao = 'Estoque'",
  frente: "ativo = 1 AND secao LIKE 'Frente%'",
};

// Aba da tela: id da empresa, "sem" (produtos sem empresa) ou qualquer outra coisa = todas.
function condicaoEmpresa(valor) {
  if (valor === 'sem') return { sql: ' AND empresa_id IS NULL', params: [] };
  if (/^\d+$/.test(String(valor))) return { sql: ' AND empresa_id = ?', params: [Number(valor)] };
  return { sql: '', params: [] };
}

const semAcento = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

app.get('/api/produtos', (req, res) => {
  const filtro = FILTROS[req.query.filtro] || FILTROS.todos;
  const emp = condicaoEmpresa(req.query.empresa);
  let lista = db.prepare(`SELECT * FROM (${SELECT_PRODUTO}) WHERE ${filtro}${emp.sql} ORDER BY nome COLLATE NOCASE`).all(...emp.params);
  const busca = semAcento(String(req.query.busca || '').trim());
  if (busca) {
    // cada palavra digitada precisa aparecer no nome, fornecedor ou código de barras
    const termos = busca.split(/\s+/);
    lista = lista.filter((p) => {
      const alvo = semAcento(`${p.nome} ${p.fornecedor || ''} ${p.codigo_barras || ''}`);
      return termos.every((t) => alvo.includes(t));
    });
  }
  res.json(lista);
});

app.get('/api/resumo', (req, res) => {
  const emp = condicaoEmpresa(req.query.empresa);
  const contar = (f) => db.prepare(`SELECT COUNT(*) n FROM (${SELECT_PRODUTO}) WHERE ${f}${emp.sql}`).get(...emp.params).n;
  res.json(Object.fromEntries(Object.entries(FILTROS).map(([k, f]) => [k, contar(f)])));
});

// Abas: cada empresa com quantos produtos ativos tem e quantos estão para pedir, mais os sem empresa.
app.get('/api/empresas', (req, res) => {
  const pedir = new Map(db.prepare(`SELECT empresa_id, COUNT(*) n FROM (${SELECT_PRODUTO})
    WHERE ${FILTROS.pedir} AND empresa_id IS NOT NULL GROUP BY empresa_id`).all().map((r) => [r.empresa_id, r.n]));
  const empresas = db.prepare(`SELECT e.id, e.nome,
    (SELECT COUNT(*) FROM produtos p WHERE p.empresa_id = e.id AND p.ativo = 1) AS total
    FROM empresas e ORDER BY total DESC, e.nome COLLATE NOCASE`).all()
    .map((e) => ({ ...e, pedir: pedir.get(e.id) || 0 }));
  const sem = db.prepare('SELECT COUNT(*) n FROM produtos WHERE empresa_id IS NULL AND ativo = 1').get().n;
  const todas = db.prepare('SELECT COUNT(*) n FROM produtos WHERE ativo = 1').get().n;
  res.json({ empresas, sem, todas });
});

app.post('/api/empresas', (req, res) => {
  const nome = String(req.body.nome || '').replace(/\s+/g, ' ').trim();
  if (!nome) return res.status(400).json({ erro: 'Informe o nome da empresa' });
  db.prepare('INSERT OR IGNORE INTO empresas (nome) VALUES (?)').run(nome);
  res.status(201).json(db.prepare('SELECT id, nome FROM empresas WHERE nome = ?').get(nome));
});

app.get('/api/opcoes', (req, res) => {
  const col = (c) => db.prepare(`SELECT DISTINCT ${c} v FROM produtos WHERE ${c} IS NOT NULL AND ${c} <> '' ORDER BY ${c} COLLATE NOCASE`).all().map((r) => r.v);
  res.json({ unidades: col('unidade'), secoes: col('secao'), fornecedores: col('fornecedor') });
});

app.get('/api/produtos/:id', (req, res) => {
  const p = db.prepare(`${SELECT_PRODUTO} WHERE p.id = ?`).get(req.params.id);
  if (!p) return res.status(404).json({ erro: 'Produto não encontrado' });
  p.lotes = db.prepare(`SELECT * FROM lotes WHERE produto_id = ? AND quantidade > 0
    ORDER BY validade IS NULL, validade, criado_em`).all(p.id);
  p.movimentacoes = db.prepare('SELECT * FROM movimentacoes WHERE produto_id = ? ORDER BY id DESC LIMIT 30').all(p.id);
  res.json(p);
});

function dadosDoProduto(body) {
  const txt = (v) => (v == null || String(v).trim() === '' ? null : String(v).trim());
  const num = (v) => (v == null || v === '' ? null : Number(String(v).replace(',', '.')));
  const d = {
    nome: txt(body.nome),
    unidade: txt(body.unidade),
    estoque_minimo: num(body.estoque_minimo),
    fornecedor: txt(body.fornecedor),
    secao: txt(body.secao) || 'Estoque',
    empresa_id: num(body.empresa_id),
    codigo_barras: txt(body.codigo_barras),
    ativo: body.ativo ? 1 : 0,
    em_falta: body.em_falta ? 1 : 0,
    nao_contado: body.nao_contado ? 1 : 0,
    precisa_revisao: body.precisa_revisao ? 1 : 0,
    observacao: txt(body.observacao),
  };
  if (!d.nome) return { erro: 'O nome é obrigatório' };
  if (d.estoque_minimo != null && !(d.estoque_minimo >= 0)) return { erro: 'Estoque mínimo inválido' };
  if (d.empresa_id != null && !db.prepare('SELECT 1 FROM empresas WHERE id = ?').get(d.empresa_id)) return { erro: 'Empresa não encontrada' };
  return { d };
}

app.post('/api/produtos', (req, res) => {
  const { d, erro } = dadosDoProduto({ ativo: true, ...req.body });
  if (erro) return res.status(400).json({ erro });
  const r = db.prepare(`INSERT INTO produtos (nome, unidade, estoque_minimo, fornecedor, secao, empresa_id, codigo_barras,
    ativo, em_falta, nao_contado, precisa_revisao, observacao) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(...Object.values(d));
  res.status(201).json({ id: Number(r.lastInsertRowid) });
});

app.put('/api/produtos/:id', (req, res) => {
  const { d, erro } = dadosDoProduto(req.body);
  if (erro) return res.status(400).json({ erro });
  const r = db.prepare(`UPDATE produtos SET nome=?, unidade=?, estoque_minimo=?, fornecedor=?, secao=?,
    empresa_id=?, codigo_barras=?, ativo=?, em_falta=?, nao_contado=?, precisa_revisao=?, observacao=? WHERE id=?`)
    .run(...Object.values(d), req.params.id);
  if (!r.changes) return res.status(404).json({ erro: 'Produto não encontrado' });
  res.json({ ok: true });
});

// Altera só alguns campos (usado na lista para mínimo e unidade).
app.patch('/api/produtos/:id', (req, res) => {
  const atual = db.prepare('SELECT * FROM produtos WHERE id = ?').get(req.params.id);
  if (!atual) return res.status(404).json({ erro: 'Produto não encontrado' });
  const { d, erro } = dadosDoProduto({ ...atual, ...req.body });
  if (erro) return res.status(400).json({ erro });
  db.prepare('UPDATE produtos SET unidade = ?, estoque_minimo = ? WHERE id = ?').run(d.unidade, d.estoque_minimo, atual.id);
  res.json({ ok: true });
});

// Exclui o produto de vez, junto com os lotes e o histórico de movimentações dele.
app.delete('/api/produtos/:id', (req, res) => {
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM lotes WHERE produto_id = ?').run(req.params.id);
    db.prepare('DELETE FROM movimentacoes WHERE produto_id = ?').run(req.params.id);
    const r = db.prepare('DELETE FROM produtos WHERE id = ?').run(req.params.id);
    if (!r.changes) { db.exec('ROLLBACK'); return res.status(404).json({ erro: 'Produto não encontrado' }); }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  res.json({ ok: true });
});

// Troca só a empresa (usado na aba "Sem empresa").
app.put('/api/produtos/:id/empresa', (req, res) => {
  const empresaId = req.body.empresa_id == null || req.body.empresa_id === '' ? null : Number(req.body.empresa_id);
  if (empresaId != null && !db.prepare('SELECT 1 FROM empresas WHERE id = ?').get(empresaId)) {
    return res.status(400).json({ erro: 'Empresa não encontrada' });
  }
  const r = db.prepare('UPDATE produtos SET empresa_id = ? WHERE id = ?').run(empresaId, req.params.id);
  if (!r.changes) return res.status(404).json({ erro: 'Produto não encontrado' });
  res.json({ ok: true });
});

const arredondar = (n) => Math.round(n * 1000) / 1000;

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

// Lançamento manual: entrada (+), saída (−) ou ajuste (contou e arruma para o valor atual).
// Em movimentacoes a quantidade fica com sinal: saída negativa, ajuste = diferença.
app.post('/api/produtos/:id/movimentar', (req, res) => {
  const p = db.prepare(`${SELECT_PRODUTO} WHERE p.id = ?`).get(req.params.id);
  if (!p) return res.status(404).json({ erro: 'Produto não encontrado' });
  const { tipo } = req.body;
  const bruto = String(req.body.quantidade ?? '').trim();
  const quantidade = Number(bruto.replace(',', '.'));
  const validade = /^\d{4}-\d{2}-\d{2}$/.test(req.body.validade || '') ? req.body.validade : null;
  const observacao = String(req.body.observacao || '').trim() || null;
  if (!['entrada', 'saida', 'ajuste'].includes(tipo)) return res.status(400).json({ erro: 'Tipo inválido' });
  if (bruto === '' || !Number.isFinite(quantidade) || quantidade < 0) return res.status(400).json({ erro: 'Quantidade inválida' });
  if (tipo !== 'ajuste' && quantidade === 0) return res.status(400).json({ erro: 'A quantidade precisa ser maior que zero' });
  const estoque = arredondar(p.estoque);
  if (tipo === 'saida' && quantidade > estoque) {
    return res.status(400).json({ erro: `Só tem ${estoque.toLocaleString('pt-BR')} no sistema. Se a contagem está errada, use "Ajustar para".` });
  }

  const novoLote = db.prepare('INSERT INTO lotes (produto_id, quantidade, validade) VALUES (?,?,?)');
  const registrar = db.prepare('INSERT INTO movimentacoes (produto_id, tipo, quantidade, observacao) VALUES (?,?,?,?)');
  db.exec('BEGIN');
  try {
    if (tipo === 'entrada') {
      novoLote.run(p.id, quantidade, validade);
      registrar.run(p.id, 'entrada', quantidade, observacao);
      db.prepare('UPDATE produtos SET em_falta = 0 WHERE id = ?').run(p.id); // chegou: a marcação manual de pedir sai
    } else if (tipo === 'saida') {
      consumirLotes(p.id, quantidade);
      registrar.run(p.id, 'saida', -quantidade, observacao);
    } else {
      const diferenca = arredondar(quantidade - estoque);
      if (diferenca > 0) novoLote.run(p.id, diferenca, validade);
      if (diferenca < 0) consumirLotes(p.id, -diferenca);
      const nota = `contou ${quantidade.toLocaleString('pt-BR')} (sistema tinha ${estoque.toLocaleString('pt-BR')})`;
      registrar.run(p.id, 'ajuste', diferenca, observacao ? `${nota} — ${observacao}` : nota);
      db.prepare('UPDATE produtos SET nao_contado = 0 WHERE id = ?').run(p.id);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  const { n } = db.prepare('SELECT COALESCE(SUM(quantidade), 0) n FROM lotes WHERE produto_id = ?').get(p.id);
  res.json({ estoque: arredondar(n) });
});

app.listen(PORTA, '0.0.0.0', () => {
  const ips = Object.values(os.networkInterfaces()).flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
  console.log('Controle de Estoque rodando!');
  console.log(`  Neste computador:  http://localhost:${PORTA}`);
  for (const ip of ips) console.log(`  Na rede (celular): http://${ip}:${PORTA}`);
});
