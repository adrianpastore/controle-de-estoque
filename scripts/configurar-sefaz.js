// Assistente do certificado digital A1 para baixar notas na SEFAZ (configurar-sefaz.bat).
// Acha o arquivo .pfx (ou exporta o certificado instalado no Windows), confere a senha,
// mostra de quem é e até quando vale, e grava dados/config.json (fora do git).
// Não consulta a SEFAZ: o primeiro teste é feito pela tela, com uma nota de verdade.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { execFileSync } = require('node:child_process');
const { abrirCertificado } = require('../src/sefaz');

const RAIZ = path.join(__dirname, '..');
const DADOS = path.join(RAIZ, 'dados');
const ARQUIVO_CONFIG = process.env.CONFIG_SEFAZ ? path.resolve(process.env.CONFIG_SEFAZ) : path.join(DADOS, 'config.json');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const linhas = rl[Symbol.asyncIterator](); // fila: nenhuma linha digitada se perde
let escondido = false; // enquanto digita a senha, nada aparece na tela
rl._writeToOutput = (s) => { if (!escondido) rl.output.write(s); };
async function lerLinha(texto) {
  process.stdout.write(texto);
  const { value, done } = await linhas.next();
  return done ? '' : value;
}
const perguntar = async (texto) => (await lerLinha(texto)).trim();
async function perguntarSenha(texto) {
  escondido = true;
  try {
    return await lerLinha(texto);
  } finally {
    escondido = false;
    process.stdout.write('\n');
  }
}

const dataBR = (d) => d.toISOString().slice(0, 10).split('-').reverse().join('/');

// Arquivos .pfx/.p12 nas pastas onde costumam estar.
function procurarPfx() {
  const pastas = [DADOS, 'C:\\Certificado', 'C:\\Certificados', ...['Desktop', 'Área de Trabalho', 'Downloads', 'Documents', 'Documentos']
    .map((p) => path.join(os.homedir(), p)), path.join(os.homedir(), 'OneDrive', 'Área de Trabalho')];
  const achados = [];
  for (const pasta of pastas) {
    try {
      for (const f of fs.readdirSync(pasta)) if (/\.(pfx|p12)$/i.test(f)) achados.push(path.join(pasta, f));
    } catch {}
  }
  return [...new Set(achados)];
}

const powershell = (comando, env = {}) => execFileSync('powershell', ['-NoProfile', '-Command', comando],
  { encoding: 'utf8', env: { ...process.env, ...env } });

// Certificados com chave privada instalados no Windows (usuário e computador).
function certificadosDoWindows() {
  try {
    const json = powershell('Get-ChildItem Cert:\\CurrentUser\\My, Cert:\\LocalMachine\\My -ErrorAction SilentlyContinue | '
      + 'Where-Object { $_.HasPrivateKey -and $_.NotAfter -gt (Get-Date) } | '
      + "Select-Object @{n='caminho';e={$_.PSPath -replace '^.*::',''}}, Subject, @{n='vence';e={$_.NotAfter.ToString('dd/MM/yyyy')}} | "
      + 'ConvertTo-Json -Compress');
    const lista = json.trim() ? JSON.parse(json) : [];
    return Array.isArray(lista) ? lista : [lista];
  } catch {
    return [];
  }
}

// Exporta para dados/certificado.pfx com a senha escolhida (passada por variável de ambiente, não na linha de comando).
function exportarDoWindows(cert, senha) {
  const destino = path.join(DADOS, 'certificado.pfx');
  fs.mkdirSync(DADOS, { recursive: true });
  powershell(`$s = ConvertTo-SecureString -String $env:SENHA_PFX -Force -AsPlainText; `
    + `Export-PfxCertificate -Cert 'Cert:\\${cert.caminho}' -FilePath '${destino.replace(/'/g, "''")}' -Password $s | Out-Null`,
  { SENHA_PFX: senha });
  return destino;
}

async function escolherArquivo() {
  const achados = procurarPfx();
  console.log('\nOnde está o certificado A1 da padaria?');
  achados.forEach((f, i) => console.log(`  ${i + 1}) ${f}`));
  console.log('  W) Exportar o certificado instalado no Windows');
  console.log('  Ou cole o caminho completo do arquivo .pfx');
  const r = await perguntar('> ');
  if (/^\d+$/.test(r) && achados[Number(r) - 1]) return { arquivo: achados[Number(r) - 1] };
  if (/^w$/i.test(r)) {
    const certs = certificadosDoWindows();
    if (!certs.length) {
      console.log('Não achei certificado com chave privada instalado no Windows.');
      return null;
    }
    certs.forEach((c, i) => console.log(`  ${i + 1}) ${c.Subject.split(',')[0].replace(/^CN=/, '')} (vence ${c.vence})`));
    const n = Number(await perguntar('Qual? > '));
    const cert = certs[n - 1];
    if (!cert) return null;
    const senha = await perguntarSenha('Escolha uma senha para o arquivo exportado: ');
    if (!senha) return null;
    try {
      const arquivo = exportarDoWindows(cert, senha);
      console.log(`Exportado para ${arquivo}`);
      return { arquivo, senha };
    } catch {
      console.log('O Windows não deixou exportar este certificado (a chave foi instalada como "não exportável").');
      console.log('Peça o arquivo .pfx a quem instalou o certificado (contador ou certificadora).');
      return null;
    }
  }
  const caminho = r.replace(/^"|"$/g, '');
  if (caminho && fs.existsSync(caminho)) return { arquivo: path.resolve(caminho) };
  console.log('Arquivo não encontrado.');
  return null;
}

async function principal() {
  console.log('Configurar o certificado digital (SEFAZ) do Controle de Estoque');
  if (fs.existsSync(ARQUIVO_CONFIG)) {
    const r = await perguntar('Já existe uma configuração. Refazer? (s/n) > ');
    if (!/^s/i.test(r)) return;
  }

  let escolha = null;
  for (let i = 0; i < 3 && !escolha; i++) escolha = await escolherArquivo();
  if (!escolha) return console.log('\nNada foi gravado.');

  let cert = null;
  let senha = escolha.senha;
  for (let i = 0; i < 3 && !cert; i++) {
    if (!senha) senha = await perguntarSenha('Senha do certificado: ');
    try {
      cert = abrirCertificado(fs.readFileSync(escolha.arquivo), senha);
    } catch (e) {
      console.log(e.message);
      senha = null;
    }
  }
  if (!cert) return console.log('\nNada foi gravado.');

  console.log(`\nCertificado de: ${cert.titular}`);
  console.log(`Válido até:     ${dataBR(cert.validoAte)}`);
  if (cert.validoAte < new Date()) return console.log('Este certificado está VENCIDO. Nada foi gravado.');

  let cnpj = cert.cnpj;
  if (cnpj) console.log(`CNPJ:           ${cnpj}`);
  while (!/^\d{14}$/.test(cnpj || '')) cnpj = (await perguntar('CNPJ da padaria (só números) > ')).replace(/\D/g, '');

  const config = { certificado: escolha.arquivo, senha, cnpj, uf: '43', ambiente: 1 };
  fs.mkdirSync(path.dirname(ARQUIVO_CONFIG), { recursive: true });
  fs.writeFileSync(ARQUIVO_CONFIG, JSON.stringify(config, null, 2));
  console.log(`\nPronto: configuração gravada em ${ARQUIVO_CONFIG} (este arquivo não vai para o git).`);
  console.log('Agora teste pela tela: Entrada > digite ou fotografe a chave de uma nota recente da padaria.');
}

principal()
  .catch((e) => console.log(`\nErro: ${e.message}`))
  .finally(() => rl.close());
