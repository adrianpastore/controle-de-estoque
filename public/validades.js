// Validades: ações nos lotes da ficha do produto e a página #/validades (vencidos e vencendo).
// Usa os utilitários de app.js (api, esc, avisar, qtdProduto, num, data, dataHora, diasAte).

// Texto puro da quantidade (para confirm(), que não entende HTML).
function textoQtd(base, p) {
  const d = document.createElement('div');
  d.innerHTML = qtdProduto(base, p);
  return d.textContent;
}

// "venceu há 2 dias", "vence hoje", "vence em 3 dias"
function textoDias(d) {
  if (d < 0) return `venceu há ${-d} dia${d === -1 ? '' : 's'}`;
  if (d === 0) return 'vence hoje';
  if (d === 1) return 'vence amanhã';
  return `vence em ${d} dias`;
}

// Número para preencher um campo: 2.5 → "2,5"
const campoNum = (n) => String(Math.round(n * 1000) / 1000).replace('.', ',');

// ---------- ficha do produto: lotes com saldo ----------
// HTML da seção "Lotes com saldo" (cada lote com corrigir, excluir e, se vencido, baixa como vencido).
function tabelaLotes(p) {
  if (!p.lotes.length) return '<div class="tabela-rolagem"><div class="vazio">Nenhum lote com saldo.</div></div>';
  return `<div class="lotes">${p.lotes.map((l) => {
    const d = diasAte(l.validade);
    const selo = d == null ? '' : d < 0 ? '<span class="selo perigo">Vencido</span>'
      : d <= 7 ? `<span class="selo alerta">${esc(textoDias(d))}</span>` : '';
    // quantidade atual nos campos de correção (com fator: cheias + soltas)
    const cheias = p.fator ? Math.floor(Math.round(l.quantidade / p.fator * 1000) / 1000) : l.quantidade;
    const soltas = p.fator ? l.quantidade - cheias * p.fator : 0;
    return `
    <div class="lote" data-lote="${l.id}">
      <div class="lote-linha">
        <div class="lote-info">
          <div><b>${l.validade ? `val. ${data(l.validade)}` : 'sem validade'}</b> ${selo}</div>
          <small>entrada ${dataHora(l.criado_em)}</small>
        </div>
        <strong class="lote-qtd">${qtdProduto(l.quantidade, p)}</strong>
      </div>
      <div class="lote-acoes">
        <button class="botao pequeno" type="button" data-acao="corrigir">Corrigir</button>
        ${d != null && d < 0 ? '<button class="botao pequeno saida" type="button" data-acao="vencido">Baixa como vencido</button>' : ''}
        <button class="botao pequeno excluir-lote" type="button" data-acao="excluir">Excluir lote</button>
      </div>
      <form class="lote-form" hidden autocomplete="off">
        <div class="grade">
          <div class="campo"><label>Validade</label><input name="validade" type="date" value="${esc(l.validade || '')}" ${l.validade ? '' : 'disabled'}></div>
          <div class="campo"><label class="marca-sem"><input type="checkbox" name="sem_validade" ${l.validade ? '' : 'checked'}> Sem validade</label></div>
          ${p.fator ? `
          <div class="campo"><label>${esc(p.unidade || 'Embalagem')} (1 = ${num(p.fator)} ${esc(p.unidade_menor)})</label><input name="quantidade" inputmode="decimal" value="${campoNum(cheias)}"></div>
          <div class="campo"><label>${esc(p.unidade_menor)} soltas</label><input name="quantidade_menor" inputmode="decimal" value="${campoNum(soltas)}"></div>` : `
          <div class="campo"><label>Quantidade${p.unidade ? ` (${esc(p.unidade)})` : ''}</label><input name="quantidade" inputmode="decimal" value="${campoNum(l.quantidade)}"></div>`}
        </div>
        <div class="acoes">
          <button class="botao primario" type="submit">Salvar correção</button>
          <button class="botao" type="button" data-acao="cancelar">Cancelar</button>
        </div>
        <p class="dica">Use para arrumar um lote lançado errado. A diferença fica no histórico como "Correção de lote".</p>
      </form>
    </div>`;
  }).join('')}</div>`;
}

