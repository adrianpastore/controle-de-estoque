// Leitura do XML da NF-e (nfeProc ou NFe sozinho) e conferência da chave de acesso.
// Não mexe no banco: só transforma o texto do XML em dados simples.
const { XMLParser, XMLValidator } = require('fast-xml-parser');

const leitor = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  removeNSPrefix: true, // tira prefixos de namespace (ex.: nfe:det → det)
  parseTagValue: false, // tudo como texto: códigos com zero à esquerda e a chave não viram número
  parseAttributeValue: false,
  trimValues: true,
  isArray: (nome) => ['det', 'rastro', 'docZip', 'retEvento'].includes(nome),
});

const lerXml = (texto) => leitor.parse(texto);

// Dígito verificador da chave (módulo 11, pesos 2 a 9 da direita para a esquerda).
function digitoChave(chave43) {
  let soma = 0;
  let peso = 2;
  for (let i = chave43.length - 1; i >= 0; i--) {
    soma += Number(chave43[i]) * peso;
    peso = peso === 9 ? 2 : peso + 1;
  }
  const resto = soma % 11;
  return resto < 2 ? 0 : 11 - resto;
}

// Tira espaços e pontos; devolve a chave (44 dígitos) se o dígito verificador confere, senão null.
function limparChave(valor) {
  const chave = String(valor ?? '').replace(/\D/g, '');
  if (!/^\d{44}$/.test(chave)) return null;
  return digitoChave(chave.slice(0, 43)) === Number(chave[43]) ? chave : null;
}

const numero = (v) => {
  const n = Number(String(v ?? '').trim());
  return String(v ?? '').trim() !== '' && Number.isFinite(n) ? n : null;
};
const texto = (v) => (v == null || typeof v === 'object' ? '' : String(v).trim());
const semGtin = (v) => {
  const s = texto(v);
  return /^\d{8,14}$/.test(s) ? s : null; // "SEM GTIN" ou vazio = sem código
};
const dataIso = (v) => (/^\d{4}-\d{2}-\d{2}/.test(texto(v)) ? texto(v).slice(0, 10) : null);

// Recebe o texto do XML. Devolve { nota } com os dados e os itens, ou { erro } em português.
function lerNota(xml) {
  let doc;
  try {
    if (XMLValidator.validate(String(xml || '')) !== true) return { erro: 'XML incompleto ou inválido' };
    doc = lerXml(String(xml || ''));
  } catch {
    return { erro: 'XML incompleto ou inválido' };
  }
  const nfe = doc?.nfeProc?.NFe || doc?.NFe;
  const inf = nfe?.infNFe;
  if (!inf) return { erro: 'Este XML não é de uma NF-e (não achei a parte infNFe)' };
  const chave = limparChave(texto(inf['@Id']).replace(/^NFe/, ''));
  if (!chave) return { erro: 'A chave de acesso da nota está errada (Id do infNFe)' };

  const ide = inf.ide || {};
  const emit = inf.emit || {};
  const detalhes = inf.det || [];
  const valores = detalhes.map(d => numero(d.prod?.vProd));
  const totalProdutos = numero(inf.total?.ICMSTot?.vProd);
  if (detalhes.some((d, i) => Number(d['@nItem']) !== i + 1) || totalProdutos == null ||
      valores.some(v => v == null) || Math.abs(valores.reduce((s, v) => s + v, 0) - totalProdutos) > 0.05 + 1e-9) {
    return { erro: 'XML incompleto ou inválido' };
  }
  const itens = detalhes.map((d, i) => {
    const prod = d.prod || {};
    // validade: a primeira que vence entre os lotes informados pelo fornecedor (rastro)
    const validades = (prod.rastro || []).map((r) => dataIso(r.dVal)).filter(Boolean).sort();
    return {
      n: Number(d['@nItem']) || i + 1,
      codigo: texto(prod.cProd),
      ean: semGtin(prod.cEAN) || semGtin(prod.cEANTrib),
      descricao: texto(prod.xProd),
      unidade: texto(prod.uCom),
      quantidade: numero(prod.qCom) ?? 0,
      valor_unit: numero(prod.vUnCom) ?? 0,
      valor_total: numero(prod.vProd) ?? 0,
      validade: validades[0] || null,
    };
  });
  if (!itens.length) return { erro: 'A nota não tem itens' };

  return {
    nota: {
      chave,
      numero: texto(ide.nNF),
      serie: texto(ide.serie),
      emissao: texto(ide.dhEmi || ide.dEmi) || null,
      emitente_cnpj: texto(emit.CNPJ || emit.CPF),
      emitente_nome: texto(emit.xNome),
      valor_total: numero(inf.total?.ICMSTot?.vNF),
      itens,
    },
  };
}

module.exports = { lerXml, lerNota, limparChave, digitoChave };
