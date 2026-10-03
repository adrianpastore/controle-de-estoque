// Importa a aba "Geral" da planilha Estoque Padaria.xlsx para o banco.
// Uso:  node scripts/importar-planilha.js            (só roda com o banco vazio)
//       node scripts/importar-planilha.js --forcar   (APAGA tudo e importa de novo)
const fs = require('node:fs');
const path = require('node:path');
const ExcelJS = require('exceljs');
const db = require('../src/db');
const { separarPorFornecedor } = require('../src/empresas');

const ARQUIVO = path.join(__dirname, '..', 'Estoque Padaria.xlsx');
const RELATORIO = path.join(__dirname, '..', 'dados', 'relatorio-importacao.txt');

// Cores da coluna de produtos na planilha
const AMARELO_NAO_PEDIR = 'FFFFD966';
const VERMELHO_EM_FALTA = 'FFFF0000';
const AMARELO_SECAO = 'FFFFFF00';

const UNIDADES = {
  cx: 'cx', caixa: 'cx', caixas: 'cx',
  pct: 'pct', pc: 'pct', pacote: 'pct', pacotes: 'pct',
  und: 'und', uni: 'und', unid: 'und', un: 'und', unidade: 'und', unidades: 'und',
  fardo: 'fardo', fardos: 'fardo', fd: 'fardo',
  balde: 'balde', baldes: 'balde',
  lata: 'lata', latas: 'lata',
  vidro: 'vidro', vidros: 'vidro',
  manga: 'manga', mangas: 'manga',
  rolo: 'rolo', rolos: 'rolo',
  galao: 'galão', galoes: 'galão',
  garrafa: 'garrafa', garrafas: 'garrafa',
  sache: 'sachê', saches: 'sachê',
  bandeja: 'bandeja', bandeija: 'bandeja',
  kg: 'kg',
  saco: 'saco', sacos: 'saco',
  bobina: 'bobina', bobinas: 'bobina',
  pote: 'pote', potes: 'pote',
};

const semAcento = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');

function valorDaCelula(cell) {
  const v = cell.value;
  if (v == null) return null;
  if (typeof v === 'object') {
    if ('formula' in v || 'sharedFormula' in v) return { formula: true };
    if (v.richText) return v.richText.map((r) => r.text).join('');
    if ('text' in v) return v.text;
    if ('result' in v) return v.result;
  }
  return v;
}

// Interpreta "2cx", "6 latas", "meia cx", 8, "x", "xxxx", "tem"...
function lerQuantidade(bruto) {
  if (bruto == null || (typeof bruto === 'object' && bruto.formula)) return { vazio: true };
  if (typeof bruto === 'number') return { qtd: bruto, unidade: null };
  const txt = String(bruto).trim();
  if (txt === '') return { vazio: true };
  const t = semAcento(txt.toLowerCase());
  if (t === 'x') return { qtd: 0, unidade: null };
  if (/^x{3,}$/.test(t)) return { semMinimo: true };
  if (t === 'tem') return { naoContado: true };
  const meia = t.match(/^meia\s*([a-z]+)$/);
  if (meia && UNIDADES[meia[1]]) return { qtd: 0.5, unidade: UNIDADES[meia[1]] };
  const m = t.match(/^(\d+(?:[.,]\d+)?)\s*([a-z]+)?\.?$/);
  if (m && (!m[2] || UNIDADES[m[2]])) {
    return { qtd: Number(m[1].replace(',', '.')), unidade: m[2] ? UNIDADES[m[2]] : null };
  }
  return { texto: txt };
}

