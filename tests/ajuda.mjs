import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import Module, { createRequire } from 'node:module';

export async function ambiente(t, porta, preparar) {
  const pasta = await mkdtemp(join(tmpdir(), 'padaria-test-'));
  const banco = join(pasta, 'teste.db');
  let processo;
  let servidorLocal, dbLocal;
  async function parar() {
    if (servidorLocal) {
      servidorLocal.closeAllConnections();
      await new Promise((ok, erro) => servidorLocal.close(e => e ? erro(e) : ok()));
      dbLocal.close(); servidorLocal = null; dbLocal = null;
    }
    if (!processo || processo.exitCode !== null || processo.signalCode !== null) return;
    const encerrado = new Promise(r => processo.once('exit', r));
    processo.kill();
    await encerrado;
  }
  t.after(async () => { await parar(); await rm(pasta, { recursive: true, force: true }); });
  if (preparar) preparar(banco);
  async function iniciar() {
    try { processo = spawn(process.execPath, [resolve('src/server.js')], {
      cwd: resolve('.'), env: { ...process.env, BANCO: banco, PORTA: String(porta) },
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    }); } catch (e) {
      if (e.code !== 'EPERM') throw e;
      // Sandbox do Windows: executar o arquivo original sem editar produção.
      // Capturar listen permite encerrar Express; limpar cache permite bancos independentes.
      const arquivo = resolve('src/server.js');
      const requerer = createRequire(arquivo);
      for (const chave of Object.keys(requerer.cache)) {
        if (chave.startsWith(resolve('src') + '\\') || chave.startsWith(resolve('src') + '/')) delete requerer.cache[chave];
      }
      const anterior = { BANCO: process.env.BANCO, PORTA: process.env.PORTA };
      process.env.BANCO = banco; process.env.PORTA = String(porta);
      try {
        const express = requerer('express');
        const fabrica = Object.assign(() => {
          const app = express(); const listen = app.listen.bind(app);
          app.listen = (...args) => { servidorLocal = listen(...args); return servidorLocal; };
          return app;
        }, express);
        const modulo = new Module(arquivo);
        modulo.filename = arquivo;
        modulo.paths = Module._nodeModulePaths(resolve('src'));
        modulo.require = nome => nome === 'express' ? fabrica : requerer(nome);
        modulo._compile(readFileSync(arquivo, 'utf8'), arquivo);
        dbLocal = requerer('./db');
        await new Promise((ok, erro) => { servidorLocal.once('listening', ok); servidorLocal.once('error', erro); });
      } finally {
        for (const [nome, valor] of Object.entries(anterior)) {
          if (valor === undefined) delete process.env[nome]; else process.env[nome] = valor;
        }
      }
      return;
    }
    await new Promise((ok, falha) => {
      let saida = '';
      const timer = setTimeout(() => finalizar(new Error(`Servidor não iniciou: ${saida}`)), 15000);
      const erro = e => finalizar(e);
      const saiu = code => finalizar(new Error(`Servidor saiu (${code}): ${saida}`));
      const dados = chunk => { saida += chunk; if (saida.includes('Controle de Estoque rodando!')) finalizar(); };
      function finalizar(e) {
        clearTimeout(timer);
        processo.off('error', erro); processo.off('exit', saiu);
        processo.stdout.off('data', dados); processo.stderr.off('data', dados);
        e ? falha(e) : ok();
      }
      processo.once('error', erro); processo.once('exit', saiu);
      processo.stdout.on('data', dados); processo.stderr.on('data', dados);
    });
    // Drenar pipes mesmo depois da inicialização.
    processo.stdout.resume(); processo.stderr.resume();
  }
  async function api(caminho, metodo = 'GET', corpo, status = 200) {
    const r = await fetch(`http://127.0.0.1:${porta}${caminho}`, {
      method: metodo, headers: { 'Content-Type': 'application/json' },
      body: corpo === undefined ? undefined : JSON.stringify(corpo), signal: AbortSignal.timeout(5000),
    });
    const texto = await r.text();
    assert.equal(r.status, status, `${metodo} ${caminho}: ${texto}`);
    const json = JSON.parse(texto);
    if (status >= 400) assert.equal(typeof json.erro, 'string');
    return json;
  }
  function sql(query, ...args) {
    const db = new DatabaseSync(banco, { readOnly: true });
    try { return db.prepare(query).all(...args).map(r => ({ ...r })); } finally { db.close(); }
  }
  const produto = async (extra = {}) => (await api('/api/produtos', 'POST', { nome: 'Produto teste', unidade: 'kg', ...extra }, 201)).id;
  const mover = (id, tipo, quantidade, extra = {}) => api(`/api/produtos/${id}/movimentar`, 'POST', { tipo, quantidade, ...extra });
  const ficha = id => api(`/api/produtos/${id}`);
  const snapshot = () => ({ lotes: sql('SELECT * FROM lotes ORDER BY id'), mov: sql('SELECT * FROM movimentacoes ORDER BY id') });
  async function saldo(id, esperado) {
    const p = await ficha(id);
    const lotes = sql('SELECT COALESCE(SUM(quantidade),0) AS n FROM lotes WHERE produto_id=?', id)[0].n;
    const mov = sql('SELECT COALESCE(SUM(quantidade),0) AS n FROM movimentacoes WHERE produto_id=?', id)[0].n;
    assert.ok(Math.abs(lotes - mov) < 1e-8, `Produto ${id}: lotes=${lotes}, movimentos=${mov}`);
    assert.equal(p.estoque_base, esperado); assert.equal(lotes, esperado);
    assert.equal(p.estoque, esperado / (p.fator || 1));
  }
  await iniciar();
  return { pasta, banco, iniciar, parar, api, sql, produto, mover, ficha, snapshot, saldo };
}

export function data(dias) {
  const d = new Date(); d.setDate(d.getDate() + dias);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
