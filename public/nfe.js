// Entrada pela nota fiscal (NF-e): importar o XML, ler a chave pela foto do DANFE ou digitada,
// conferir os itens e lançar. Usa os utilitários de app.js (api, esc, avisar, qtdProduto, qtd, num, data, dataHora).

PAGINAS.entrada = () => paginaEntrada();
PAGINAS.nota = (id) => (id ? paginaNota(id) : paginaEntrada());
MENU_PAI.nota = 'entrada';

const reais = (v, casas = 2) => (v == null ? '—' : Number(v).toLocaleString('pt-BR', {
  style: 'currency', currency: 'BRL', minimumFractionDigits: 2, maximumFractionDigits: casas,
}));
const semAcentoNfe = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const arred = (n) => Math.round(n * 1000) / 1000;
const lerNum = (v) => Number(String(v ?? '').trim().replace(',', '.'));
const chaveFormatada = (c) => String(c).replace(/(\d{4})(?=\d)/g, '$1 ');

// Dígito verificador da chave de acesso (módulo 11), igual ao servidor.
function chaveValida(texto) {
  const c = String(texto ?? '').replace(/\D/g, '');
  if (c.length !== 44) return null;
  let soma = 0;
  let peso = 2;
  for (let i = 42; i >= 0; i--) {
    soma += Number(c[i]) * peso;
    peso = peso === 9 ? 2 : peso + 1;
  }
  const resto = soma % 11;
  return (resto < 2 ? 0 : 11 - resto) === Number(c[43]) ? c : null;
}

// fetch que devolve também os campos extras do erro (sem_config, aguardar…).
async function pedir(url, opcoes) {
  const r = await fetch(url, opcoes);
  const corpo = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, corpo };
}

// ---------- página: Entrada ----------
async function paginaEntrada() {
  app.innerHTML = `
    <h1>Entrada de mercadoria</h1>
    <div class="cartao nfe-importar" id="nfe-importar">
      <p class="nfe-titulo">Pela nota fiscal</p>
      <div class="nfe-botoes">
        <label class="botao primario">Importar XML da nota
          <input type="file" id="nfe-xml" accept=".xml,text/xml,application/xml" multiple hidden></label>
        <label class="botao">Foto da nota (DANFE)
          <input type="file" id="nfe-foto" accept="image/*" capture="environment" hidden></label>
      </div>
      <form class="nfe-chave" id="nfe-form-chave" autocomplete="off">
        <input id="nfe-chave" inputmode="numeric" placeholder="ou digite a chave de acesso (44 números)" aria-label="Chave de acesso">
        <button class="botao" type="submit">Buscar</button>
      </form>
      <p class="nfe-contagem" id="nfe-contagem"></p>
      <div class="nfe-msg" id="nfe-msg" hidden></div>
      <p class="dica">O XML o fornecedor manda por e-mail. A foto serve para ler o código de barras da chave no DANFE (o papel que vem com a mercadoria); a foto não é guardada.</p>
      <p class="dica" id="nfe-sefaz"></p>
    </div>
    <p class="dica">Entrada sem nota: abra o produto em <a class="nfe-link" href="#/produtos">Produtos</a> e use "+ Entrada".</p>
    <h2>Notas importadas</h2>
    <div class="lista" id="nfe-lista"><div class="vazio">Carregando…</div></div>`;

  document.getElementById('nfe-xml').onchange = (e) => importarArquivos([...e.target.files], e.target);
  document.getElementById('nfe-foto').onchange = (e) => lerFoto(e.target.files[0], e.target);
  const campoChave = document.getElementById('nfe-chave');
  campoChave.oninput = () => {
    const n = campoChave.value.replace(/\D/g, '').length;
    document.getElementById('nfe-contagem').textContent = n ? `${n} de 44 números` : '';
  };
  document.getElementById('nfe-form-chave').onsubmit = (e) => {
    e.preventDefault();
    const chave = chaveValida(campoChave.value);
    if (!chave) return mensagem(campoChave.value.replace(/\D/g, '').length === 44
      ? 'Essa chave tem um número errado (o último número não confere). Confira digitando de novo.'
      : 'A chave de acesso tem 44 números. Confira no DANFE, embaixo do código de barras.', 'erro');
    buscarChave(chave);
  };

  // no computador também dá para arrastar o arquivo XML para o quadro
  const quadro = document.getElementById('nfe-importar');
  quadro.ondragover = (e) => { e.preventDefault(); quadro.classList.add('arrastando'); };
  quadro.ondragleave = () => quadro.classList.remove('arrastando');
  quadro.ondrop = (e) => {
    e.preventDefault();
    quadro.classList.remove('arrastando');
    const xmls = [...e.dataTransfer.files].filter((f) => /\.xml$/i.test(f.name));
    if (xmls.length) importarArquivos(xmls);
  };

  await Promise.all([carregarNotas(), mostrarSefaz()]);
}

