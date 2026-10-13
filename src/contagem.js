// Contagem do estoque: lê a lista que o estoquista escreveu ("produto  quantidade", uma por linha)
// e acha o produto de cada linha pelo nome. Não grava nada: só devolve o que entendeu para a tela conferir.
//
// Formatos aceitos em cada linha (o separador é opcional, mas evita confusão com números no nome):
//   Coca 600 = 12        Coca 600; 12       Coca 600: 12      Coca 600 - 12      (ou TAB, colado do Excel)
//   Salame 3 cx 4 und    Salame 3 + 4       (caixas + unidades soltas, para produto com fator)
//   leite integral 2,5

const PALAVRAS_VAZIAS = new Set(['de', 'da', 'do', 'das', 'dos', 'com', 'p', 'pra', 'para', 'e', 'em', 'c', 'x']);

const semAcento = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// "Coca-Cola 600ML (zero)" → "coca cola 600 ml zero"
const normalizar = (s) => semAcento(s)
  .replace(/(\d)([a-z])/g, '$1 $2').replace(/([a-z])(\d)/g, '$1 $2')
  .replace(/(\d)[.,](\d)/g, '$1#$2') // 2,5 continua um número só
  .replace(/[^a-z0-9#]+/g, ' ').replace(/#/g, ',').trim();

// Palavras para comparar: sem acento, sem "de/da/com…", plural simples tirado (pães → pae, ovos → ovo).
function palavras(s) {
  const todas = normalizar(s).split(' ').filter(Boolean);
  const uteis = todas.filter((t) => !PALAVRAS_VAZIAS.has(t));
  return (uteis.length ? uteis : todas).map((t) => (t.length > 3 && t.endsWith('s') ? t.slice(0, -1) : t));
}

// Distância de edição até 1 (uma letra trocada, faltando ou sobrando)?
function quaseIgual(a, b) {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, erros = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++erros > 1) return false;
    if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; }
  }
  return erros + (a.length - i) + (b.length - j) <= 1;
}

// Quanto a palavra escrita "bate" com a palavra do produto: 1 = igual ou começo ("choc" → "chocolate"), 0,8 = erro de digitação.
function bate(escrita, doProduto) {
  if (escrita === doProduto) return 1;
  if (escrita.length >= 3 && !/^\d/.test(escrita) && doProduto.startsWith(escrita)) return 1;
  if (escrita.length >= 5 && doProduto.length >= 5 && quaseIgual(escrita, doProduto)) return 0.8;
  return 0;
}

// Nota de 0 a 1 (2 = nome igual). "cobre" = todas as palavras escritas estão no nome do produto.
function nota(escritas, produto) {
  if (escritas.join(' ') === produto.palavras.join(' ')) return { nota: 2, cobre: true, parte: 1 };
  if (!escritas.length || !produto.palavras.length) return { nota: 0, cobre: false, parte: 0 };
  const usadas = new Set();
  let soma = 0;
  let cobre = true;
  for (const t of escritas) {
    let melhor = 0, qual = -1;
    produto.palavras.forEach((w, k) => { const b = bate(t, w); if (b > melhor) { melhor = b; qual = k; } });
    if (qual >= 0) usadas.add(qual);
    if (melhor < 1) cobre = false;
    soma += melhor;
  }
  const deEntrada = soma / escritas.length;
  const parte = usadas.size / produto.palavras.length; // quanto do nome do produto foi escrito
  return { nota: deEntrada * 0.7 + parte * 0.3, cobre, parte };
}

// ---------- quantidade ----------

// Um pedaço de quantidade: "3", "2,5", "3 cx", "4und", "12 unidades".
const GRUPO = String.raw`(\d+(?:[.,]\d+)?)\s*([a-zA-ZÀ-ÿ]{1,10}\.?)?`;
const RE_QTD = new RegExp(String.raw`^${GRUPO}(?:\s*(?:\+|\be\b)?\s*${GRUPO})?$`);

