// Banco de dados SQLite (embutido no Node, sem instalar nada à parte).
// O arquivo fica em dados/estoque.db — para backup, basta copiar esse arquivo.
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { separarPorFornecedor } = require('./empresas');

const PASTA_DADOS = path.join(__dirname, '..', 'dados');
fs.mkdirSync(PASTA_DADOS, { recursive: true });

// BANCO=caminho usa outro arquivo (para testar numa cópia, junto com PORTA=3999).
const ARQUIVO_BANCO = process.env.BANCO ? path.resolve(process.env.BANCO) : path.join(PASTA_DADOS, 'estoque.db');
const db = new DatabaseSync(ARQUIVO_BANCO);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS produtos (
  id              INTEGER PRIMARY KEY,
  nome            TEXT NOT NULL,
  unidade         TEXT,                      -- cx, pct, und, fardo, kg...
  estoque_minimo  REAL,                      -- NULL = sem mínimo
  fornecedor      TEXT,
  secao           TEXT NOT NULL DEFAULT 'Estoque',
  codigo_barras   TEXT,
  ativo           INTEGER NOT NULL DEFAULT 1, -- 0 = não pedir mais (amarelo na planilha)
  em_falta        INTEGER NOT NULL DEFAULT 0, -- 1 = não está tendo, mas tem que pedir (vermelho)
  nao_contado     INTEGER NOT NULL DEFAULT 0, -- 1 = "tem bastante", não foi contado
  precisa_revisao INTEGER NOT NULL DEFAULT 0, -- 1 = importação não entendeu algo
  observacao      TEXT,
  criado_em       TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- Cada entrada gera um lote; o estoque do produto é a soma dos lotes.
CREATE TABLE IF NOT EXISTS lotes (
  id          INTEGER PRIMARY KEY,
  produto_id  INTEGER NOT NULL REFERENCES produtos(id),
  quantidade  REAL NOT NULL,
  validade    TEXT,                          -- AAAA-MM-DD ou NULL
  custo_unit  REAL,
  criado_em   TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS movimentacoes (
  id          INTEGER PRIMARY KEY,
  produto_id  INTEGER NOT NULL REFERENCES produtos(id),
  tipo        TEXT NOT NULL CHECK (tipo IN ('entrada','saida','ajuste','importacao','perda','correcao')),
  quantidade  REAL NOT NULL,
  observacao  TEXT,
  usuario     TEXT,
  criado_em   TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  nota_id     INTEGER REFERENCES notas(id)
);

CREATE INDEX IF NOT EXISTS idx_lotes_produto ON lotes(produto_id);
CREATE INDEX IF NOT EXISTS idx_mov_produto ON movimentacoes(produto_id);

-- Empresa = de quem a padaria compra o produto (uma aba por empresa na tela).
CREATE TABLE IF NOT EXISTS empresas (
  id    INTEGER PRIMARY KEY,
  nome  TEXT NOT NULL UNIQUE COLLATE NOCASE
);
`);

// Migração: bancos criados antes das empresas ganham a coluna e a separação inicial.
const temEmpresa = db.prepare('PRAGMA table_info(produtos)').all().some((c) => c.name === 'empresa_id');
if (!temEmpresa) {
  db.exec('ALTER TABLE produtos ADD COLUMN empresa_id INTEGER REFERENCES empresas(id)');
  separarPorFornecedor(db);
}
db.exec('CREATE INDEX IF NOT EXISTS idx_produtos_empresa ON produtos(empresa_id)');

// Migração: caixa x unidade. fator = quantas unidades menores vêm em 1 unidade (ex.: 1 cx = 12 und).
// Com fator, lotes e movimentações guardam a quantidade na unidade menor; sem fator, na unidade normal.
const colunas = db.prepare('PRAGMA table_info(produtos)').all().map((c) => c.name);
if (!colunas.includes('fator')) db.exec('ALTER TABLE produtos ADD COLUMN fator REAL');
if (!colunas.includes('unidade_menor')) db.exec('ALTER TABLE produtos ADD COLUMN unidade_menor TEXT');

// Cópia do banco antes de uma migração que mexe em dados (VACUUM INTO grava uma cópia consistente, mesmo com WAL).
function backupAntes(motivo) {
  const pasta = path.join(path.dirname(ARQUIVO_BANCO), 'backup');
  fs.mkdirSync(pasta, { recursive: true });
  const d = new Date();
  const quando = new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 19).replace(/[T:]/g, '-'); // hora local
  const destino = path.join(pasta, `antes-${motivo}-${quando}.db`);
  db.exec(`VACUUM INTO '${destino.replace(/'/g, "''")}'`);
  console.log(`Backup feito antes da migração: ${destino}`);
}

