// Copia as bibliotecas usadas pela tela de node_modules para public/vendor/ (a tela funciona sem internet).
// Rodar depois de atualizar as dependências: npm run vendor
const fs = require('node:fs');
const path = require('node:path');

const raiz = path.join(__dirname, '..');
const destino = path.join(raiz, 'public', 'vendor');
fs.mkdirSync(destino, { recursive: true });

const arquivos = [
  // leitura do código de barras (CODE-128) e do QR code da nota, feita no navegador. Licença Apache-2.0.
  ['node_modules/@zxing/library/umd/index.min.js', 'zxing.min.js'],
];

for (const [origem, nome] of arquivos) {
  fs.copyFileSync(path.join(raiz, origem), path.join(destino, nome));
  console.log(`Copiado: public/vendor/${nome}`);
}