// "3 cx 4 und" → [{ valor: 3, unidade: 'cx' }, { valor: 4, unidade: 'und' }]; null se não for só quantidade.
function lerNumeros(texto) {
  const m = String(texto).trim().match(RE_QTD);
  if (!m) return null;
  const grupos = [[m[1], m[2]], [m[3], m[4]]].filter(([v]) => v != null);
  return grupos.map(([v, u]) => ({ valor: Number(v.replace(',', '.')), unidade: u ? semAcento(u).replace('.', '') : null }));
}

// Jeitos de separar nome e quantidade numa linha. Quem decide entre eles é o nome que bate melhor com um produto.
function cortes(linha) {
  const lista = [];
  // com separador: o que vem depois do último ; : = | TAB ou " - " é a quantidade
  const sep = /\t|;|:|=|\||\s[-–]\s/g;
  let m;
  while ((m = sep.exec(linha))) {
    const nome = linha.slice(0, m.index).trim();
    const numeros = lerNumeros(linha.slice(m.index + m[0].length));
    if (nome && numeros) lista.push({ nome, numeros, prioridade: 3 });
  }
  // sem separador: um ou dois números no fim ("Salame 3 cx 4 und", "Coca 600 12")
  const palavrasLinha = linha.trim().split(/\s+/);
  for (let k = palavrasLinha.length - 1; k >= 1 && k >= palavrasLinha.length - 4; k--) {
    const nome = palavrasLinha.slice(0, k).join(' ').replace(/[\s:;=|–-]+$/, '');
    const numeros = lerNumeros(palavrasLinha.slice(k).join(' '));
    if (nome && numeros) lista.push({ nome, numeros, prioridade: 2 });
  }
  // número no começo ("12 coca 600")
  const inicio = linha.trim().match(/^(\d+(?:[.,]\d+)?)\s+(.*[a-zA-ZÀ-ÿ].*)$/);
  if (inicio) lista.push({ nome: inicio[2], numeros: lerNumeros(inicio[1]), prioridade: 1 });
  // a linha inteira é o nome (esqueceu a quantidade)
  lista.push({ nome: linha.trim(), numeros: [], prioridade: 0 });
  return lista;
}

// ---------- conferência ----------

// Uma linha por produto contado. produtos = lista de { id, nome, ... }.
// Devolve por linha: situacao 'certo' (achou sem dúvida), 'confirmar' (sugestões para escolher) ou 'nao_achou'.
function conferir(texto, produtos) {
  const base = produtos.map((p) => ({ p, palavras: palavras(p.nome) }));
  const linhas = String(texto ?? '').split(/\r?\n/);
  const resultado = [];
  linhas.forEach((original, i) => {
    const linha = original.replace(/^\s*(?:[-•*]|\d+[.)])\s+/, '').trim(); // tira marcador de lista ("- ", "1. ")
    if (!linha || !/[a-zA-ZÀ-ÿ]/.test(linha)) return;

    let melhor = null;
    for (const corte of cortes(linha)) {
      const escritas = palavras(corte.nome);
      const notas = base.map((b) => ({ b, ...nota(escritas, b) })).filter((n) => n.nota > 0.35)
        .sort((x, y) => y.nota - x.nota || x.b.p.nome.localeCompare(y.b.p.nome));
      const topo = notas[0]?.nota || 0;
      const candidato = { corte, notas, topo };
      if (!melhor || topo > melhor.topo + 1e-9 || (Math.abs(topo - melhor.topo) < 1e-9 && corte.prioridade > melhor.corte.prioridade)) {
        melhor = candidato;
      }
    }

    const { corte, notas } = melhor;
    const iguais = notas.filter((n) => n.nota === 2);
    const cobrem = notas.filter((n) => n.cobre);
    let produto = null;
    if (iguais.length === 1) produto = iguais[0].b.p;
    else if (!iguais.length && cobrem.length === 1 && cobrem[0].parte >= 0.5) produto = cobrem[0].b.p;
    const sugestoes = (produto ? [] : notas.slice(0, 6)).map((n) => n.b.p);
    resultado.push({
      linha: i + 1,
      texto: original.trim(),
      nome: corte.nome,
      numeros: corte.numeros,
      situacao: produto ? 'certo' : sugestoes.length ? 'confirmar' : 'nao_achou',
      produto,
      sugestoes,
    });
  });
  return resultado;
}

module.exports = { conferir, lerNumeros, normalizar, palavras };
