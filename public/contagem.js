// Página Contagem (#/contagem): pente fino no estoque. O estoquista escreve ou cola a lista "produto  quantidade",
// o sistema acha cada produto (com a empresa), ele confere o que ficou em dúvida e aplica tudo de uma vez.
// Usa os utilitários de app.js (api, esc, avisar, qtdProduto…) e de baixa.js (camposQuantidade, ligarBusca, novoIdOperacao).

const CHAVE_CONTAGEM = 'contagem-texto';
const lerRascunho = () => { try { return localStorage.getItem(CHAVE_CONTAGEM) || ''; } catch { return ''; } };
const guardarRascunho = (t) => { try { localStorage.setItem(CHAVE_CONTAGEM, t); } catch {} };

// Unidades escritas de jeitos diferentes viram a mesma ("unid", "un", "u" → "und").
const SINONIMOS_UNIDADE = { un: 'und', unid: 'und', unidade: 'und', u: 'und', uni: 'und', caixa: 'cx', pc: 'pct', pacote: 'pct', fd: 'fardo' };
function unidadeCanonica(u) {
  if (!u) return null;
  let t = String(u).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]/g, '');
  if (t.length > 2 && t.endsWith('s')) t = t.slice(0, -1);
  return SINONIMOS_UNIDADE[t] || t;
}

const textoNumero = (n) => (n == null ? '' : String(n).replace('.', ','));

// Números escritos na linha → campos de quantidade do produto escolhido. Com fator: "3 cx 4 und" = 3 caixas + 4 soltas;
// um número só com a unidade menor ("40 und") vai para as soltas. aviso = algo que vale a pena conferir.
function quantidadesPara(p, numeros) {
  const r = { quantidade: '', quantidade_menor: '', aviso: '' };
  if (!numeros?.length) return r;
  const [a, b] = numeros;
  if (!p.fator) {
    r.quantidade = textoNumero(a.valor);
    if (b) r.aviso = `Escrito "${a.valor} ${a.unidade || ''} ${b.valor} ${b.unidade || ''}": este produto não tem caixa/unidade, confira`;
    return r;
  }
  const menor = unidadeCanonica(p.unidade_menor);
  const ehMenor = (n) => n.unidade && unidadeCanonica(n.unidade) === menor && menor !== unidadeCanonica(p.unidade);
  if (!b) {
    if (ehMenor(a)) r.quantidade_menor = textoNumero(a.valor); else r.quantidade = textoNumero(a.valor);
    return r;
  }
  const [cx, soltas] = ehMenor(a) && !ehMenor(b) ? [b, a] : [a, b];
  r.quantidade = textoNumero(cx.valor);
  r.quantidade_menor = textoNumero(soltas.valor);
  return r;
}

// Total contado na unidade dos lotes (como lerQuantidade no servidor). null = sem quantidade.
function baseContada(i) {
  const ler = (v) => { const s = String(v ?? '').trim(); return s === '' ? null : Number(s.replace(',', '.')); };
  const maior = ler(i.quantidade);
  const menor = i.produto?.fator ? ler(i.quantidade_menor) : null;
  if (maior == null && menor == null) return null;
  if ([maior, menor].some((n) => n != null && !(Number.isFinite(n) && n >= 0))) return NaN;
  return Math.round(((maior || 0) * (i.produto?.fator || 1) + (menor || 0)) * 1000) / 1000;
}

// Arquivo .csv: troca o separador por TAB (as vírgulas de "2,5" dentro de aspas ficam). .txt vai como está.
function csvParaTexto(texto) {
  const linhas = texto.split(/\r?\n/);
  const sep = (linhas[0].match(/;/g) || []).length >= (linhas[0].match(/,/g) || []).length ? ';' : ',';
  return linhas.map((linha) => {
    const celulas = [];
    let atual = '', aspas = false;
    for (const c of linha) {
      if (c === '"') aspas = !aspas;
      else if (c === sep && !aspas) { celulas.push(atual.trim()); atual = ''; }
      else atual += c;
    }
    celulas.push(atual.trim());
    return celulas.filter(Boolean).join('\t');
  }).filter((l) => !/^produto\b/i.test(l)).join('\n'); // tira o cabeçalho "produto;quantidade"
}

