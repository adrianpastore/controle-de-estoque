// Interface do Controle de Estoque — JavaScript puro, sem frameworks.
const app = document.getElementById('app');

const lerAba = () => { try { return localStorage.getItem('aba'); } catch { return null; } };
const estado = { empresa: lerAba(), filtro: 'todos', busca: '' };

const FILTROS = [
  ['todos', 'Todos'],
  ['pedir', 'Pedir'],
  ['revisar', 'Revisar'],
  ['estoque', 'Estoque'],
  ['frente', 'Frente'],
  ['inativos', 'Não pedir'],
];

const TIPOS = { entrada: 'Entrada', saida: 'Saída', ajuste: 'Ajuste', importacao: 'Importação' };

// ---------- utilitários ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (n) => (n == null ? '—' : Number(n).toLocaleString('pt-BR', { maximumFractionDigits: 3 }));
const qtd = (n, un) => `${num(n)}${un ? ' ' + esc(un) : ''}`;
// Quantidade guardada nos lotes → texto: "3 cx + 4 und" com fator, "2,5 kg" sem. (Igual a formatar no servidor.)
function qtdProduto(base, p) {
  if (!p.fator) return qtd(base, p.unidade);
  const sinal = base < 0 ? '−' : '';
  const total = Math.abs(base);
  const cheias = Math.floor(Math.round(total / p.fator * 1000) / 1000);
  const soltas = Math.round((total - cheias * p.fator) * 1000) / 1000;
  const partes = [cheias ? qtd(cheias, p.unidade) : '', soltas ? qtd(soltas, p.unidade_menor) : ''].filter(Boolean);
  return sinal + (partes.join(' + ') || qtd(0, p.unidade));
}
const data = (d) => (d ? d.slice(0, 10).split('-').reverse().join('/') : '—');
const dataHora = (d) => (d ? `${data(d)} ${d.slice(11, 16)}` : '—');

async function api(url, opcoes = {}) {
  const r = await fetch(url, {
    ...opcoes,
    headers: { 'Content-Type': 'application/json', ...(opcoes.headers || {}) },
    body: opcoes.body ? JSON.stringify(opcoes.body) : undefined,
  });
  const corpo = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(corpo.erro || `Erro ${r.status}`);
  return corpo;
}

let timerAviso;
function avisar(msg, tipo = 'sucesso') {
  const el = document.getElementById('aviso');
  el.textContent = msg;
  el.className = `aviso ${tipo}`;
  el.hidden = false;
  clearTimeout(timerAviso);
  timerAviso = setTimeout(() => (el.hidden = true), 3000);
}

function diasAte(validade) {
  if (!validade) return null;
  const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
  return Math.round((new Date(validade + 'T00:00:00') - hoje) / 86400000);
}

// Quanto pedir: mínimo − estoque (igual à coluna Pedir da planilha).
// null = não precisa; 0 = marcado à mão para pedir, sem quantidade calculada.
function quantoPedir(p) {
  if (!p.ativo) return null;
  if (!p.nao_contado && p.estoque_minimo != null && p.estoque < p.estoque_minimo) {
    const falta = p.estoque_minimo - p.estoque;
    return p.fator ? Math.ceil(falta - 1e-9) : Math.round(falta * 1000) / 1000; // com fator, pede caixas inteiras
  }
  return p.em_falta ? 0 : null;
}

function selos(p) {
  const s = [];
  if (!p.ativo) s.push('<span class="selo neutro">Não pedir</span>');
  const pedir = quantoPedir(p);
  if (pedir) s.push(`<span class="selo perigo">Pedir ${qtd(pedir, p.unidade)}</span>`);
  else if (pedir === 0) s.push('<span class="selo perigo">Pedir</span>');
  if (p.nao_contado) s.push('<span class="selo info">Tem bastante</span>');
  if (p.precisa_revisao) s.push('<span class="selo info">Revisar</span>');
  const d = diasAte(p.validade_proxima);
  if (d != null && d < 0) s.push('<span class="selo perigo">Vencido</span>');
  else if (d != null && d <= 7) s.push(`<span class="selo alerta">Vence em ${d}d</span>`);
  return s.join('');
}

// ---------- empresas ----------
let empresas = []; // [{ id, nome, total }]