async function main() {
  const forcar = process.argv.includes('--forcar');
  const jaTem = db.prepare('SELECT COUNT(*) n FROM produtos').get().n;
  if (jaTem > 0 && !forcar) {
    console.log(`O banco já tem ${jaTem} produtos. Use --forcar para apagar tudo e importar de novo.`);
    return;
  }

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(ARQUIVO);
  const ws = wb.getWorksheet('Geral');
  if (!ws) throw new Error('Aba "Geral" não encontrada na planilha.');

  const produtos = [];
  const ignoradas = [];
  const vistos = new Map(); // nome normalizado -> quantas vezes apareceu
  let secao = 'Estoque';

  ws.eachRow((row, n) => {
    if (n === 1) return; // cabeçalho
    const cel = (c) => valorDaCelula(row.getCell(c));
    let nome = cel(1) == null ? '' : String(cel(1)).replace(/\s+/g, ' ').trim();
    const [pedir, feito, contagem, minimo, fornecedor] = [2, 3, 4, 5, 6].map(cel);
    const cor = row.getCell(1).fill?.fgColor?.argb;
    const temDados = [pedir, feito, contagem, minimo, fornecedor].some((v) => v != null && v !== '' && !v.formula);

    if (/senha\s.*=/i.test(nome)) { ignoradas.push(`linha ${n}: anotação de senha (não importada)`); return; }
    if (cor === AMARELO_SECAO && !temDados) {
      secao = nome.toUpperCase() === 'FRENTE' ? 'Frente' : `Frente - ${nome.charAt(0)}${nome.slice(1).toLowerCase()}`;
      return;
    }
    if (!nome && !temDados) return;
    if (/^\d+$/.test(nome) && !temDados) { ignoradas.push(`linha ${n}: "${nome}" (só um número, sem dados)`); return; }

    const revisao = [];
    const obs = [];
    if (!nome) { nome = `SEM NOME (linha ${n})`; revisao.push('produto sem nome na planilha'); }

    const chave = semAcento(nome.toLowerCase());
    const vezes = (vistos.get(chave) || 0) + 1;
    vistos.set(chave, vezes);
    if (vezes > 1) { nome = `${nome} (${vezes})`; revisao.push('nome repetido — complete com o sabor'); }

    const c = lerQuantidade(contagem);
    const m = lerQuantidade(minimo);
    let unidade = c.unidade || m.unidade || null;
    let naoContado = 0;
    let qtd = null;

    if (c.naoContado) naoContado = 1;
    else if (c.texto) { revisao.push(`contagem não entendida: "${c.texto}"`); }
    else if (c.semMinimo) { qtd = 0; }
    else if (!c.vazio) qtd = c.qtd;

    let estoqueMinimo = null;
    if (m.texto) { revisao.push(`mínimo não entendido: "${m.texto}"`); }
    else if (m.naoContado) { obs.push('mínimo na planilha: "tem"'); }
    else if (!m.vazio && !m.semMinimo) estoqueMinimo = m.qtd;

    if (c.unidade && m.unidade && c.unidade !== m.unidade) {
      revisao.push(`contagem em "${c.unidade}" e mínimo em "${m.unidade}"`);
    }

    const forn = fornecedor == null ? null : String(fornecedor).trim();
    if (forn === '?') revisao.push('fornecedor desconhecido ("?")');

    const pedirTxt = pedir == null || pedir.formula ? '' : String(pedir).trim();
    const feitoTxt = feito == null || feito.formula ? '' : String(feito).trim();
    if (pedirTxt) obs.push(`planilha: pedir ${pedirTxt}${feitoTxt ? ' (pedido feito)' : ''}`);

    produtos.push({
      nome, unidade, qtd, estoqueMinimo, naoContado,
      fornecedor: forn && forn !== '?' ? forn : null,
      secao,
      ativo: cor === AMARELO_NAO_PEDIR ? 0 : 1,
      emFalta: cor === VERMELHO_EM_FALTA ? 1 : 0,
      revisao, obs, linha: n,
    });
  });

  db.exec('BEGIN');
  try {
    if (forcar) db.exec('DELETE FROM movimentacoes; DELETE FROM lotes; DELETE FROM produtos;');
    const insProd = db.prepare(`INSERT INTO produtos
      (nome, unidade, estoque_minimo, fornecedor, secao, ativo, em_falta, nao_contado, precisa_revisao, observacao)
      VALUES (?,?,?,?,?,?,?,?,?,?)`);
    const insLote = db.prepare('INSERT INTO lotes (produto_id, quantidade) VALUES (?,?)');
    const insMov = db.prepare(`INSERT INTO movimentacoes (produto_id, tipo, quantidade, observacao, usuario)
      VALUES (?, 'importacao', ?, 'Contagem da planilha', 'importação')`);
    for (const p of produtos) {
      const observacao = [...p.revisao, ...p.obs].join('; ') || null;
      const { lastInsertRowid: id } = insProd.run(p.nome, p.unidade, p.estoqueMinimo, p.fornecedor, p.secao,
        p.ativo, p.emFalta, p.naoContado, p.revisao.length ? 1 : 0, observacao);
      if (p.qtd) { insLote.run(id, p.qtd); insMov.run(id, p.qtd); }
    }
    separarPorFornecedor(db, { refazer: true });
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  const paraRevisar = produtos.filter((p) => p.revisao.length);
  const linhas = [
    `Importação da aba Geral — ${new Date().toLocaleString('pt-BR')}`,
    `Produtos importados: ${produtos.length}`,
    `  Estoque: ${produtos.filter((p) => p.secao === 'Estoque').length}   Frente: ${produtos.filter((p) => p.secao.startsWith('Frente')).length}`,
    `  Inativos (amarelo, não pedir): ${produtos.filter((p) => !p.ativo).length}`,
    `  Em falta (vermelho): ${produtos.filter((p) => p.emFalta).length}`,
    `  "tem" (não contado): ${produtos.filter((p) => p.naoContado).length}`,
    `  Para revisar: ${paraRevisar.length}`,
    '',
    'LINHAS IGNORADAS:',
    ...ignoradas.map((l) => '  ' + l),
    '',
    'PARA REVISAR:',
    ...paraRevisar.map((p) => `  linha ${p.linha}: ${p.nome} — ${p.revisao.join('; ')}`),
  ];
  fs.writeFileSync(RELATORIO, linhas.join('\n'), 'utf8');
  console.log(linhas.slice(0, 7).join('\n'));
  console.log(`\nRelatório completo em: ${RELATORIO}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
