// Separa os produtos em empresas a partir da coluna Fornecedor.
// Uso:  npm run empresas                 (só os produtos que estão sem empresa)
//       npm run empresas -- --refazer    (TODOS: desfaz escolhas feitas à mão na tela)
const db = require('../src/db');
const { separarPorFornecedor } = require('../src/empresas');

const refazer = process.argv.includes('--refazer');
db.exec('BEGIN');
try {
  const n = separarPorFornecedor(db, { refazer });
  db.exec('COMMIT');
  const sem = db.prepare('SELECT COUNT(*) n FROM produtos WHERE empresa_id IS NULL').get().n;
  const empresas = db.prepare(`SELECT e.nome, COUNT(p.id) n FROM empresas e LEFT JOIN produtos p ON p.empresa_id = e.id
    GROUP BY e.id ORDER BY n DESC, e.nome`).all();
  console.log(`${n} produtos colocados em empresas. ${sem} continuam sem empresa.\n`);
  for (const e of empresas) console.log(`  ${String(e.n).padStart(3)}  ${e.nome}`);
} catch (e) {
  db.exec('ROLLBACK');
  throw e;
}