function mensagem(html, tipo = 'info') {
  const el = document.getElementById('nfe-msg');
  if (!el) return;
  el.innerHTML = html; // quem chama já passou o texto por esc()
  el.className = `nfe-msg ${tipo}`;
  el.hidden = !html;
}

async function carregarNotas() {
  const notas = await api('/api/nfe/notas');
  const el = document.getElementById('nfe-lista');
  if (!el) return;
  el.innerHTML = notas.length ? notas.map((n) => `
    <a class="item nfe-nota" href="#/nota/${n.id}">
      <div class="info">
        <div class="nome">NF ${esc(n.numero || '?')} · ${esc(n.emitente_nome || n.emitente_cnpj || 'fornecedor')}</div>
        <div class="sub">emissão ${data(n.emissao)} · ${n.itens} ${n.itens === 1 ? 'item' : 'itens'} · ${reais(n.valor_total)}</div>
      </div>
      ${n.status === 'lancada' ? `<span class="selo ok">Lançada ${data(n.lancada_em)}</span>` : '<span class="selo alerta">Falta conferir</span>'}
    </a>`).join('') : '<div class="vazio">Nenhuma nota importada ainda.</div>';
}

async function mostrarSefaz() {
  const el = document.getElementById('nfe-sefaz');
  try {
    const s = await api('/api/sefaz/status');
    if (!el) return;
    if (s.bloqueado_ate) el.innerHTML = `<span class="selo perigo">SEFAZ bloqueada</span> consultas demais; tente depois das ${esc(new Date(s.bloqueado_ate).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }))}.`;
    else if (s.configurado) {
      const perto = s.dias_para_vencer <= 30;
      el.innerHTML = `Baixar pela SEFAZ: certificado de ${esc(s.titular || s.cnpj)}, vence em ${data(s.vence_em)}`
        + `${perto ? ` <span class="selo alerta">faltam ${s.dias_para_vencer} dias</span>` : ''}${s.erro ? ` <span class="selo perigo">${esc(s.erro)}</span>` : ''}`;
    } else if (s.sem_config) el.textContent = 'Baixar pela SEFAZ: o certificado digital não está configurado. A foto e a chave só acham notas que já foram importadas.';
    else el.innerHTML = `Baixar pela SEFAZ: <span class="selo perigo">${esc(s.erro || 'com problema')}</span>`;
  } catch { /* sem a situação do certificado a página funciona igual */ }
}

async function importarArquivos(arquivos, input) {
  if (!arquivos.length) return;
  mensagem(esc(`Importando ${arquivos.length === 1 ? 'a nota' : `${arquivos.length} notas`}…`));
  const resultados = [];
  for (const arquivo of arquivos) {
    const r = await pedir('/api/nfe/importar', { method: 'POST', headers: { 'Content-Type': 'application/xml' }, body: arquivo })
      .catch((e) => ({ ok: false, corpo: { erro: e.message } }));
    resultados.push({ arquivo, ...r });
  }
  if (input) input.value = '';
  if (resultados.length === 1) {
    const [r] = resultados;
    if (!r.ok) return mensagem(esc(`${r.arquivo.name}: ${r.corpo.erro || 'não foi possível importar'}`), 'erro');
    avisar(r.corpo.nova ? 'Nota importada' : r.corpo.status === 'lancada' ? 'Esta nota já foi lançada antes' : 'Esta nota já estava importada');
    location.hash = `#/nota/${r.corpo.id}`;
    return;
  }
  const linhas = resultados.map((r) => (r.ok
    ? `${esc(r.arquivo.name)}: ${r.corpo.nova ? 'importada' : r.corpo.status === 'lancada' ? 'já tinha sido lançada' : 'já estava importada'}`
    : `${esc(r.arquivo.name)}: <b>${esc(r.corpo.erro || 'erro')}</b>`));
  mensagem(linhas.join('<br>'), resultados.every((r) => r.ok) ? 'info' : 'erro');
  carregarNotas();
}