const alfabetica = (a, b) => a.nome.localeCompare(b.nome, 'pt-BR', { sensitivity: 'base' });
const opcoesEmpresa = (selecionada) => [...empresas].sort(alfabetica).map((e) =>
  `<option value="${e.id}" ${String(e.id) === String(selecionada ?? '') ? 'selected' : ''}>${esc(e.nome)}</option>`).join('');

// Lê a escolha de um <select> de empresa; "nova" pergunta o nome e cadastra.
async function escolherEmpresa(select) {
  if (select.value !== 'nova') return empresas.find((e) => String(e.id) === select.value) || null;
  const nome = (prompt('Nome da nova empresa:') || '').trim();
  if (!nome) return null;
  const nova = await api('/api/empresas', { method: 'POST', body: { nome } });
  if (!empresas.some((e) => e.id === nova.id)) empresas.push({ ...nova, total: 0 });
  return nova;
}

// ---------- página: lista de produtos ----------
const ABA_SEM = 'sem';
const ABA_TODAS = 'todas';
const ABAS_VISIVEIS = 6;
const UNIDADES = ['cx', 'pct', 'und', 'fardo', 'kg', 'balde', 'manga', 'rolo', 'pote', 'saco', 'lata', 'vidro', 'garrafa', 'galão', 'bandeja', 'bobina', 'sachê'];
let unidades = UNIDADES;

async function paginaProdutos() {
  app.innerHTML = `
    <div class="abas" id="abas"></div>
    <div class="filtros" id="filtros"></div>
    <input class="busca" id="busca" type="search" placeholder="Buscar por nome, fornecedor ou código…" value="${esc(estado.busca)}" autocomplete="off">
    <p class="contador" id="contador"></p>
    <div class="lista" id="lista"></div>
    <div class="acoes"><a class="botao" href="#/produto/novo">+ Novo produto</a></div>`;

  const elAbas = document.getElementById('abas');
  const trocarAba = async (aba) => {
    if (!aba || aba === estado.empresa) return;
    estado.empresa = aba;
    try { localStorage.setItem('aba', estado.empresa); } catch {}
    await carregarAbas();
    carregarFiltros();
    carregarLista();
  };
  elAbas.onclick = (e) => trocarAba(e.target.closest('[data-aba]')?.dataset.aba);

  document.getElementById('filtros').onclick = (e) => {
    const b = e.target.closest('[data-filtro]');
    if (!b) return;
    estado.filtro = b.dataset.filtro;
    document.querySelectorAll('.chip').forEach((c) => c.classList.toggle('ativo', c === b));
    carregarLista();
  };

  let t;
  document.getElementById('busca').oninput = (e) => {
    estado.busca = e.target.value;
    clearTimeout(t);
    t = setTimeout(carregarLista, 200);
  };

  document.getElementById('lista').onchange = async (e) => {
    const alvo = e.target;
    const item = alvo.closest('.item');
    if (!item) return;
    try {
      if (alvo.matches('.escolher-empresa')) await trocarEmpresaNaLista(alvo, item);
      else if (alvo.matches('.editar-minimo, .editar-unidade')) await salvarNaLista(alvo, item);
    } catch (erro) {
      avisar(erro.message, 'erro');
      carregarLista();
    }
  };

  const [, opcoes] = await Promise.all([carregarAbas(), api('/api/opcoes')]);
  unidades = [...new Set([...UNIDADES, ...opcoes.unidades])];
  await Promise.all([carregarFiltros(), carregarLista()]);
}

async function trocarEmpresaNaLista(sel, item) {
  const emp = await escolherEmpresa(sel);
  if (!emp) { sel.value = ''; return; }
  await api(`/api/produtos/${sel.dataset.id}/empresa`, { method: 'PUT', body: { empresa_id: emp.id } });
  item.remove();
  avisar(`Movido para ${emp.nome}`);
  const restantes = document.querySelectorAll('#lista .item').length;
  document.getElementById('contador').textContent = `${restantes} produto${restantes === 1 ? '' : 's'}`;
  await Promise.all([carregarAbas(), carregarFiltros()]);
  // a empresa pode ser nova: atualiza as opções dos outros seletores
  document.querySelectorAll('.escolher-empresa').forEach((s) => (s.innerHTML = opcoesSeletor()));
}