db.exec(`
-- Listas prontas de baixa (ex.: abastecimento do freezer). Quantidade na unidade do produto (cx, fardo…),
-- mais as unidades soltas quando o produto tem fator.
CREATE TABLE IF NOT EXISTS listas (
  id         INTEGER PRIMARY KEY,
  nome       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  criado_em  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS lista_itens (
  id                INTEGER PRIMARY KEY,
  lista_id          INTEGER NOT NULL REFERENCES listas(id) ON DELETE CASCADE,
  produto_id        INTEGER NOT NULL REFERENCES produtos(id) ON DELETE CASCADE,
  quantidade        REAL,
  quantidade_menor  REAL,
  UNIQUE (lista_id, produto_id)
);

-- Notas fiscais (NF-e) importadas pelo XML. A chave de acesso (44 dígitos) não deixa lançar a mesma nota duas vezes.
CREATE TABLE IF NOT EXISTS notas (
  id             INTEGER PRIMARY KEY,
  chave          TEXT NOT NULL UNIQUE,
  numero         TEXT,
  serie          TEXT,
  emitente_cnpj  TEXT,
  emitente_nome  TEXT,
  emissao        TEXT,
  valor_total    REAL,
  xml            TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente','lancada')),
  importada_em   TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  lancada_em     TEXT
);

-- O que o sistema lembra de cada item de fornecedor: código do produto na nota → produto do estoque.
-- multiplicador = quanto 1 unidade da nota (uCom) vale na unidade em que os lotes do produto são guardados.
CREATE TABLE IF NOT EXISTS nfe_associacoes (
  id             INTEGER PRIMARY KEY,
  emitente_cnpj  TEXT NOT NULL,
  codigo         TEXT NOT NULL,
  ean            TEXT,
  descricao      TEXT,
  unidade_nota   TEXT,
  produto_id     INTEGER REFERENCES produtos(id) ON DELETE CASCADE,
  multiplicador  REAL NOT NULL DEFAULT 1,
  ignorar        INTEGER NOT NULL DEFAULT 0,
  UNIQUE (emitente_cnpj, codigo)
);
`);

// Migração: novos tipos de movimentação (perda = baixa de vencido; correcao = lote corrigido ou excluído)
// e ligação com a nota fiscal. O SQLite não altera um CHECK, então a tabela é recriada com os mesmos dados.
const sqlMov = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'movimentacoes'").get().sql;
if (!sqlMov.includes("'perda'")) {
  backupAntes('migracao-movimentacoes');
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec(`BEGIN;
    CREATE TABLE movimentacoes_nova (
      id          INTEGER PRIMARY KEY,
      produto_id  INTEGER NOT NULL REFERENCES produtos(id),
      tipo        TEXT NOT NULL CHECK (tipo IN ('entrada','saida','ajuste','importacao','perda','correcao')),
      quantidade  REAL NOT NULL,
      observacao  TEXT,
      usuario     TEXT,
      criado_em   TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      nota_id     INTEGER REFERENCES notas(id)
    );
    INSERT INTO movimentacoes_nova (id, produto_id, tipo, quantidade, observacao, usuario, criado_em)
      SELECT id, produto_id, tipo, quantidade, observacao, usuario, criado_em FROM movimentacoes;
    DROP TABLE movimentacoes;
    ALTER TABLE movimentacoes_nova RENAME TO movimentacoes;
    CREATE INDEX IF NOT EXISTS idx_mov_produto ON movimentacoes(produto_id);
    COMMIT;`);
  db.exec('PRAGMA foreign_keys = ON');
}

const colunasLote = db.prepare('PRAGMA table_info(lotes)').all().map((c) => c.name);
if (!colunasLote.includes('nota_id')) db.exec('ALTER TABLE lotes ADD COLUMN nota_id INTEGER REFERENCES notas(id)');

module.exports = db;
module.exports.backupAntes = backupAntes;
