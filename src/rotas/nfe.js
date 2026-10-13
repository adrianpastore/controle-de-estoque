// Rotas da entrada pela nota fiscal (NF-e): importar o XML, conferir os itens, lançar e lembrar as associações.
// Entrada pela nota = movimentação "entrada" (+) e um lote por item, com nota_id e custo_unit (custo por unidade do lote).
const express = require('express');
const db = require('../db');
const { arredondar, buscarProduto, novoLote, registrar, transacao } = require('../estoque');
const { lerNota, limparChave } = require('../nfe-xml');
const sefaz = require('../sefaz');

const semAcento = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const textoLimpo = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();

// O arquivo chega como veio (bytes). NF-e é UTF-8; se o XML disser ISO-8859-1, lê assim.
function textoDoArquivo(corpo) {
  if (typeof corpo === 'string') return corpo;
  if (corpo && typeof corpo.xml === 'string') return corpo.xml;
  if (!Buffer.isBuffer(corpo)) return '';
  const inicio = corpo.subarray(0, 200).toString('latin1');
  const latin = /encoding=["'](iso-8859-1|latin1|windows-1252)["']/i.test(inicio);
  return corpo.toString(latin ? 'latin1' : 'utf8').replace(/^﻿/, '');
}

// Grava a nota (se a chave já existe, devolve a que já está no banco). { id, nova, status } ou { erro }.
function guardarNota(xml) {
  const { nota, erro } = lerNota(xml);
  if (erro) return { erro };
  const existente = db.prepare('SELECT id, status FROM notas WHERE chave = ?').get(nota.chave);
  if (existente) return { id: existente.id, nova: false, status: existente.status };
  const r = db.prepare(`INSERT INTO notas (chave, numero, serie, emitente_cnpj, emitente_nome, emissao, valor_total, xml)
    VALUES (?,?,?,?,?,?,?,?)`).run(nota.chave, nota.numero, nota.serie, nota.emitente_cnpj, nota.emitente_nome,
    nota.emissao, nota.valor_total, xml);
  return { id: Number(r.lastInsertRowid), nova: true, status: 'pendente' };
}

const unidadeSolta = (u) => ['un', 'und', 'unid', 'unidade', 'unidades', 'pc', 'pç', 'pca', 'peca'].includes(semAcento(u));

// Quanto 1 unidade da nota vale nos lotes do produto, quando o sistema ainda não sabe.
// Produto com fator (cx de 12 und): nota em "UN" → 1 und; nota em "CX" (ou outra embalagem) → 1 cx = fator und.
function multiplicadorPadrao(p, unidadeNota) {
  if (!p.fator) return 1;
  const u = semAcento(unidadeNota);
  return unidadeSolta(u) || (p.unidade_menor && u === semAcento(p.unidade_menor)) ? 1 : p.fator;
}

const resumoProduto = (p) => p && {
  id: p.id, nome: p.nome, unidade: p.unidade, fator: p.fator, unidade_menor: p.unidade_menor,
  empresa: p.empresa, estoque_base: p.estoque_base, ativo: p.ativo,
};

// Sugestão para um item: (1) o que o sistema lembra deste fornecedor, (2) produto com o mesmo código de barras.
function sugerir(nota, item) {
  const assoc = db.prepare('SELECT * FROM nfe_associacoes WHERE emitente_cnpj = ? AND codigo = ?').get(nota.emitente_cnpj || '', item.codigo);
  if (assoc?.ignorar) return { acao: 'ignorar', origem: 'lembrada' };
  if (assoc?.produto_id) {
    const p = buscarProduto(assoc.produto_id);
    if (p) return { acao: 'produto', origem: 'lembrada', produto: resumoProduto(p), multiplicador: assoc.multiplicador };
  }
  if (item.ean) {
    const p = db.prepare(`SELECT id FROM produtos WHERE TRIM(codigo_barras) = ? ORDER BY ativo DESC, id LIMIT 1`).get(item.ean);
    if (p) {
      const prod = buscarProduto(p.id);
      return { acao: 'produto', origem: 'ean', produto: resumoProduto(prod), multiplicador: multiplicadorPadrao(prod, item.unidade) };
    }
  }
  return { acao: null, origem: null };
}

// Empresa provável do fornecedor: a dos produtos já associados a ele; senão, uma empresa cujo nome aparece no nome dele.
function empresaSugerida(nota) {
  const pelaAssociacao = db.prepare(`SELECT p.empresa_id id, COUNT(*) n FROM nfe_associacoes a JOIN produtos p ON p.id = a.produto_id
    WHERE a.emitente_cnpj = ? AND p.empresa_id IS NOT NULL GROUP BY p.empresa_id ORDER BY n DESC LIMIT 1`).get(nota.emitente_cnpj || '');
  if (pelaAssociacao) return pelaAssociacao.id;
  const palavrasEmitente = new Set(semAcento(nota.emitente_nome).split(/[^a-z0-9]+/).filter(Boolean));
  const candidatas = db.prepare('SELECT id, nome FROM empresas').all().filter((e) => {
    const palavras = semAcento(e.nome).split(/[^a-z0-9]+/).filter((w) => w.length >= 3);
    return palavras.length && palavras.every((w) => palavrasEmitente.has(w));
  });
  candidatas.sort((a, b) => b.nome.length - a.nome.length);
  return candidatas[0]?.id ?? null;
}

const contarItens = (xml) => (String(xml).match(/<(\w+:)?det[\s>]/g) || []).length;

module.exports = function (app) {
  // Lista das notas importadas: pendentes primeiro, depois as mais recentes.
  app.get('/api/nfe/notas', (req, res) => {
    const notas = db.prepare(`SELECT id, chave, numero, serie, emitente_cnpj, emitente_nome, emissao, valor_total, status,
      importada_em, lancada_em, xml FROM notas ORDER BY status = 'lancada', importada_em DESC, id DESC LIMIT 200`).all();
    res.json(notas.map(({ xml, ...n }) => ({ ...n, itens: contarItens(xml) })));
  });

  // Importar o XML (o arquivo vai no corpo, do jeito que está).
  app.post('/api/nfe/importar', express.raw({ type: () => true, limit: '20mb' }), (req, res) => {
    const xml = textoDoArquivo(req.body);
    if (!xml.trim()) return res.status(400).json({ erro: 'Arquivo vazio' });
    const r = guardarNota(xml);
    if (r.erro) return res.status(400).json({ erro: r.erro });
    res.status(r.nova ? 201 : 200).json(r);
  });

  // Chave lida da foto do DANFE ou digitada: abre a nota se já está no sistema; senão tenta baixar da SEFAZ.
  app.post('/api/nfe/chave', async (req, res) => {
    const chave = limparChave(req.body?.chave);
    if (!chave) return res.status(400).json({ erro: 'Chave de acesso inválida: confira os 44 números' });
    const existente = db.prepare('SELECT id, status FROM notas WHERE chave = ?').get(chave);
    if (existente) return res.json({ id: existente.id, nova: false, status: existente.status });
    const r = await sefaz.baixarNota(chave);
    if (r.erro) return res.status(404).json({ erro: r.erro, chave, sem_config: !!r.semConfig, aguardar: !!r.aguardar });
    const g = guardarNota(r.xml);
    if (g.erro) return res.status(502).json({ erro: `A SEFAZ mandou um arquivo que não deu para ler: ${g.erro}` });
    res.status(g.nova ? 201 : 200).json({ ...g, baixada: true });
  });

  // Nota com os itens e a sugestão de produto para cada um.
  app.get('/api/nfe/notas/:id', (req, res) => {
    const linha = db.prepare('SELECT * FROM notas WHERE id = ?').get(req.params.id);
    if (!linha) return res.status(404).json({ erro: 'Nota não encontrada' });
    const { nota, erro } = lerNota(linha.xml);
    if (erro) return res.status(500).json({ erro });
    const { xml, ...dados } = linha;
    const resposta = {
      ...dados,
      empresa_sugerida: empresaSugerida(linha),
      itens: nota.itens.map((item) => ({ ...item, sugestao: sugerir(linha, item) })),
    };
    if (linha.status === 'lancada') {
      resposta.lancamentos = db.prepare(`SELECT m.produto_id, m.quantidade, p.nome, p.unidade, p.fator, p.unidade_menor
        FROM movimentacoes m JOIN produtos p ON p.id = m.produto_id WHERE m.nota_id = ? ORDER BY m.id`).all(linha.id);
    }
    res.json(resposta);
  });

  // Apagar uma nota importada por engano (só enquanto não foi lançada).
  app.delete('/api/nfe/notas/:id', (req, res) => {
    const nota = db.prepare('SELECT status FROM notas WHERE id = ?').get(req.params.id);
    if (!nota) return res.status(404).json({ erro: 'Nota não encontrada' });
    if (nota.status === 'lancada') return res.status(409).json({ erro: 'Esta nota já foi lançada no estoque e não pode ser apagada' });
    db.prepare("DELETE FROM notas WHERE id = ? AND status = 'pendente'").run(req.params.id);
    res.json({ ok: true });
  });

  // Lançar a entrada. Corpo: { itens: [{ n, acao: 'produto'|'novo'|'ignorar', produto_id, multiplicador, validade, novo: { nome, unidade, empresa_id } }] }
  // multiplicador = quanto 1 unidade da nota vale na unidade em que os lotes do produto são guardados.
  app.post('/api/nfe/notas/:id/lancar', (req, res) => {
    const linha = db.prepare('SELECT * FROM notas WHERE id = ?').get(req.params.id);
    if (!linha) return res.status(404).json({ erro: 'Nota não encontrada' });
    if (linha.status === 'lancada') return res.status(409).json({ erro: `Esta nota já foi lançada em ${String(linha.lancada_em || '').slice(0, 16)}. Não dá para lançar de novo.` });
    const { nota } = lerNota(linha.xml);
    const escolhas = new Map((Array.isArray(req.body?.itens) ? req.body.itens : []).map((e) => [Number(e?.n), e]));

    // Confere tudo antes de gravar qualquer coisa.
    const plano = [];
    for (const item of nota.itens) {
      const nome = `Item ${item.n} (${item.descricao})`;
      const e = escolhas.get(item.n);
      if (!e || !['produto', 'novo', 'ignorar'].includes(e.acao)) return res.status(400).json({ erro: `${nome}: escolha o produto ou ignore o item` });
      if (e.acao === 'ignorar') { plano.push({ item, acao: 'ignorar' }); continue; }
      const mult = Number(String(e.multiplicador ?? '').replace(',', '.'));
      if (!(Number.isFinite(mult) && mult > 0 && mult <= 100000)) return res.status(400).json({ erro: `${nome}: conversão inválida` });
      const validade = /^\d{4}-\d{2}-\d{2}$/.test(e.validade || '') ? e.validade : null;
      const base = arredondar(item.quantidade * mult);
      if (!(base > 0)) return res.status(400).json({ erro: `${nome}: a quantidade ficou zero` });
      let produto = null;
      let novo = null;
      if (e.acao === 'produto') {
        produto = buscarProduto(Number(e.produto_id));
        if (!produto) return res.status(400).json({ erro: `${nome}: produto não encontrado` });
      } else {
        novo = {
          nome: textoLimpo(e.novo?.nome) || item.descricao,
          unidade: textoLimpo(e.novo?.unidade).toLowerCase() || null,
          empresa_id: e.novo?.empresa_id == null || e.novo.empresa_id === '' ? null : Number(e.novo.empresa_id),
        };
        if (novo.empresa_id != null && !db.prepare('SELECT 1 FROM empresas WHERE id = ?').get(novo.empresa_id)) {
          return res.status(400).json({ erro: `${nome}: empresa não encontrada` });
        }
      }
      // custo de 1 unidade do lote (und, se o produto tem fator), a partir do valor unitário da nota
      const custo = Math.round((item.valor_unit / mult) * 10000) / 10000;
      plano.push({ item, acao: e.acao, produto, novo, mult, base, validade, custo });
    }

    const observacao = `NF ${linha.numero || '?'} – ${linha.emitente_nome || linha.emitente_cnpj || 'fornecedor'}`;
    const cnpj = linha.emitente_cnpj || '';
    const lembrar = db.prepare(`INSERT INTO nfe_associacoes (emitente_cnpj, codigo, ean, descricao, unidade_nota, produto_id, multiplicador, ignorar)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT (emitente_cnpj, codigo) DO UPDATE SET ean = excluded.ean, descricao = excluded.descricao,
      unidade_nota = excluded.unidade_nota, produto_id = excluded.produto_id, multiplicador = excluded.multiplicador, ignorar = excluded.ignorar`);

    let lancados = 0;
    try {
      transacao(() => {
        // marca a nota primeiro: se duas pessoas apertarem ao mesmo tempo, só uma lança
        const r = db.prepare("UPDATE notas SET status = 'lancada', lancada_em = datetime('now','localtime') WHERE id = ? AND status = 'pendente'").run(linha.id);
        if (!r.changes) throw Object.assign(new Error('Esta nota já foi lançada'), { status: 409 });
        for (const p of plano) {
          const { item } = p;
          if (p.acao === 'ignorar') {
            lembrar.run(cnpj, item.codigo, item.ean, item.descricao, item.unidade, null, 1, 1);
            continue;
          }
          let produtoId = p.produto?.id;
          if (p.acao === 'novo') {
            produtoId = Number(db.prepare(`INSERT INTO produtos (nome, unidade, empresa_id, codigo_barras, fornecedor) VALUES (?,?,?,?,?)`)
              .run(p.novo.nome, p.novo.unidade, p.novo.empresa_id, item.ean, linha.emitente_nome || null).lastInsertRowid);
          }
          novoLote(produtoId, p.base, p.validade, p.custo, linha.id);
          registrar(produtoId, 'entrada', p.base, observacao, linha.id);
          db.prepare('UPDATE produtos SET em_falta = 0 WHERE id = ?').run(produtoId); // chegou: a marcação manual de pedir sai
          lembrar.run(cnpj, item.codigo, item.ean, item.descricao, item.unidade, produtoId, p.mult, 0);
          lancados++;
        }
      });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ erro: e.message });
      throw e;
    }
    res.json({ ok: true, lancados, ignorados: plano.length - lancados });
  });

  // Certificado digital configurado? Quando vence? (nunca mostra a senha)
  app.get('/api/sefaz/status', (req, res) => res.json(sefaz.situacao()));
};