PAGINAS.contagem = async () => {
  app.innerHTML = `
    <h1>Contagem</h1>
    <p class="dica topo-dica">Pente fino no estoque: escreva um produto por linha com a quantidade que contou.
      O sistema acha o produto (e a empresa) e você confere antes de gravar. Produto que não estiver na lista não muda.</p>
    <div class="cartao contagem-entrada">
      <div class="campo"><label for="contagem-texto">Produto e quantidade, um por linha</label>
        <textarea id="contagem-texto" rows="10" spellcheck="false" placeholder="Coca 600 = 12&#10;Salame = 3 cx 4 und&#10;oleo de soja = 5&#10;farinha francesa = 2,5"></textarea></div>
      <details class="contagem-ajuda"><summary>Como escrever</summary>
        <ul>
          <li>Um produto por linha: <b>nome = quantidade</b>. O "=" (ou ; : -) separa o nome dos números e evita confusão com produtos como "Coca 600".</li>
          <li>Não precisa do nome completo: "caldo galinha", "pao castanha" acham o produto. Sem acento também serve.</li>
          <li>Produto em caixa com unidades soltas: <b>Salame = 3 cx 4 und</b> (ou "3 + 4").</li>
          <li>Anotou no papel? Digite no bloco de notas do celular e cole aqui. Planilha: copie as duas colunas (nome e quantidade) e cole, ou abra um arquivo .csv/.txt.</li>
          <li>O que o sistema não tiver certeza aparece em amarelo para você escolher. Nada é gravado sem você confirmar, e é feito um backup do banco antes.</li>
        </ul>
      </details>
      <div class="acoes">
        <button class="botao primario" type="button" id="contagem-conferir">Conferir</button>
        <label class="botao contagem-arquivo">Abrir arquivo<input type="file" id="contagem-arquivo" accept=".txt,.csv,text/plain,text/csv" hidden></label>
        <button class="botao" type="button" id="contagem-limpar">Limpar</button>
      </div>
    </div>
    <div id="contagem-conferencia"></div>`;

  const elTexto = document.getElementById('contagem-texto');
  const elConf = document.getElementById('contagem-conferencia');
  elTexto.value = lerRascunho();
  elTexto.oninput = () => guardarRascunho(elTexto.value);

  document.getElementById('contagem-arquivo').onchange = async (e) => {
    const arquivo = e.target.files[0];
    e.target.value = '';
    if (!arquivo) return;
    if (/\.xlsx?$/i.test(arquivo.name)) { avisar('Planilha: copie as colunas nome e quantidade e cole no campo', 'erro'); return; }
    const texto = await arquivo.text();
    elTexto.value = /\.csv$/i.test(arquivo.name) ? csvParaTexto(texto) : texto;
    guardarRascunho(elTexto.value);
    avisar(`Arquivo "${arquivo.name}" aberto: toque em Conferir`);
  };

  document.getElementById('contagem-limpar').onclick = () => {
    if (elTexto.value.trim() && !confirm('Apagar o texto da contagem?')) return;
    elTexto.value = '';
    guardarRascunho('');
    elConf.innerHTML = '';
  };

  document.getElementById('contagem-conferir').onclick = async () => {
    try {
      const { linhas } = await api('/api/contagem/conferir', { method: 'POST', body: { texto: elTexto.value } });
      mostrarConferencia(elConf, linhas.map((l) => {
        const item = { ...l, ignorar: false };
        Object.assign(item, l.produto ? quantidadesPara(l.produto, l.numeros) : { quantidade: '', quantidade_menor: '', aviso: '' });
        return item;
      }));
      elConf.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (e) { avisar(e.message, 'erro'); }
  };
};

// O que falta numa linha para poder aplicar ('' = pronta).
function pendencia(i) {
  if (i.ignorar) return '';
  if (!i.produto) return i.sugestoes.length ? 'Escolha o produto (ou ignore a linha)' : 'Nenhum produto parecido. Busque outro ou ignore a linha';
  const base = baseContada(i);
  if (base == null) return 'Faltou a quantidade';
  if (Number.isNaN(base)) return 'Quantidade inválida';
  return '';
}

function mostrarConferencia(el, itens) {
  let operacaoId = null; // mesmo id se tocar Aplicar duas vezes (não lança em dobro)

  const linhaHtml = (i, k) => {
    const falta = pendencia(i);
    const repetido = i.produto && !i.ignorar && itens.filter((x) => !x.ignorar && x.produto?.id === i.produto.id).length > 1;
    const classe = i.ignorar ? 'ignorada' : falta ? 'precisa' : 'pronta';
    let corpo;
    if (i.ignorar) {
      corpo = '<div class="contagem-produto"><small>Linha ignorada: não muda nada.</small></div>';
    } else if (i.produto) {
      const p = i.produto;
      corpo = `<div class="contagem-produto">
          <div class="nome">${esc(p.nome)}</div>
          <small><span class="contagem-empresa">${esc(p.empresa || 'Sem empresa')}</span> · tinha ${qtdProduto(p.estoque_base, p)}${p.fator ? ` · ${textoFator(p)}` : ''}</small>
          ${repetido ? '<span class="selo info">Em mais de uma linha: soma</span>' : ''}
        </div>
        <div class="carrinho-qtd">${camposQuantidade(p, i.quantidade, i.quantidade_menor)}</div>`;
    } else {
      corpo = `<div class="contagem-produto">
          ${i.sugestoes.length ? '<small>Qual destes?</small>' : ''}
          <div class="contagem-sugestoes">${i.sugestoes.map((s, n) => `
            <button type="button" class="resultado" data-sugestao="${n}"><span>${esc(s.nome)}</span><small>${esc(s.empresa || 'Sem empresa')}</small></button>`).join('')}
          </div>
          <input class="busca contagem-busca" type="search" placeholder="Buscar outro produto…" autocomplete="off" aria-label="Buscar produto para a linha ${i.linha}">
          <div class="resultados"></div>
        </div>`;
    }
    return `<div class="contagem-linha ${classe}" data-k="${k}">
      <div class="contagem-escrito">Linha ${i.linha}: <q>${esc(i.texto)}</q></div>
      ${corpo}
      <div class="contagem-rodape">
        <span class="falta-texto">${esc(falta || i.aviso || '')}</span>
        ${i.produto && !i.ignorar ? '<button type="button" class="botao" data-trocar>Trocar produto</button>' : ''}
        <button type="button" class="botao" data-ignorar>${i.ignorar ? 'Usar a linha' : 'Ignorar'}</button>
      </div>
    </div>`;
  };

  const desenhar = () => {
    if (!itens.length) { el.innerHTML = '<div class="cartao vazio">Nenhuma linha com produto.</div>'; return; }
    const precisam = itens.map((i, k) => [i, k]).filter(([i]) => pendencia(i));
    const resto = itens.map((i, k) => [i, k]).filter(([i]) => !pendencia(i));
    const prontas = itens.filter((i) => !i.ignorar && !pendencia(i));
    const produtos = new Set(prontas.map((i) => i.produto.id)).size;
    el.innerHTML = `
      ${precisam.length ? `<h2>Precisa de você (${precisam.length})</h2>
        <div class="carrinho">${precisam.map(([i, k]) => linhaHtml(i, k)).join('')}</div>` : ''}
      <h2>Prontos (${resto.length})</h2>
      <div class="carrinho">${resto.map(([i, k]) => linhaHtml(i, k)).join('') || '<div class="vazio">Nenhum ainda.</div>'}</div>
      <div class="baixa-erro" id="contagem-erro" hidden></div>
      <div class="acoes">
        <button class="botao primario" type="button" id="contagem-aplicar" ${precisam.length || !produtos ? 'disabled' : ''}>
          ${precisam.length ? `Resolva ${precisam.length} linha${precisam.length === 1 ? '' : 's'} acima` : `Gravar contagem de ${produtos} produto${produtos === 1 ? '' : 's'}`}</button>
      </div>
      <p class="dica">Cada produto passa a ter a quantidade contada (fica no histórico como ajuste). Antes de gravar é feito um backup do banco.</p>`;

    // busca de produto nas linhas sem produto
    el.querySelectorAll('.contagem-busca').forEach((input) => {
      const k = Number(input.closest('.contagem-linha').dataset.k);
      ligarBusca(input, input.nextElementSibling, (p) => escolher(k, p));
    });
  };

  const escolher = (k, p) => {
    const i = itens[k];
    i.produto = { ...p, estoque_base: p.estoque_base };
    Object.assign(i, quantidadesPara(p, i.numeros));
    operacaoId = null;
    desenhar();
  };

  el.oninput = (e) => {
    const linha = e.target.closest('.contagem-linha');
    if (!linha || !e.target.dataset.campo) return;
    const i = itens[Number(linha.dataset.k)];
    i[e.target.dataset.campo] = e.target.value;
    i.aviso = '';
    operacaoId = null;
  };
  // ao sair do campo, redesenha só se a linha mudou de pronta para pendente (ou o contrário)
  el.onchange = (e) => {
    const linha = e.target.closest('.contagem-linha');
    if (!linha || !e.target.dataset.campo) return;
    const pronta = !pendencia(itens[Number(linha.dataset.k)]);
    if (pronta !== linha.classList.contains('pronta')) desenhar();
  };

  el.onclick = async (e) => {
    const linha = e.target.closest('.contagem-linha');
    if (linha) {
      const i = itens[Number(linha.dataset.k)];
      const sugestao = e.target.closest('[data-sugestao]');
      if (sugestao) { escolher(Number(linha.dataset.k), i.sugestoes[Number(sugestao.dataset.sugestao)]); return; }
      if (e.target.closest('[data-ignorar]')) { i.ignorar = !i.ignorar; operacaoId = null; desenhar(); return; }
      if (e.target.closest('[data-trocar]')) {
        if (!i.sugestoes.length) i.sugestoes = [i.produto];
        i.produto = null;
        operacaoId = null;
        desenhar();
        return;
      }
    }
    const botao = e.target.closest('#contagem-aplicar');
    if (!botao || botao.disabled) return;
    const prontas = itens.filter((i) => !i.ignorar && !pendencia(i));
    const n = new Set(prontas.map((i) => i.produto.id)).size;
    if (!confirm(`Gravar a contagem? ${n} produto${n === 1 ? '' : 's'} vão ficar com a quantidade contada.`)) return;
    botao.disabled = true;
    operacaoId ||= novoIdOperacao();
    try {
      const r = await api('/api/contagem/aplicar', {
        method: 'POST',
        body: {
          operacao_id: operacaoId,
          itens: prontas.map((i) => ({ produto_id: i.produto.id, quantidade: i.quantidade, quantidade_menor: i.quantidade_menor })),
        },
      });
      guardarRascunho('');
      document.getElementById('contagem-texto').value = '';
      mostrarResultado(el, r);
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      avisar(`Contagem gravada: ${r.ajustados.length} produtos`);
    } catch (erro) {
      const elErro = document.getElementById('contagem-erro');
      elErro.textContent = `Nada foi gravado. ${erro.message}`;
      elErro.hidden = false;
      botao.disabled = false;
    }
  };

  desenhar();
}

// Depois de gravar: o que mudou, separado por empresa.
function mostrarResultado(el, r) {
  const porEmpresa = new Map();
  for (const a of r.ajustados) {
    const nome = a.empresa || 'Sem empresa';
    if (!porEmpresa.has(nome)) porEmpresa.set(nome, []);
    porEmpresa.get(nome).push(a);
  }
  const empresas = [...porEmpresa.keys()].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  el.innerHTML = `
    <div class="cartao contagem-feita">
      <h2>Contagem gravada</h2>
      <p>${r.ajustados.length} produto${r.ajustados.length === 1 ? '' : 's'} contado${r.ajustados.length === 1 ? '' : 's'},
        ${r.mudaram} com quantidade diferente do sistema. Backup: <code>${esc(r.backup)}</code></p>
    </div>
    ${empresas.map((nome) => `
      <h2>${esc(nome)}</h2>
      <div class="lista">${porEmpresa.get(nome).map((a) => `
        <a class="item contagem-feito" href="#/produto/${a.produto_id}">
          <span class="nome">${esc(a.nome)}</span>
          <small>${a.diferenca ? `${esc(a.antes)} → <b>${esc(a.agora)}</b>` : `${esc(a.agora)} (igual)`}</small>
        </a>`).join('')}</div>`).join('')}`;
}