// Estoque mínimo e unidade editados direto na lista: salva e redesenha só aquele item.
async function salvarNaLista(campo, item) {
  const id = item.dataset.id;
  let valor = campo.value;
  if (campo.matches('.editar-unidade') && valor === 'outra') {
    valor = (prompt('Qual unidade? (ex.: cx, pct, kg)') || '').trim().toLowerCase();
    if (!valor) { campo.value = campo.dataset.antes; return; }
    if (!unidades.includes(valor)) unidades.push(valor);
  }
  const corpo = campo.matches('.editar-minimo') ? { estoque_minimo: valor } : { unidade: valor };
  await api(`/api/produtos/${id}`, { method: 'PATCH', body: corpo });
  const p = await api(`/api/produtos/${id}`);
  item.outerHTML = itemDaLista(p);
  avisar(`${p.nome}: salvo`);
  carregarFiltros(); // o mínimo muda quem está no filtro Pedir
}

async function carregarAbas() {
  const r = await api('/api/empresas');
  empresas = r.empresas;
  // as maiores empresas viram abas; o botão "Empresas" lista todas de A a Z, com quantos produtos pedir
  const principais = r.empresas.slice(0, ABAS_VISIVEIS);
  const validas = [...r.empresas.map((e) => String(e.id)), ABA_SEM, ABA_TODAS];
  if (!validas.includes(estado.empresa)) estado.empresa = validas[0];
  const aba = (k, rot, n, extra = '') =>
    `<button class="aba ${estado.empresa === k ? 'ativo' : ''} ${extra}" data-aba="${k}">${esc(rot)}<b>${n}</b></button>`;
  const atual = r.empresas.find((e) => String(e.id) === estado.empresa);
  const foraDasAbas = atual && !principais.includes(atual);
  const linha = (e) => `<button class="empresa-linha ${String(e.id) === estado.empresa ? 'ativo' : ''}" data-aba="${e.id}">
      <span>${esc(e.nome)}</span>${e.pedir ? `<b class="pedir">${e.pedir} pedir</b>` : '<b>—</b>'}</button>`;
  document.getElementById('abas').innerHTML = [
    ...principais.map((e) => aba(String(e.id), e.nome, e.total)),
    foraDasAbas ? aba(String(atual.id), atual.nome, atual.total) : '',
    aba(ABA_SEM, 'Sem empresa', r.sem, r.sem ? 'pendente' : ''),
    aba(ABA_TODAS, 'Todas', r.todas),
    `<details class="todas-empresas">
      <summary class="aba">Empresas ▾<b>${r.empresas.length}</b></summary>
      <div class="painel-empresas">${[...r.empresas].sort(alfabetica).map(linha).join('')}</div>
    </details>`,
  ].join('');
}

async function carregarFiltros() {
  const resumo = await api(`/api/resumo?${new URLSearchParams({ empresa: estado.empresa })}`);
  document.getElementById('filtros').innerHTML = FILTROS.map(([k, rot]) =>
    `<button class="chip ${estado.filtro === k ? 'ativo' : ''}" data-filtro="${k}">${rot}<b>${resumo[k]}</b></button>`).join('');
}

const opcoesSeletor = () => `<option value="">Escolher empresa…</option>${opcoesEmpresa()}<option value="nova">+ Nova empresa…</option>`;

async function carregarLista() {
  const q = new URLSearchParams({ empresa: estado.empresa, filtro: estado.filtro, busca: estado.busca });
  const lista = await api(`/api/produtos?${q}`);
  document.getElementById('contador').textContent = `${lista.length} produto${lista.length === 1 ? '' : 's'}`;
  document.getElementById('lista').innerHTML = lista.length ? lista.map(itemDaLista).join('') : '<div class="vazio">Nenhum produto encontrado.</div>';
}