async function buscarChave(chave) {
  mensagem(`Procurando a nota <b>${esc(chaveFormatada(chave))}</b>… (se precisar baixar da SEFAZ, pode levar alguns segundos)`);
  const r = await pedir('/api/nfe/chave', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chave }),
  }).catch((e) => ({ ok: false, corpo: { erro: e.message } }));
  if (r.ok) {
    avisar(r.corpo.baixada ? 'Nota baixada da SEFAZ' : r.corpo.status === 'lancada' ? 'Esta nota já foi lançada antes' : 'Nota encontrada');
    location.hash = `#/nota/${r.corpo.id}`;
    return;
  }
  let html = `Chave: ${esc(chaveFormatada(chave))}<br><b>${esc(r.corpo.erro || 'Não foi possível buscar a nota')}</b>`;
  if (r.corpo.sem_config) {
    html += '<br>Esta nota ainda não está no sistema e o download pela SEFAZ não está funcionando. '
      + 'Importe o XML que o fornecedor mandou por e-mail (botão "Importar XML da nota"). '
      + 'Para baixar sozinho pela SEFAZ, o certificado digital A1 da padaria precisa ser configurado no computador do caixa (arquivo dados/config.json, modelo em config.exemplo.json).';
  }
  mensagem(html, r.corpo.aguardar ? 'info' : 'erro');
}

// ---------- foto do DANFE: a imagem é lida aqui no navegador e descartada ----------
let zxingCarregando = null;
function carregarZxing() {
  if (window.ZXing) return Promise.resolve();
  zxingCarregando ||= new Promise((ok, falha) => {
    const s = document.createElement('script');
    s.src = 'vendor/zxing.min.js';
    s.onload = ok;
    s.onerror = () => { zxingCarregando = null; falha(new Error('Não foi possível carregar o leitor de código de barras')); };
    document.head.appendChild(s);
  });
  return zxingCarregando;
}

// Primeira chave de 44 números (com dígito certo) num texto: código de barras (só a chave) ou QR code (link com a chave).
function chaveDoTexto(texto) {
  const so = String(texto || '');
  for (const m of so.match(/\d{44}/g) || []) if (chaveValida(m)) return m;
  return chaveValida(so.replace(/\D/g, ''));
}