// Liga os botões dos lotes; recarregar() redesenha a ficha depois de uma mudança.
function ligarLotes(p, recarregar) {
  const caixa = document.querySelector('.lotes');
  if (!caixa) return;
  const loteDe = (el) => p.lotes.find((l) => String(l.id) === el.closest('[data-lote]').dataset.lote);
  const descricao = (l) => `${l.validade ? `de val. ${data(l.validade)}` : 'sem validade'} (${textoQtd(l.quantidade, p)})`;

  caixa.onclick = async (e) => {
    const b = e.target.closest('[data-acao]');
    if (!b) return;
    const el = b.closest('.lote');
    const l = loteDe(b);
    const form = el.querySelector('.lote-form');
    if (b.dataset.acao === 'corrigir') { form.hidden = !form.hidden; return; }
    if (b.dataset.acao === 'cancelar') { form.hidden = true; return; }
    try {
      if (b.dataset.acao === 'excluir') {
        if (!confirm(`Excluir o lote ${descricao(l)}?\n\nO estoque diminui ${textoQtd(l.quantidade, p)}.`)) return;
        await api(`/api/lotes/${l.id}`, { method: 'DELETE' });
        avisar('Lote excluído');
      } else if (b.dataset.acao === 'vencido') {
        if (!confirm(`Dar baixa no lote ${descricao(l)} como vencido?\n\nSai do estoque e fica registrado como perda.`)) return;
        await api(`/api/lotes/${l.id}/vencido`, { method: 'POST' });
        avisar('Baixa como vencido lançada');
      }
      await recarregar();
    } catch (erro) { avisar(erro.message, 'erro'); }
  };

  caixa.onchange = (e) => {
    if (!e.target.matches('[name="sem_validade"]')) return;
    e.target.closest('form').elements.validade.disabled = e.target.checked;
  };

  caixa.onsubmit = async (e) => {
    e.preventDefault();
    const form = e.target;
    const l = loteDe(form);
    const f = form.elements;
    const corpo = {
      validade: f.sem_validade.checked ? '' : f.validade.value,
      quantidade: f.quantidade.value,
      ...(f.quantidade_menor ? { quantidade_menor: f.quantidade_menor.value } : {}),
    };
    try {
      const r = await api(`/api/lotes/${l.id}`, { method: 'PATCH', body: corpo });
      avisar(r.mudou ? 'Lote corrigido' : 'Nada mudou');
      if (r.mudou) await recarregar(); else form.hidden = true;
    } catch (erro) { avisar(erro.message, 'erro'); }
  };
}

// ---------- página: Validades ----------
let diasValidades = 7;

PAGINAS.validades = async () => {
  const r = await api(`/api/validades?dias=${diasValidades}`);
  const linha = (l) => `
    <div class="item validade-item" data-lote="${l.id}">
      <a class="item-corpo" href="#/produto/${l.produto_id}">
        <div class="info">
          <div class="nome">${esc(l.nome)}</div>
          <div class="sub">${esc(l.empresa || 'sem empresa')}</div>
        </div>
        <div class="qtd"><strong>${qtdProduto(l.quantidade, l)}</strong></div>
      </a>
      ${l.dias < 0 ? '<button class="botao pequeno saida" type="button" data-vencido>Baixa como vencido</button>' : ''}
    </div>`;
  // agrupa por data de validade: um título por dia
  const porData = (lista) => {
    const grupos = new Map();
    for (const l of lista) grupos.set(l.validade, [...(grupos.get(l.validade) || []), l]);
    return [...grupos].map(([v, ls]) => `
      <h3 class="validade-dia ${ls[0].dias < 0 ? 'vencido' : ls[0].dias <= 2 ? 'perto' : ''}">${data(v)} · ${esc(textoDias(ls[0].dias))}</h3>
      <div class="lista">${ls.map(linha).join('')}</div>`).join('');
  };

  app.innerHTML = `
    <h1>Validades</h1>
    <h2>Vencidos <b class="contagem">${r.vencidos.length}</b></h2>
    ${r.vencidos.length ? `
      <p class="dica">Dar baixa tira o lote do estoque e registra como perda ("vencido").</p>
      <div class="acoes"><button class="botao saida" type="button" id="baixa-todos">Dar baixa em todos os vencidos</button></div>
      ${porData(r.vencidos)}` : '<div class="cartao vazio">Nenhum lote vencido.</div>'}

    <h2>Vencendo</h2>
    <div class="filtros" id="dias">${[3, 7, 15, 30].map((d) =>
      `<button class="chip ${d === r.dias ? 'ativo' : ''}" data-dias="${d}">Próximos ${d} dias</button>`).join('')}</div>
    ${r.vencendo.length ? porData(r.vencendo) : `<div class="cartao vazio">Nada vence nos próximos ${r.dias} dias.</div>`}`;

  document.getElementById('dias').onclick = (e) => {
    const b = e.target.closest('[data-dias]');
    if (!b) return;
    diasValidades = Number(b.dataset.dias);
    PAGINAS.validades();
  };

  app.querySelectorAll('[data-vencido]').forEach((b) => (b.onclick = async () => {
    const l = r.vencidos.find((x) => String(x.id) === b.closest('[data-lote]').dataset.lote);
    if (!confirm(`Dar baixa em ${l.nome} (${textoQtd(l.quantidade, l)}, val. ${data(l.validade)}) como vencido?`)) return;
    b.disabled = true;
    try {
      await api(`/api/lotes/${l.id}/vencido`, { method: 'POST' });
      avisar(`${l.nome}: baixa como vencido lançada`);
      await PAGINAS.validades();
    } catch (erro) { avisar(erro.message, 'erro'); b.disabled = false; }
  }));

  const btTodos = document.getElementById('baixa-todos');
  if (btTodos) btTodos.onclick = async () => {
    const n = r.vencidos.length;
    const pergunta = n === 1 ? 'Dar baixa no lote vencido?\n\nSai do estoque e fica registrado' : `Dar baixa em todos os ${n} lotes vencidos?\n\nSaem do estoque e ficam registrados`;
    if (!confirm(`${pergunta} como perda.`)) return;
    btTodos.disabled = true;
    try {
      const x = await api('/api/vencidos/baixa', { method: 'POST' });
      avisar(`Baixa em ${x.lotes} lote${x.lotes === 1 ? '' : 's'} vencido${x.lotes === 1 ? '' : 's'}`);
      await PAGINAS.validades();
    } catch (erro) { avisar(erro.message, 'erro'); btTodos.disabled = false; }
  };
};