function itemDaLista(p) {
  const semEmpresa = estado.empresa === ABA_SEM;
  const todas = estado.empresa === ABA_TODAS;
  const un = p.unidade || '';
  const opcoesUnidade = [...new Set([...unidades, ...(un ? [un] : [])])]
    .map((u) => `<option value="${esc(u)}" ${u === un ? 'selected' : ''}>${esc(u)}</option>`).join('');
  return `
    <div class="item" data-id="${p.id}">
      <a class="item-corpo" href="#/produto/${p.id}">
        <div class="info">
          <div class="nome">${esc(p.nome)}</div>
          <div class="sub">${todas ? `${esc(p.empresa || 'sem empresa')} · ` : ''}${esc(p.fornecedor || 'sem fornecedor')} · ${esc(p.secao)}</div>
          <div>${selos(p)}</div>
        </div>
        <div class="qtd">
          <strong>${p.nao_contado && !p.estoque ? '—' : qtdProduto(p.estoque_base, p)}</strong>
          ${p.validade_proxima ? `<small>val. ${data(p.validade_proxima)}</small>` : ''}
        </div>
      </a>
      <div class="ajustes">
        <label>Mín. <input class="editar-minimo" inputmode="decimal" value="${p.estoque_minimo == null ? '' : String(p.estoque_minimo).replace('.', ',')}" placeholder="sem" aria-label="Estoque mínimo de ${esc(p.nome)}"></label>
        <select class="editar-unidade" data-antes="${esc(un)}" aria-label="Unidade de ${esc(p.nome)}">
          <option value="" ${un ? '' : 'selected'}>unidade…</option>${opcoesUnidade}<option value="outra">+ outra…</option>
        </select>
      </div>
      ${semEmpresa ? `<select class="escolher-empresa" data-id="${p.id}" aria-label="Empresa de ${esc(p.nome)}">${opcoesSeletor()}</select>` : ''}
    </div>`;
}

