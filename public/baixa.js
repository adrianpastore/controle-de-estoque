// Páginas de baixa: baixa rápida na lista de produtos, baixa de vários produtos de uma vez (#/baixa)
// e listas prontas (#/listas, #/lista/:id). Usa os utilitários de app.js (api, esc, avisar, qtdProduto…).
// Baixa = abastecimento dos freezers / consumo interno (não é venda).

// ---------- partes usadas em mais de um lugar ----------

// Campos de quantidade: com fator, caixas + unidades soltas (como no lançamento da ficha); sem fator, um campo só.
function camposQuantidade(p, quantidade = '1', quantidadeMenor = '') {
  const campo = (nome, valor, unidade, rotulo) => `<label class="qtd-campo">
      <input name="${nome}" data-campo="${nome}" inputmode="decimal" value="${esc(valor ?? '')}" placeholder="0" aria-label="${esc(rotulo)}">
      <span>${esc(unidade || '')}</span></label>`;
  if (!p.fator) return campo('quantidade', quantidade, p.unidade, `Quantidade de ${p.nome}`);
  return campo('quantidade', quantidade, p.unidade || 'cx', `${p.unidade || 'Embalagens'} de ${p.nome}`)
    + campo('quantidade_menor', quantidadeMenor, p.unidade_menor, `${p.unidade_menor} soltas de ${p.nome}`);
}

const textoFator = (p) => (p.fator ? `1 ${esc(p.unidade || 'cx')} = ${num(p.fator)} ${esc(p.unidade_menor)}` : '');

// "2" + "1,5" → "3,5" (para somar quando o produto já está no carrinho). Texto vazio ou inválido conta como 0.
function somarTexto(a, b) {
  const ler = (v) => { const n = Number(String(v ?? '').trim().replace(',', '.')); return Number.isFinite(n) ? n : 0; };
  const total = Math.round((ler(a) + ler(b)) * 1000) / 1000;
  return total ? String(total).replace('.', ',') : '';
}

// Busca de produto por palavras (a mesma da lista de Produtos). Tocar num resultado chama aoEscolher(produto).
function ligarBusca(input, resultados, aoEscolher) {
  let encontrados = [];
  let timer;
  let pedido = 0;
  const buscar = async () => {
    const termo = input.value.trim();
    const meu = ++pedido;
    if (!termo) { resultados.innerHTML = ''; return; }
    try {
      const lista = await api(`/api/produtos?${new URLSearchParams({ busca: termo })}`);
      if (meu !== pedido) return; // chegou resposta de uma busca antiga
      encontrados = lista.slice(0, 30);
      resultados.innerHTML = encontrados.length
        ? encontrados.map((p) => `<button type="button" class="resultado" data-id="${p.id}">
            <span>${esc(p.nome)}</span><small>tem ${qtdProduto(p.estoque_base, p)}</small></button>`).join('')
          + (lista.length > 30 ? `<p class="dica">Mostrando 30 de ${lista.length}. Digite mais para achar.</p>` : '')
        : '<div class="vazio">Nenhum produto encontrado.</div>';
    } catch (e) { avisar(e.message, 'erro'); }
  };
  input.oninput = () => { clearTimeout(timer); timer = setTimeout(buscar, 200); };
  resultados.onclick = (e) => {
    const b = e.target.closest('.resultado');
    const p = b && encontrados.find((x) => String(x.id) === b.dataset.id);
    if (!p) return;
    aoEscolher(p);
    input.value = '';
    resultados.innerHTML = '';
    input.focus();
  };
}

// Item com os dados do produto que a tela precisa (carrinho e listas usam o mesmo formato).
const itemDoProduto = (p, quantidade = '1', quantidadeMenor = '') => ({
  produto_id: p.produto_id ?? p.id, nome: p.nome, unidade: p.unidade, fator: p.fator, unidade_menor: p.unidade_menor,
  estoque_base: p.estoque_base, ativo: p.ativo, quantidade: quantidade ?? '', quantidade_menor: quantidadeMenor ?? '',
});

// Junta um item na lista: se o produto já está, soma as quantidades.
function juntarItem(itens, novo) {
  const ja = itens.find((i) => i.produto_id === novo.produto_id);
  if (!ja) { itens.push(novo); return; }
  ja.quantidade = somarTexto(ja.quantidade, novo.quantidade);
  ja.quantidade_menor = somarTexto(ja.quantidade_menor, novo.quantidade_menor);
}

