// Banco de dados SQLite (embutido no Node, sem instalar nada à parte).
// O arquivo fica em dados/estoque.db — para backup, basta copiar esse arquivo.
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { separarPorFornecedor } = require('./empresas');

const PASTA_DADOS = path.join(__dirname, '..', 'dados');
fs.mkdirSync(PASTA_DADOS, { recursive: true });

const db = new DatabaseSync(path.join(PASTA_DADOS, 'estoque.db'));
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
  tipo        TEXT NOT NULL CHECK (tipo IN ('entrada','saida','ajuste','importacao')),
  quantidade  REAL NOT NULL,
  observacao  TEXT,
  usuario     TEXT,
  criado_em   TEXT NOT NULL DEFAULT (datetime('now','localtime'))
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

module.exports = db;