// ---------- página: produto (ver / editar / novo) ----------
async function paginaProduto(id) {
  const novo = id === 'novo';
  // produto novo criado dentro da aba de uma empresa já nasce nessa empresa
  const empresaDaAba = /^\d+$/.test(estado.empresa || '') ? Number(estado.empresa) : null;
  const [p, opcoes, abas] = await Promise.all([
    novo ? Promise.resolve({ ativo: 1, secao: 'Estoque', empresa_id: empresaDaAba, estoque: 0, lotes: [], movimentacoes: [] }) : api(`/api/produtos/${id}`),
    api('/api/opcoes'),
    api('/api/empresas'),
  ]);
  empresas = abas.empresas;
  const lista = (idLista, valores) => `<datalist id="${idLista}">${valores.map((v) => `<option value="${esc(v)}">`).join('')}</datalist>`;
  const marca = (campo, rotulo) => `<label><input type="checkbox" name="${campo}" ${p[campo] ? 'checked' : ''}> ${rotulo}</label>`;
  const un = p.unidade ? ` (${esc(p.unidade)})` : '';

  app.innerHTML = `
    <a class="voltar" href="#/produtos">← Voltar</a>
    <h1>${novo ? 'Novo produto' : esc(p.nome)}</h1>
    ${novo ? '' : `
    <p class="empresa-produto">${p.empresa ? esc(p.empresa) : 'Sem empresa'}</p>
    <div class="resumo-produto">
      <div class="bloco"><small>Em estoque</small><strong>${p.nao_contado && !p.estoque ? 'tem bastante' : qtdProduto(p.estoque_base, p)}</strong></div>
      <div class="bloco"><small>Mínimo</small><strong>${p.estoque_minimo == null ? 'sem' : qtd(p.estoque_minimo, p.unidade)}</strong></div>
      <div class="bloco"><small>Pedir</small><strong>${quantoPedir(p) ? qtd(quantoPedir(p), p.unidade) : quantoPedir(p) === 0 ? 'sim' : 'não'}</strong></div>
      <div class="bloco"><small>Vence primeiro</small><strong>${data(p.validade_proxima)}</strong></div>
    </div>
    <div>${selos(p)}</div>

    <h2>Lançar</h2>
    <form class="cartao" id="form-mov" autocomplete="off">
      <div class="grade">
        ${p.fator ? `
        <div class="campo"><label>${esc(p.unidade || 'Embalagem')} (1 = ${num(p.fator)} ${esc(p.unidade_menor)})</label><input name="quantidade" inputmode="decimal" placeholder="ex.: 2"></div>
        <div class="campo"><label>${esc(p.unidade_menor)} soltas</label><input name="quantidade_menor" inputmode="decimal" placeholder="ex.: 4"></div>` : `
        <div class="campo"><label>Quantidade${un}</label><input name="quantidade" inputmode="decimal" required placeholder="ex.: 2 ou 0,5"></div>`}
        <div class="campo"><label>Validade (opcional, na entrada)</label><input name="validade" type="date"></div>
        <div class="campo largo"><label>Observação (opcional)</label><input name="observacao"></div>
      </div>
      <div class="acoes">
        <button class="botao entrada" type="button" data-tipo="entrada">+ Entrada</button>
        <button class="botao saida" type="button" data-tipo="saida">− Saída</button>
        <button class="botao" type="button" data-tipo="ajuste">= Ajustar para este valor</button>
      </div>
      <p class="dica">Entrada soma e saída tira. <b>Ajustar</b> é para quando você contou e o sistema está diferente: o estoque passa a ser exatamente o número digitado.${p.fator ? ` Pode preencher só ${esc(p.unidade || 'embalagem')}, só ${esc(p.unidade_menor)} ou os dois (ex.: 3 ${esc(p.unidade || '')} e 4 ${esc(p.unidade_menor)}).` : ''}</p>
    </form>`}

    <h2>Dados do produto</h2>
    <form class="cartao" id="form">
      <div class="grade">
        <div class="campo largo"><label>Nome</label><input name="nome" required value="${esc(p.nome)}"></div>
        <div class="campo"><label>Empresa</label><select name="empresa_id" id="empresa">
          <option value="">Sem empresa</option>${opcoesEmpresa(p.empresa_id)}<option value="nova">+ Nova empresa…</option>
        </select></div>
        <div class="campo"><label>Unidade</label><input name="unidade" list="l-un" value="${esc(p.unidade)}" placeholder="cx, pct, und, kg…"></div>
        <div class="campo"><label>Quantas unidades vêm em 1 ${esc(p.unidade || 'embalagem')}? (opcional)</label><input name="fator" inputmode="decimal" value="${p.fator ?? ''}" placeholder="vazio = não separa"></div>
        <div class="campo"><label>Nome da unidade menor</label><input name="unidade_menor" list="l-un" value="${esc(p.unidade_menor)}" placeholder="und"></div>
        <div class="campo"><label>Estoque mínimo</label><input name="estoque_minimo" inputmode="decimal" value="${p.estoque_minimo ?? ''}" placeholder="vazio = sem mínimo"></div>
        <div class="campo"><label>Fornecedor</label><input name="fornecedor" list="l-forn" value="${esc(p.fornecedor)}"></div>
        <div class="campo"><label>Seção</label><input name="secao" list="l-sec" value="${esc(p.secao)}"></div>
        <div class="campo"><label>Código de barras</label><input name="codigo_barras" inputmode="numeric" value="${esc(p.codigo_barras)}"></div>
        <div class="campo largo"><label>Observação</label><textarea name="observacao">${esc(p.observacao)}</textarea></div>
      </div>
      <div class="marcas">
        ${marca('ativo', 'Ativo (desmarque = não pedir mais)')}
        ${marca('em_falta', 'Pedir mesmo sem estar abaixo do mínimo')}
        ${marca('nao_contado', 'Tem bastante (não contado)')}
        ${marca('precisa_revisao', 'Precisa revisar')}
      </div>
      ${lista('l-un', opcoes.unidades)}${lista('l-sec', opcoes.secoes)}${lista('l-forn', opcoes.fornecedores)}
      <div class="acoes">
        <button class="botao primario" type="submit">Salvar</button>
        ${!novo && p.precisa_revisao ? '<button class="botao" type="button" id="revisado">Salvar e marcar como revisado</button>' : ''}
        ${novo ? '' : '<button class="botao excluir" type="button" id="excluir">Excluir produto</button>'}
      </div>
    </form>

    ${novo ? '' : `
    <h2>Lotes com saldo</h2>
    <div class="tabela-rolagem">${p.lotes.length ? `
      <table><thead><tr><th>Validade</th><th>Quantidade</th><th>Entrada</th></tr></thead><tbody>
      ${p.lotes.map((l) => `<tr><td>${data(l.validade)}</td><td>${qtdProduto(l.quantidade, p)}</td><td>${dataHora(l.criado_em)}</td></tr>`).join('')}
      </tbody></table>` : '<div class="vazio">Nenhum lote com saldo.</div>'}</div>

    <h2>Últimas movimentações</h2>
    <div class="tabela-rolagem">${p.movimentacoes.length ? `
      <table><thead><tr><th>Quando</th><th>Tipo</th><th>Qtd</th><th>Quem / obs.</th></tr></thead><tbody>
      ${p.movimentacoes.map((m) => `<tr><td>${dataHora(m.criado_em)}</td><td>${TIPOS[m.tipo] || esc(m.tipo)}</td><td>${m.tipo !== 'importacao' && m.quantidade > 0 ? '+' : ''}${qtdProduto(m.quantidade, p)}</td><td>${esc([m.usuario, m.observacao].filter(Boolean).join(' — '))}</td></tr>`).join('')}
      </tbody></table>` : '<div class="vazio">Nenhuma movimentação.</div>'}</div>`}`;

  const form = document.getElementById('form');
  const salvar = async (marcarRevisado) => {
    const f = new FormData(form);
    const corpo = Object.fromEntries(f.entries());
    for (const c of ['ativo', 'em_falta', 'nao_contado', 'precisa_revisao']) corpo[c] = f.has(c);
    if (marcarRevisado) corpo.precisa_revisao = false;
    try {
      if (novo) {
        const { id: novoId } = await api('/api/produtos', { method: 'POST', body: corpo });
        avisar('Produto criado');
        location.hash = `#/produto/${novoId}`;
      } else {
        await api(`/api/produtos/${id}`, { method: 'PUT', body: corpo });
        avisar('Alterações salvas');
        paginaProduto(id);
      }
    } catch (e) { avisar(e.message, 'erro'); }
  };
  form.onsubmit = (e) => { e.preventDefault(); salvar(false); };
  const btRev = document.getElementById('revisado');
  if (btRev) btRev.onclick = () => form.reportValidity() && salvar(true);

  const btExcluir = document.getElementById('excluir');
  if (btExcluir) btExcluir.onclick = async () => {
    if (!confirm(`Excluir "${p.nome}" de vez?\n\nO histórico de entradas e saídas dele também será apagado. `
      + 'Se só não vai mais pedir, é melhor desmarcar "Ativo".')) return;
    try {
      await api(`/api/produtos/${id}`, { method: 'DELETE' });
      avisar('Produto excluído');
      location.hash = '#/produtos';
    } catch (e) { avisar(e.message, 'erro'); }
  };

  const selEmpresa = document.getElementById('empresa');
  selEmpresa.onchange = async () => {
    if (selEmpresa.value !== 'nova') return;
    try {
      const emp = await escolherEmpresa(selEmpresa);
      selEmpresa.innerHTML = `<option value="">Sem empresa</option>${opcoesEmpresa(emp ? emp.id : p.empresa_id)}<option value="nova">+ Nova empresa…</option>`;
    } catch (e) { selEmpresa.value = p.empresa_id ?? ''; avisar(e.message, 'erro'); }
  };

  const formMov = document.getElementById('form-mov');
  if (!formMov) return;
  formMov.onsubmit = (e) => e.preventDefault(); // Enter não lança nada: precisa escolher o botão
  formMov.onclick = async (e) => {
    const b = e.target.closest('[data-tipo]');
    if (!b || !formMov.reportValidity()) return;
    const corpo = { tipo: b.dataset.tipo, ...Object.fromEntries(new FormData(formMov).entries()) };
    formMov.querySelectorAll('button').forEach((x) => (x.disabled = true));
    try {
      const r = await api(`/api/produtos/${id}/movimentar`, { method: 'POST', body: corpo });
      const q = qtdProduto(r.lancado, p);
      avisar(corpo.tipo === 'ajuste' ? `Ajustado para ${q}` : `${TIPOS[corpo.tipo]} de ${q} lançada — agora tem ${qtdProduto(r.estoque_base, p)}`);
      await paginaProduto(id);
    } catch (erro) {
      avisar(erro.message, 'erro');
      formMov.querySelectorAll('button').forEach((x) => (x.disabled = false));
    }
  };
}

// ---------- rotas ----------
async function rotear() {
  const [, rota, param] = (location.hash || '#/produtos').split('/');
  document.querySelectorAll('.menu a').forEach((a) => a.classList.toggle('ativo', a.dataset.rota === rota || (rota === 'produto' && a.dataset.rota === 'produtos')));
  try {
    if (rota === 'produto' && param) await paginaProduto(param);
    else await paginaProdutos();
    window.scrollTo(0, 0);
  } catch (e) {
    app.innerHTML = `<div class="cartao">Não foi possível carregar: ${esc(e.message)}</div>`;
  }
}
window.addEventListener('hashchange', rotear);
rotear();