const linhaItem = (i) => `
  <div class="carrinho-item" data-id="${i.produto_id}">
    <div class="carrinho-info">
      <div class="nome">${esc(i.nome)}</div>
      <small>tem ${qtdProduto(i.estoque_base, i)}${i.fator ? ` · ${textoFator(i)}` : ''}</small>
      ${i.ativo ? '' : '<span class="selo neutro">Não pedir</span>'}
      <div class="falta-texto"></div>
    </div>
    <div class="carrinho-qtd">${camposQuantidade(i, i.quantidade, i.quantidade_menor)}</div>
    <button type="button" class="botao-tirar" data-tirar aria-label="Tirar ${esc(i.nome)}">✕</button>
  </div>`;

// Os campos de quantidade de uma linha mudaram: copia para o item.
function lerCampo(itens, campo) {
  const linha = campo.closest('.carrinho-item');
  const item = linha && itens.find((i) => String(i.produto_id) === linha.dataset.id);
  if (item && campo.dataset.campo) item[campo.dataset.campo] = campo.value;
  return item;
}

// ---------- baixa rápida na lista de Produtos (chamada por paginaProdutos em app.js) ----------

async function abrirBaixaRapida(item) {
  const aberto = item.querySelector('.baixa-rapida');
  if (aberto) { aberto.querySelector('input').focus(); return; }
  if (item.dataset.abrindo) return;
  item.dataset.abrindo = '1';
  let p;
  try { p = await api(`/api/produtos/${item.dataset.id}`); } catch (e) { avisar(e.message, 'erro'); return; } finally { delete item.dataset.abrindo; }
  const form = document.createElement('form');
  form.className = 'baixa-rapida';
  form.autocomplete = 'off';
  form.innerHTML = `
    <div class="baixa-rapida-topo">Baixa de <b>${esc(p.nome)}</b> · tem ${qtdProduto(p.estoque_base, p)}${p.fator ? ` · ${textoFator(p)}` : ''}</div>
    <div class="baixa-rapida-linha">
      ${camposQuantidade(p)}
      <button class="botao saida" type="submit">Confirmar</button>
      <button class="botao" type="button" data-baixa-cancelar>Cancelar</button>
    </div>
    <div class="falta-texto"></div>`;
  form.onkeydown = (e) => { if (e.key === 'Escape') fecharBaixaRapida(item); };
  item.append(form);
  const primeiro = form.querySelector('input');
  primeiro.focus();
  primeiro.select();
}

function fecharBaixaRapida(item) {
  item.querySelector('.baixa-rapida')?.remove();
}

// Lança a saída. Devolve o produto atualizado (para redesenhar o item) ou null se deu erro.
async function confirmarBaixaRapida(form, item) {
  const botoes = form.querySelectorAll('button');
  botoes.forEach((b) => (b.disabled = true));
  try {
    const corpo = { tipo: 'saida', ...Object.fromEntries(new FormData(form).entries()) };
    const r = await api(`/api/produtos/${item.dataset.id}/movimentar`, { method: 'POST', body: corpo });
    const p = await api(`/api/produtos/${item.dataset.id}`);
    avisar(`Baixa de ${qtdProduto(r.lancado, p)} em ${p.nome} — agora tem ${qtdProduto(r.estoque_base, p)}`);
    return p;
  } catch (e) {
    form.querySelector('.falta-texto').textContent = e.message;
    avisar(e.message, 'erro');
    botoes.forEach((b) => (b.disabled = false));
    return null;
  }
}

// ---------- página: baixa de vários produtos de uma vez ----------

const CHAVE_CARRINHO = 'baixa-carrinho';

function novoIdOperacao() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

function atualizarItemCarrinho(i, p) {
  const antigo = Number(i.fator) || 1;
  const atual = Number(p.fator) || 1;
  let quantidade = i.quantidade;
  let menor = i.quantidade_menor;
  if ((antigo === 1) !== (atual === 1)) {
    if (atual === 1) {
      const ler = v => Number(String(v ?? '').replace(',', '.')) || 0;
      quantidade = String(Math.round((ler(quantidade) + ler(menor) / antigo) * 1000) / 1000).replace('.', ',');
    }
    menor = '';
  }
  return { ...itemDoProduto(p), quantidade, quantidade_menor: menor };
}