// Desenha a imagem girada e reduzida (lado maior no máximo = maxLado) num canvas, só a parte pedida
// (frações da largura e da altura: [x0, x1, y0, y1]). O leitor de barras se confunde com texto do lado do código,
// então vale tentar pedaços da foto (o código da chave fica no alto, à direita, no DANFE).
function desenhar(img, maxLado, giro, parte = [0, 1, 0, 1]) {
  const escala = Math.min(1, maxLado / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.round(img.naturalWidth * escala);
  const h = Math.round(img.naturalHeight * escala);
  const deitado = giro === 90 || giro === 270;
  const [largura, altura] = deitado ? [h, w] : [w, h];
  const [x0, x1, y0, y1] = parte;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(largura * (x1 - x0));
  canvas.height = Math.round(altura * (y1 - y0));
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.translate(largura / 2 - largura * x0, altura / 2 - altura * y0);
  ctx.rotate((giro * Math.PI) / 180);
  ctx.drawImage(img, -w / 2, -h / 2, w, h);
  return canvas;
}

// Tenta vários giros, tamanhos e partes da foto até achar uma chave válida. Devolve a chave ou null.
async function decodificarChave(img, aoTentar) {
  const Z = window.ZXing;
  const dicas = new Map([[Z.DecodeHintType.TRY_HARDER, true]]);
  const barras = new Z.Code128Reader();
  const qr = new Z.QRCodeReader();
  // [lado maior, giro, parte da foto, leitor]. Na resolução cheia as barras finas não se misturam; reduzida, a leitura é mais rápida.
  const tentativas = [[1600, 0, [0, 1, 0, 1], 'qr']];
  for (const giro of [0, 90, 270, 180]) {
    tentativas.push(
      [3200, giro, [0.4, 1, 0, 0.5], 'barras'], // alto, à direita: onde fica no DANFE
      [3200, giro, [0, 1, 0, 0.5], 'barras'],
      [3200, giro, [0, 0.6, 0, 0.5], 'barras'],
      [3200, giro, [0.2, 0.8, 0.3, 0.8], 'barras'],
      [3200, giro, [0, 1, 0.5, 1], 'barras'],
      [1400, giro, [0, 1, 0, 1], 'barras'], // foto bem de perto, só do código
    );
  }
  for (let i = 0; i < tentativas.length; i++) {
    const [lado, giro, parte, tipo] = tentativas[i];
    aoTentar?.(i + 1, tentativas.length);
    await new Promise((r) => setTimeout(r, 0)); // deixa a tela atualizar
    const canvas = desenhar(img, lado, giro, parte);
    try {
      const fonte = new Z.HTMLCanvasElementLuminanceSource(canvas);
      for (const Binarizador of tipo === 'qr' ? [Z.HybridBinarizer] : [Z.GlobalHistogramBinarizer, Z.HybridBinarizer]) {
        try {
          const leitor = tipo === 'qr' ? qr : barras;
          const chave = chaveDoTexto(leitor.decode(new Z.BinaryBitmap(new Binarizador(fonte)), dicas).getText());
          if (chave) return chave;
        } catch { /* não achou desta vez */ }
      }
    } finally {
      canvas.width = canvas.height = 0; // libera a memória da imagem
    }
  }
  return null;
}

async function lerFoto(arquivo, input) {
  if (!arquivo) return;
  const url = URL.createObjectURL(arquivo);
  let img = new Image();
  try {
    mensagem('Lendo o código de barras da foto…');
    await carregarZxing();
    await new Promise((ok, falha) => { img.onload = ok; img.onerror = () => falha(new Error('Não deu para abrir a foto')); img.src = url; });
    const chave = await decodificarChave(img, (i, total) => mensagem(`Lendo o código de barras da foto… (${i} de ${total})`));
    if (!chave) {
      mensagem('Não consegui ler o código de barras. Tire outra foto mais de perto, com o código de barras da chave bem nítido, '
        + 'reto e com boa luz, ou digite a chave de acesso (os 44 números embaixo do código de barras).', 'erro');
      return;
    }
    document.getElementById('nfe-chave').value = chaveFormatada(chave);
    await buscarChave(chave);
  } catch (e) {
    mensagem(esc(e.message), 'erro');
  } finally {
    URL.revokeObjectURL(url); // a foto não é guardada nem enviada
    img.src = '';
    img = null;
    if (input) input.value = '';
  }
}

// ---------- página: conferência da nota ----------
const ROTULO_ORIGEM = { lembrada: ['ok', 'lembrado'], ean: ['info', 'mesmo código de barras'], escolhido: ['neutro', 'escolhido agora'] };

// Igual ao servidor: produto com fator e nota em "UN" → 1 und; nota em caixa → 1 cx = fator und.
function multiplicadorPadrao(p, unidadeNota) {
  if (!p.fator) return 1;
  const u = semAcentoNfe(unidadeNota);
  const solta = ['un', 'und', 'unid', 'unidade', 'unidades', 'pc', 'pç', 'pca', 'peca'].includes(u) || (p.unidade_menor && u === semAcentoNfe(p.unidade_menor));
  return solta ? 1 : p.fator;
}

// Produto que recebe a entrada: o escolhido ou, se for criar, um "produto" só com a unidade digitada.
const produtoDoItem = (it) => (it.acao === 'novo' ? { unidade: it.novo.unidade } : it.produto);

async function paginaNota(id) {
  const [nota, abas] = await Promise.all([api(`/api/nfe/notas/${id}`), api('/api/empresas')]);
  empresas = abas.empresas;
  const lancada = nota.status === 'lancada';
  const itens = nota.itens.map((it) => {
    const s = it.sugestao;
    const mult = s.multiplicador ?? 1;
    return {
      ...it,
      acao: s.acao,
      origem: s.origem,
      produto: s.produto || null,
      multiplicador: mult,
      emCaixas: !!(s.produto?.fator && mult >= s.produto.fator && arred(mult / s.produto.fator) % 1 === 0),
      novo: { nome: it.descricao, unidade: (it.unidade || '').toLowerCase(), empresa_id: nota.empresa_sugerida ?? '' },
      buscando: false,
    };
  });

  app.innerHTML = `
    <a class="voltar" href="#/entrada">← Entrada</a>
    <h1>NF ${esc(nota.numero || '?')}${nota.serie ? ` <small class="nfe-serie">série ${esc(nota.serie)}</small>` : ''}</h1>
    <div class="resumo-produto">
      <div class="bloco nfe-fornecedor"><small>Fornecedor</small><strong>${esc(nota.emitente_nome || '—')}</strong><small>${esc(nota.emitente_cnpj || '')}</small></div>
      <div class="bloco"><small>Emissão</small><strong>${data(nota.emissao)}</strong></div>
      <div class="bloco"><small>Total da nota</small><strong>${reais(nota.valor_total)}</strong></div>
    </div>
    ${lancada ? `<p><span class="selo ok">Lançada no estoque em ${dataHora(nota.lancada_em)}</span> Esta nota não pode ser lançada de novo.</p>` : `
    <p class="dica">Confira cada item: qual produto do estoque é, quanto 1 unidade da nota vale e a validade. O sistema lembra as escolhas para a próxima nota deste fornecedor.</p>`}
    <p class="nfe-chave-texto">Chave ${esc(chaveFormatada(nota.chave))}</p>
    <div class="nfe-itens" id="nfe-itens"></div>
    ${lancada ? '' : `
    <div class="cartao nfe-rodape">
      <p id="nfe-resumo"></p>
      <div class="acoes">
        <button class="botao entrada" id="nfe-lancar">Lançar entrada</button>
        <button class="botao excluir" id="nfe-apagar">Apagar nota</button>
      </div>
    </div>`}`;

  const lista = document.getElementById('nfe-itens');
  if (lancada) {
    lista.innerHTML = cartoesLancada(nota);
    return;
  }

  const acharItem = (el) => itens.find((it) => String(it.n) === el.closest('[data-n]')?.dataset.n);
  const redesenhar = (it) => {
    const el = lista.querySelector(`[data-n="${it.n}"]`);
    if (el) el.outerHTML = cartaoItem(it);
    atualizarResumo();
  };
  const atualizarResumo = () => {
    const falta = itens.filter((it) => !it.acao).length;
    const ignorados = itens.filter((it) => it.acao === 'ignorar').length;
    document.getElementById('nfe-resumo').innerHTML = `${itens.length - falta - ignorados} de ${itens.length} itens prontos para entrar`
      + `${ignorados ? ` · ${ignorados} ignorado${ignorados === 1 ? '' : 's'}` : ''}`
      + `${falta ? ` · <b class="nfe-falta">falta escolher ${falta}</b>` : ''}`;
  };
  lista.innerHTML = itens.map(cartaoItem).join('');
  atualizarResumo();

  let timerBusca;
  lista.onclick = async (e) => {
    const it = acharItem(e.target);
    if (!it) return;
    const b = e.target.closest('[data-acao]');
    if (b) {
      const acao = b.dataset.acao;
      if (acao === 'buscar') { it.buscando = !it.buscando; redesenhar(it); lista.querySelector(`[data-n="${it.n}"] .nfe-busca`)?.focus(); }
      else if (acao === 'novo' || acao === 'ignorar') {
        it.acao = acao; it.buscando = false;
        if (acao === 'novo') { it.multiplicador = 1; it.emCaixas = false; }
        redesenhar(it);
      }
      return;
    }
    const escolhido = e.target.closest('[data-produto]');
    if (escolhido) {
      const p = it.resultados?.find((r) => String(r.id) === escolhido.dataset.produto);
      if (!p) return;
      it.produto = p;
      it.acao = 'produto';
      it.origem = 'escolhido';
      it.buscando = false;
      it.multiplicador = multiplicadorPadrao(p, it.unidade);
      it.emCaixas = !!(p.fator && it.multiplicador === p.fator);
      redesenhar(it);
    }
  };
  lista.oninput = (e) => {
    const it = acharItem(e.target);
    if (!it) return;
    const alvo = e.target;
    if (alvo.matches('.nfe-busca')) {
      clearTimeout(timerBusca);
      timerBusca = setTimeout(async () => {
        const termo = alvo.value.trim();
        const caixa = alvo.closest('.nfe-item').querySelector('.nfe-resultados');
        if (!termo) { caixa.innerHTML = ''; return; }
        try {
          it.resultados = (await api(`/api/produtos?${new URLSearchParams({ busca: termo })}`)).slice(0, 12);
          caixa.innerHTML = it.resultados.length ? it.resultados.map((p) => `
            <button type="button" class="nfe-resultado" data-produto="${p.id}">
              <span>${esc(p.nome)}</span><small>${esc(p.empresa || 'sem empresa')} · ${esc(p.unidade || 'sem unidade')}${p.fator ? ` (1 = ${num(p.fator)} ${esc(p.unidade_menor)})` : ''}</small>
            </button>`).join('') : '<div class="vazio">Nenhum produto com esse nome. Tente outra palavra ou crie um produto novo.</div>';
        } catch (erro) { avisar(erro.message, 'erro'); }
      }, 200);
    } else if (alvo.matches('.nfe-mult')) {
      const v = lerNum(alvo.value);
      const p = produtoDoItem(it);
      it.multiplicador = v > 0 ? arred(p?.fator && it.emCaixas ? v * p.fator : v) : NaN;
      alvo.closest('.nfe-item').querySelector('.nfe-previa').innerHTML = previa(it);
    } else if (alvo.matches('.nfe-validade')) it.validade = alvo.value;
    else if (alvo.matches('.nfe-novo-nome')) it.novo.nome = alvo.value;
    else if (alvo.matches('.nfe-novo-unidade')) {
      it.novo.unidade = alvo.value.trim().toLowerCase();
      const el = alvo.closest('.nfe-item');
      el.querySelector('.nfe-un-produto').textContent = it.novo.unidade || 'unidade';
      el.querySelector('.nfe-previa').innerHTML = previa(it);
    }
  };
  lista.onchange = async (e) => {
    const it = acharItem(e.target);
    if (!it) return;
    if (e.target.matches('.nfe-em')) {
      // trocou entre caixa e unidade: o número digitado continua o mesmo, muda o que ele quer dizer
      const v = lerNum(lista.querySelector(`[data-n="${it.n}"] .nfe-mult`).value);
      it.emCaixas = e.target.value === 'maior';
      it.multiplicador = v > 0 ? arred(it.emCaixas ? v * it.produto.fator : v) : NaN;
      redesenhar(it);
    } else if (e.target.matches('.nfe-novo-empresa')) {
      try {
        const emp = await escolherEmpresa(e.target);
        it.novo.empresa_id = emp ? emp.id : '';
      } catch (erro) { avisar(erro.message, 'erro'); }
      redesenhar(it);
    }
  };

  document.getElementById('nfe-apagar').onclick = async () => {
    if (!confirm('Apagar esta nota importada? Nada foi lançado no estoque ainda. Dá para importar o XML de novo depois.')) return;
    try {
      await api(`/api/nfe/notas/${id}`, { method: 'DELETE' });
      avisar('Nota apagada');
      location.hash = '#/entrada';
    } catch (erro) { avisar(erro.message, 'erro'); }
  };

  const botao = document.getElementById('nfe-lancar');
  botao.onclick = async () => {
    const falta = itens.find((it) => !it.acao);
    if (falta) return avisar(`Item ${falta.n}: escolha o produto, crie um novo ou ignore`, 'erro');
    const ruim = itens.find((it) => it.acao !== 'ignorar' && !(it.multiplicador > 0));
    if (ruim) return avisar(`Item ${ruim.n}: preencha quanto 1 ${ruim.unidade || 'unidade'} da nota vale`, 'erro');
    const semNome = itens.find((it) => it.acao === 'novo' && !it.novo.nome.trim());
    if (semNome) return avisar(`Item ${semNome.n}: dê um nome ao produto novo`, 'erro');
    const entram = itens.filter((it) => it.acao !== 'ignorar').length;
    if (!confirm(`Lançar a entrada de ${entram} ${entram === 1 ? 'item' : 'itens'} no estoque?`)) return;
    botao.disabled = true;
    try {
      const r = await api(`/api/nfe/notas/${id}/lancar`, {
        method: 'POST',
        body: {
          itens: itens.map((it) => ({
            n: it.n, acao: it.acao, produto_id: it.produto?.id, multiplicador: it.multiplicador, validade: it.validade || null,
            novo: it.acao === 'novo' ? it.novo : undefined,
          })),
        },
      });
      avisar(`Entrada lançada: ${r.lancados} ${r.lancados === 1 ? 'item' : 'itens'}`);
      await paginaNota(id);
    } catch (erro) {
      avisar(erro.message, 'erro');
      botao.disabled = false;
    }
  };
}

// "2 CX na nota → 24 und = 2 cx · custo R$ 1,25 por und"
function previa(it) {
  const p = produtoDoItem(it);
  if (!p) return '';
  if (!(it.multiplicador > 0)) return '<span class="nfe-falta">Preencha a conversão</span>';
  const base = arred(it.quantidade * it.multiplicador);
  const daNota = `${num(it.quantidade)} ${esc(it.unidade)} na nota`;
  const entra = p.fator ? `${qtd(base, p.unidade_menor)} = <b>${qtdProduto(base, p)}</b>` : `<b>${qtdProduto(base, p)}</b>`;
  const custo = it.valor_unit / it.multiplicador;
  const porUn = p.fator ? p.unidade_menor : p.unidade || 'unidade';
  // nota numa unidade e produto em outra, valendo 1 = 1: provavelmente falta acertar a conversão
  const igual = (a, b) => { const n = (u) => (['un', 'und', 'unid', 'unidade'].includes(semAcentoNfe(u)) ? 'un' : semAcentoNfe(u)); return n(a) === n(b); };
  const confira = !p.fator && p.unidade && it.unidade && it.multiplicador === 1 && !igual(it.unidade, p.unidade)
    ? `<br><span class="selo alerta">Confira: a nota está em ${esc(it.unidade)} e o produto em ${esc(p.unidade)}</span>` : '';
  return `${daNota} → ${entra} · custo ${reais(custo, 4)} por ${esc(porUn)}${p.fator ? ` (${reais(custo * p.fator)} por ${esc(p.unidade || 'embalagem')})` : ''}${confira}`;
}

function cartaoItem(it) {
  const p = produtoDoItem(it);
  const botaoAcao = (acao, rotulo) => `<button type="button" class="botao pequeno ${it.acao === acao || (acao === 'buscar' && it.buscando) ? 'marcado' : ''}" data-acao="${acao}">${rotulo}</button>`;
  let escolha;
  if (it.acao === 'produto') {
    const [cor, rot] = ROTULO_ORIGEM[it.origem] || ROTULO_ORIGEM.escolhido;
    escolha = `<div class="nfe-produto">→ <a href="#/produto/${it.produto.id}" target="_blank" rel="noopener">${esc(it.produto.nome)}</a>
      <span class="selo ${cor}">${rot}</span>${it.produto.ativo === 0 ? '<span class="selo neutro">não pedir</span>' : ''}</div>`;
  } else if (it.acao === 'novo') {
    escolha = `<div class="grade nfe-novo">
      <div class="campo largo"><label>Nome do produto novo</label><input class="nfe-novo-nome" value="${esc(it.novo.nome)}"></div>
      <div class="campo"><label>Unidade</label><input class="nfe-novo-unidade" list="nfe-unidades" value="${esc(it.novo.unidade)}" placeholder="cx, pct, und, kg…"></div>
      <div class="campo"><label>Empresa</label><select class="nfe-novo-empresa">
        <option value="">Sem empresa</option>${opcoesEmpresa(it.novo.empresa_id)}<option value="nova">+ Nova empresa…</option></select></div>
      <datalist id="nfe-unidades">${UNIDADES.map((u) => `<option value="${esc(u)}">`).join('')}</datalist>
    </div>`;
  } else if (it.acao === 'ignorar') {
    escolha = '<p class="nfe-ignorado">Ignorado: este item não entra no estoque (o sistema lembra para as próximas notas).</p>';
  } else {
    escolha = '<p><span class="selo alerta">Escolha o produto</span></p>';
  }

  const conversao = p && it.acao !== 'ignorar' ? `
    <div class="nfe-campos">
      <div class="campo"><label>Conversão</label>
        <div class="nfe-conv">1 ${esc(it.unidade || 'un')} da nota =
          <input class="nfe-mult" inputmode="decimal" value="${it.multiplicador > 0 ? String(arred(p.fator && it.emCaixas ? it.multiplicador / p.fator : it.multiplicador)).replace('.', ',') : ''}" aria-label="Quanto 1 ${esc(it.unidade)} da nota vale">
          ${p.fator ? `<select class="nfe-em" aria-label="Caixa ou unidade">
            <option value="maior" ${it.emCaixas ? 'selected' : ''}>${esc(p.unidade || 'embalagem')} (de ${num(p.fator)})</option>
            <option value="menor" ${it.emCaixas ? '' : 'selected'}>${esc(p.unidade_menor)}</option></select>`
            : `<span class="nfe-un-produto">${esc(p.unidade || 'unidade')}</span>`}
        </div>
      </div>
      <div class="campo"><label>Validade${it.validade ? '' : ' (opcional)'}</label><input type="date" class="nfe-validade" value="${esc(it.validade || '')}"></div>
    </div>
    <p class="nfe-previa">${previa(it)}</p>` : '';

  return `
    <div class="cartao nfe-item ${it.acao ? `acao-${it.acao}` : 'falta'}" data-n="${it.n}">
      <div class="nfe-item-topo">
        <div class="nome">${it.n}. ${esc(it.descricao)}</div>
        <div class="sub">cód. ${esc(it.codigo)}${it.ean ? ` · EAN ${esc(it.ean)}` : ''} · ${num(it.quantidade)} ${esc(it.unidade)} × ${reais(it.valor_unit, 4)} = ${reais(it.valor_total)}</div>
      </div>
      ${escolha}
      ${conversao}
      <div class="nfe-acoes-item">
        ${botaoAcao('buscar', it.acao === 'produto' ? 'Trocar produto' : 'Escolher produto')}
        ${botaoAcao('novo', 'Criar produto novo')}
        ${botaoAcao('ignorar', 'Ignorar este item')}
      </div>
      ${it.buscando ? `<div class="nfe-escolher">
        <input class="busca nfe-busca" type="search" placeholder="Buscar produto pelo nome…" autocomplete="off">
        <div class="nfe-resultados"></div></div>` : ''}
    </div>`;
}

// Nota já lançada: o que entrou no estoque.
function cartoesLancada(nota) {
  const linhas = (nota.lancamentos || []).map((m) => `<tr><td>${esc(m.nome)}</td><td>+${qtdProduto(m.quantidade, m)}</td></tr>`).join('');
  const ignorados = nota.itens.filter((it) => it.sugestao.acao === 'ignorar');
  return `
    <div class="tabela-rolagem"><table><thead><tr><th>Produto</th><th>Entrou</th></tr></thead>
      <tbody>${linhas || '<tr><td colspan="2">Nenhum item entrou no estoque.</td></tr>'}</tbody></table></div>
    ${ignorados.length ? `<p class="dica">Ignorados: ${ignorados.map((it) => esc(it.descricao)).join(', ')}</p>` : ''}`;
}
