// Transforma o texto livre da coluna "Fornecedor" (vindo da planilha) em uma empresa.
// Regra: quando há vários fornecedores ("mercado, fritz", "dalpian/ferga"), vale o primeiro;
// o que está entre parênteses e telefones é detalhe e é ignorado. O texto original continua
// guardado no campo fornecedor do produto.

const semAcento = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');

// Grafias diferentes da mesma empresa -> nome oficial (chave sem acento, minúscula).
const APELIDOS = {
  'fritz': 'Fritz Frida',
  'fritz frida': 'Fritz Frida',
  'fritz e frida': 'Fritz Frida',
  'fritzfrida': 'Fritz Frida',
  'fritz mercado': 'Fritz Frida',
  'fritz frida dellys': 'Fritz Frida',
  'panesul fritz frida': 'Panesul',
  'flaschmann na ferga': 'Flaschmann',
  'ra embalagem': 'RA Embalagens',
  'ra embalagens': 'RA Embalagens',
  'admix ferga': 'Ferga',
  'pamix plus': 'Emulzint',
  'brf sadia': 'BRF Sadia',
  'brf perdigao': 'BRF Perdigão',
  'dalia': 'Dália',
  'cafe tres coracoes': 'Café Três Corações',
  'camara fria': 'Câmara Fria',
  'bom principio': 'Bom Princípio',
  'pem': 'PEM',
  '2m': '2M',
  'distribuidora caramuru': 'Distribuidora Caramuru',
  'mercadolivre': 'Mercado Livre',
};

// Não são fornecedores: o produto fica sem empresa.
const IGNORAR = new Set(['pesquisar preco', 'qualquer lugar', 'normal']);

// Nomes compostos que têm " e " no meio e não podem ser separados.
const NAO_SEPARAR = /fritz e frida/g;

const capitalizar = (s) => s.replace(/(^|\s)(\S)/g, (_, a, b) => a + b.toUpperCase());

function empresaDoFornecedor(fornecedor) {
  if (!fornecedor) return null;
  let t = semAcento(String(fornecedor).toLowerCase())
    .replace(/\(.*?\)/g, ' ')           // "(ivoti)", "(ver com a hd)"
    .replace(/\d{8,}/g, ' ')            // telefones
    .replace(/[?]/g, ' ')
    .replace(NAO_SEPARAR, 'fritz frida');
  const primeiro = t.split(/,|\/|\s+e\s+|\s+ou\s+/)[0].replace(/\s+/g, ' ').trim();
  if (!primeiro || IGNORAR.has(primeiro)) return null;
  if (APELIDOS[primeiro]) return APELIDOS[primeiro];
  // mantém a grafia original (com acento) do trecho escolhido
  const original = String(fornecedor).replace(/\(.*?\)/g, ' ').replace(/\d{8,}/g, ' ').replace(/[?]/g, ' ')
    .split(/,|\/|\s+e\s+|\s+ou\s+/i)[0].replace(/\s+/g, ' ').trim();
  return capitalizar(original.length === primeiro.length ? original : primeiro);
}

// Coloca cada produto na empresa do seu fornecedor, criando as empresas que faltarem.
// refazer = false: só mexe nos produtos que ainda estão sem empresa.
function separarPorFornecedor(db, { refazer = false } = {}) {
  const produtos = db.prepare(`SELECT id, fornecedor FROM produtos ${refazer ? '' : 'WHERE empresa_id IS NULL'}`).all();
  const criar = db.prepare('INSERT OR IGNORE INTO empresas (nome) VALUES (?)');
  const buscar = db.prepare('SELECT id FROM empresas WHERE nome = ?');
  const atualizar = db.prepare('UPDATE produtos SET empresa_id = ? WHERE id = ?');
  let separados = 0;
  for (const p of produtos) {
    const nome = empresaDoFornecedor(p.fornecedor);
    if (!nome) { if (refazer) atualizar.run(null, p.id); continue; }
    criar.run(nome);
    atualizar.run(buscar.get(nome).id, p.id);
    separados++;
  }
  // ao refazer, empresas que ficaram sem nenhum produto saem das abas
  if (refazer) db.prepare('DELETE FROM empresas WHERE id NOT IN (SELECT empresa_id FROM produtos WHERE empresa_id IS NOT NULL)').run();
  return separados;
}

module.exports = { empresaDoFornecedor, separarPorFornecedor };