function lerCarrinho() {
  try {
    const c = JSON.parse(localStorage.getItem(CHAVE_CARRINHO));
    if (c && Array.isArray(c.itens)) return { itens: c.itens, observacao: String(c.observacao || ''), operacao_id: c.operacao_id, envio: c.envio };
  } catch {}
  return { itens: [], observacao: '' };
}
const guardarCarrinho = (c) => { try { localStorage.setItem(CHAVE_CARRINHO, JSON.stringify(c)); } catch {} };

PAGINAS.baixa = async () => {
  const carrinho = lerCarrinho();
  // O carrinho guardado pode estar velho: atualiza estoque e dados dos produtos (e tira os que foram excluídos).
  const [listas, atuais] = await Promise.all([
    api('/api/listas'),
    Promise.all(carrinho.itens.map((i) => api(`/api/produtos/${Number(i.produto_id)}`).catch((e) => (/não encontrado/.test(e.message) ? null : i)))), // sem conexão: fica como estava
  ]);
  const antes = carrinho.itens.length;
  carrinho.itens = carrinho.itens
    .map((i, k) => (atuais[k] ? atualizarItemCarrinho(i, atuais[k]) : null))
    .filter(Boolean);
  if (carrinho.itens.length < antes) avisar('Produto excluído foi tirado da baixa', 'erro');
  guardarCarrinho(carrinho);

  app.innerHTML = `
    <h1>Baixa</h1>
    <p class="dica topo-dica">Abastecimento dos freezers e consumo interno. Escolha os produtos, confira as quantidades e confirme.</p>
    <div class="cartao baixa-usar-lista">
      <select id="escolher-lista" aria-label="Lista pronta">
        <option value="">${listas.length ? 'Escolher lista pronta…' : 'Nenhuma lista pronta'}</option>
        ${listas.map((l) => `<option value="${l.id}">${esc(l.nome)} (${l.total})</option>`).join('')}
      </select>
      <button class="botao" type="button" id="usar-lista" ${listas.length ? '' : 'disabled'}>Usar lista</button>
      <a class="botao" href="#/listas">Listas prontas</a>
    </div>
    <input class="busca" id="baixa-busca" type="search" placeholder="Buscar produto para dar baixa…" autocomplete="off">
    <div class="resultados" id="baixa-resultados"></div>
    <h2 id="titulo-carrinho"></h2>
    <div class="carrinho" id="carrinho"></div>
    <div class="campo baixa-obs"><label for="baixa-obs">Observação (opcional)</label>
      <input id="baixa-obs" maxlength="300" placeholder="ex.: freezer da frente" value="${esc(carrinho.observacao)}"></div>
    <div class="baixa-erro" id="baixa-erro" hidden></div>
    <div class="acoes">
      <button class="botao saida" type="button" id="confirmar-baixa"></button>
      <button class="botao" type="button" id="limpar-baixa">Limpar</button>
    </div>`;

  const elCarrinho = document.getElementById('carrinho');
  const elErro = document.getElementById('baixa-erro');
  const btConfirmar = document.getElementById('confirmar-baixa');

  const salvar = () => {
    delete carrinho.operacao_id;
    delete carrinho.envio;
    guardarCarrinho(carrinho);
  };
  const desenhar = () => {
    const n = carrinho.itens.length;
    document.getElementById('titulo-carrinho').textContent = `Para dar baixa (${n})`;
    elCarrinho.innerHTML = n ? carrinho.itens.map(linhaItem).join('')
      : '<div class="vazio">Nenhum produto ainda. Busque acima ou use uma lista pronta.</div>';
    btConfirmar.textContent = `Dar baixa em ${n} produto${n === 1 ? '' : 's'}`;
    btConfirmar.disabled = !n;
    elErro.hidden = true;
  };

  ligarBusca(document.getElementById('baixa-busca'), document.getElementById('baixa-resultados'), (p) => {
    juntarItem(carrinho.itens, itemDoProduto(p));
    salvar();
    desenhar();
    avisar(`${p.nome}: adicionado`);
  });

  elCarrinho.oninput = (e) => { if (lerCampo(carrinho.itens, e.target)) salvar(); };
  elCarrinho.onclick = (e) => {
    const linha = e.target.closest('[data-tirar]')?.closest('.carrinho-item');
    if (!linha) return;
    carrinho.itens = carrinho.itens.filter((i) => String(i.produto_id) !== linha.dataset.id);
    salvar();
    desenhar();
  };
  document.getElementById('baixa-obs').oninput = (e) => { carrinho.observacao = e.target.value; salvar(); };

  document.getElementById('usar-lista').onclick = async () => {
    const id = document.getElementById('escolher-lista').value;
    if (!id) { avisar('Escolha uma lista', 'erro'); return; }
    try {
      const lista = await api(`/api/listas/${id}`);
      for (const i of lista.itens) juntarItem(carrinho.itens, itemDoProduto(i, i.quantidade == null ? '' : String(i.quantidade).replace('.', ','),
        i.quantidade_menor == null ? '' : String(i.quantidade_menor).replace('.', ',')));
      salvar();
      desenhar();
      avisar(lista.itens.length ? `Lista "${lista.nome}" carregada: confira as quantidades` : `A lista "${lista.nome}" está vazia`);
    } catch (e) { avisar(e.message, 'erro'); }
  };

  document.getElementById('limpar-baixa').onclick = () => {
    if (carrinho.itens.length && !confirm('Tirar todos os produtos da baixa?')) return;
    carrinho.itens = [];
    carrinho.observacao = '';
    document.getElementById('baixa-obs').value = '';
    salvar();
    desenhar();
  };

  btConfirmar.onclick = async () => {
    if (!carrinho.itens.length) return;
    btConfirmar.disabled = true;
    elErro.hidden = true;
    elCarrinho.querySelectorAll('.carrinho-item').forEach((l) => { l.classList.remove('falta'); l.querySelector('.falta-texto').textContent = ''; });
    carrinho.operacao_id ||= novoIdOperacao();
    const corpo = carrinho.envio ||= {
      operacao_id: carrinho.operacao_id,
      itens: carrinho.itens.map((i) => ({ produto_id: i.produto_id, quantidade: i.quantidade, quantidade_menor: i.quantidade_menor })),
      observacao: carrinho.observacao,
    };
    guardarCarrinho(carrinho);
    // fetch direto (e não api()) para receber a lista dos que não têm estoque
    let r, resposta;
    try {
      r = await fetch('/api/baixa', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) });
      resposta = await r.json().catch(() => ({}));
    } catch {
      resposta = { erro: 'Sem conexão com o servidor' };
    }
    if (r && r.ok) {
      const n = resposta.lancados.length;
      avisar(`Baixa lançada em ${n} produto${n === 1 ? '' : 's'}`);
      carrinho.itens = [];
      carrinho.observacao = '';
      document.getElementById('baixa-obs').value = '';
      salvar();
      desenhar();
      return;
    }
    elErro.textContent = resposta.erro || `Erro ${r ? r.status : ''}`;
    elErro.hidden = false;
    for (const f of resposta.faltando || []) {
      const linha = elCarrinho.querySelector(`.carrinho-item[data-id="${Number(f.produto_id)}"]`);
      if (!linha) continue;
      linha.classList.add('falta');
      linha.querySelector('.falta-texto').textContent = `Pediu ${f.pedido}, só tem ${f.tem}`;
    }
    avisar(r ? 'Nada foi lançado' : 'Não foi possível confirmar a baixa. Tente de novo.', 'erro');
    btConfirmar.disabled = false;
  };

  desenhar();
};

