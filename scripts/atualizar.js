// Deixa o sistema pronto depois de um "git pull". Roda sozinho:
//   - pelo gancho .githooks/post-merge, logo depois do git pull (com --depois-do-pull);
//   - pelo iniciar.bat, antes de subir o servidor.
// Passos: liga os ganchos do git nesta pasta, instala as bibliotecas se o package-lock mudou,
// mostra a situação do certificado da SEFAZ e, depois do pull, reinicia o servidor
// (o iniciar.bat sobe de novo sozinho, já com a versão nova e as migrações do banco).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, execSync } = require('node:child_process');

const RAIZ = path.join(__dirname, '..');
const DEPOIS_DO_PULL = process.argv.includes('--depois-do-pull');
const PORTA = Number(process.env.PORTA) || 3000;

// No Caixa03 o git não está no PATH.
function acharGit() {
  for (const git of ['git', 'C:\\Program Files\\Git\\cmd\\git.exe', 'C:\\Program Files (x86)\\Git\\cmd\\git.exe']) {
    try {
      execFileSync(git, ['--version'], { stdio: 'ignore' });
      return git;
    } catch {}
  }
  return null;
}

function ligarGanchos() {
  const git = acharGit();
  if (!git) return console.log('Aviso: não achei o git; o git pull não vai preparar tudo sozinho.');
  let atual = '';
  try { atual = execFileSync(git, ['config', 'core.hooksPath'], { cwd: RAIZ, encoding: 'utf8' }).trim(); } catch {}
  if (atual === '.githooks') return;
  execFileSync(git, ['config', 'core.hooksPath', '.githooks'], { cwd: RAIZ });
  console.log('Pronto: daqui em diante, cada git pull já instala o que precisa e reinicia o sistema.');
}

// Instala as bibliotecas só quando o package-lock.json mudou desde a última instalação.
function instalarSeMudou() {
  const hash = crypto.createHash('sha1').update(fs.readFileSync(path.join(RAIZ, 'package-lock.json'))).digest('hex');
  const marca = path.join(RAIZ, 'node_modules', '.instalado-com.sha1');
  if (fs.existsSync(marca) && fs.readFileSync(marca, 'utf8') === hash) return;
  console.log('Instalando as bibliotecas novas (npm install)...');
  execSync('npm install --no-audit --no-fund', { cwd: RAIZ, stdio: 'inherit' });
  fs.writeFileSync(marca, hash);
}

function mostrarCertificado() {
  let s;
  try {
    s = require('../src/sefaz').situacao();
  } catch (e) {
    return console.log(`SEFAZ: não consegui conferir o certificado (${e.message}).`);
  }
  if (s.sem_config) return console.log('SEFAZ: certificado ainda não configurado. Para ligar, dê dois cliques em configurar-sefaz.bat.');
  if (s.erro) return console.log(`SEFAZ: atenção: ${s.erro}. Para refazer, dê dois cliques em configurar-sefaz.bat.`);
  const vence = s.vence_em.split('-').reverse().join('/');
  const aviso = s.dias_para_vencer <= 30 ? ` (faltam ${s.dias_para_vencer} dias: providencie a renovação)` : '';
  console.log(`SEFAZ: certificado de ${s.titular}, vence em ${vence}${aviso}.`);
}

// Encerra o servidor que está rodando na porta; o iniciar.bat percebe e sobe a versão nova.
function reiniciarServidor() {
  let pids = [];
  try {
    const ps = `Get-NetTCPConnection -LocalPort ${PORTA} -State Listen -ErrorAction SilentlyContinue | `
      + 'ForEach-Object { Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue } | '
      + "Where-Object { $_.ProcessName -eq 'node' } | ForEach-Object { $_.Id }";
    pids = execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' }).split(/\s+/).filter(Boolean);
  } catch {}
  if (!pids.length) return console.log('O sistema não estava aberto: dê dois cliques no iniciar.bat para ligar.');
  for (const pid of new Set(pids)) {
    try { execFileSync('taskkill', ['/PID', pid, '/F'], { stdio: 'ignore' }); } catch {}
  }
  console.log('Sistema reiniciado com a versão nova. Se a janela do Controle de Estoque parou, feche-a e abra o iniciar.bat.');
}

const passos = [ligarGanchos, instalarSeMudou, mostrarCertificado, ...(DEPOIS_DO_PULL ? [reiniciarServidor] : [])];
for (const passo of passos) {
  try {
    passo();
  } catch (e) {
    console.log(`Aviso: ${e.message}`);
  }
}