// ---------- páginas: listas prontas ----------

PAGINAS.listas = async () => {
  const listas = await api('/api/listas');
  app.innerHTML = `
    <a class="voltar" href="#/baixa">← Voltar para a Baixa</a>
    <h1>Listas prontas</h1>
    <p class="dica topo-dica">Ex.: "Abastecimento do freezer". Na página Baixa, "Usar lista" coloca os produtos da lista para dar baixa.</p>
    <form class="cartao lista-nova" id="nova-lista" autocomplete="off">
      <input name="nome" maxlength="80" placeholder="Nome da nova lista" aria-label="Nome da nova lista" required>
      <button class="botao primario" type="submit">Criar lista</button>
    </form>
    <div class="lista listas-prontas">${listas.length ? listas.map((l) => `
      <a class="item" href="#/lista/${l.id}"><span class="nome">${esc(l.nome)}</span>
        <small>${l.total} produto${l.total === 1 ? '' : 's'}</small></a>`).join('')
      : '<div class="vazio">Nenhuma lista ainda.</div>'}</div>`;

  document.getElementById('nova-lista').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const { id } = await api('/api/listas', { method: 'POST', body: { nome: e.target.nome.value } });
      avisar('Lista criada: agora adicione os produtos');
      location.hash = `#/lista/${id}`;
    } catch (erro) { avisar(erro.message, 'erro'); }
  };
};

PAGINAS.lista = async (id) => {
  if (!id) { location.hash = '#/listas'; return; }
  const lista = await api(`/api/listas/${encodeURIComponent(id)}`);
  const itens = lista.itens.map((i) => itemDoProduto(i, i.quantidade == null ? '' : String(i.quantidade).replace('.', ','),
    i.quantidade_menor == null ? '' : String(i.quantidade_menor).replace('.', ',')));

  app.innerHTML = `
    <a class="voltar" href="#/listas">← Listas prontas</a>
    <div class="campo lista-nome"><label for="nome-lista">Nome da lista</label>
      <input id="nome-lista" maxlength="80" value="${esc(lista.nome)}"></div>
    <input class="busca" id="lista-busca" type="search" placeholder="Buscar produto para pôr na lista…" autocomplete="off">
    <div class="resultados" id="lista-resultados"></div>
    <h2 id="titulo-itens"></h2>
    <p class="dica">Quantidade padrão de cada produto. Muda sozinho ao sair do campo.</p>
    <div class="carrinho" id="itens-lista"></div>
    <div class="acoes">
      <button class="botao saida" type="button" id="usar-na-baixa">Usar na baixa</button>
      <button class="botao excluir" type="button" id="excluir-lista">Excluir lista</button>
    </div>`;

  const elItens = document.getElementById('itens-lista');
  const desenhar = () => {
    document.getElementById('titulo-itens').textContent = `Produtos (${itens.length})`;
    elItens.innerHTML = itens.length ? itens.map(linhaItem).join('') : '<div class="vazio">Nenhum produto. Busque acima para adicionar.</div>';
  };
  const salvarItens = async () => {
    try {
      await api(`/api/listas/${lista.id}`, {
        method: 'PUT',
        body: { itens: itens.map((i) => ({ produto_id: i.produto_id, quantidade: i.quantidade, quantidade_menor: i.quantidade_menor })) },
      });
      avisar('Lista salva');
      return true;
    } catch (e) { avisar(e.message, 'erro'); return false; }
  };

  ligarBusca(document.getElementById('lista-busca'), document.getElementById('lista-resultados'), async (p) => {
    if (itens.some((i) => i.produto_id === p.id)) { avisar(`${p.nome} já está na lista`, 'erro'); return; }
    itens.push(itemDoProduto(p));
    desenhar();
    await salvarItens();
  });

  elItens.oninput = (e) => lerCampo(itens, e.target);
  elItens.onchange = (e) => { if (e.target.dataset.campo) salvarItens(); };
  elItens.onclick = async (e) => {
    const linha = e.target.closest('[data-tirar]')?.closest('.carrinho-item');
    if (!linha) return;
    const k = itens.findIndex((i) => String(i.produto_id) === linha.dataset.id);
    if (k < 0) return;
    itens.splice(k, 1);
    desenhar();
    await salvarItens();
  };

  const elNome = document.getElementById('nome-lista');
  elNome.onchange = async () => {
    try {
      const r = await api(`/api/listas/${lista.id}`, { method: 'PUT', body: { nome: elNome.value } });
      lista.nome = r.nome;
      elNome.value = r.nome;
      avisar('Nome salvo');
    } catch (e) { elNome.value = lista.nome; avisar(e.message, 'erro'); }
  };

  document.getElementById('usar-na-baixa').onclick = () => {
    const carrinho = lerCarrinho();
    for (const i of itens) juntarItem(carrinho.itens, { ...i });
    delete carrinho.operacao_id;
    delete carrinho.envio;
    guardarCarrinho(carrinho);
    location.hash = '#/baixa';
  };

  document.getElementById('excluir-lista').onclick = async () => {
    if (!confirm(`Excluir a lista "${lista.nome}"? Os produtos e o estoque não mudam.`)) return;
    try {
      await api(`/api/listas/${lista.id}`, { method: 'DELETE' });
      avisar('Lista excluída');
      location.hash = '#/listas';
    } catch (e) { avisar(e.message, 'erro'); }
  };

  desenhar();
};

MENU_PAI.listas = 'baixa';
MENU_PAI.lista = 'baixa';
