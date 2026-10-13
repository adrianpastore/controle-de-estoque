// Download do XML da NF-e pela SEFAZ (Ambiente Nacional), usando o certificado A1 (.pfx) da padaria.
// 1) NFeDistribuicaoDFe: consulta pela chave. Vem o XML completo (procNFe) ou só um resumo (resNFe).
// 2) Se veio só o resumo: manda a "Ciência da Operação" (evento 210210, assinado com o certificado)
//    pelo RecepcaoEvento e consulta de novo. A SEFAZ pode demorar alguns minutos para liberar.
// Configuração fora do git: dados/config.json (ou o arquivo em CONFIG_SEFAZ). A senha nunca é mostrada nem gravada em log.
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const tls = require('node:tls');
const zlib = require('node:zlib');
const forge = require('node-forge');
const { SignedXml } = require('xml-crypto');
const { lerXml, limparChave } = require('./nfe-xml');

const URL_DISTRIBUICAO = 'https://www1.nfe.fazenda.gov.br/NFeDistribuicaoDFe/NFeDistribuicaoDFe.asmx';
const URL_EVENTO = 'https://www.nfe.fazenda.gov.br/NFeRecepcaoEvento4/NFeRecepcaoEvento4.asmx';
const WSDL_DISTRIBUICAO = 'http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe';
const WSDL_EVENTO = 'http://www.portalfiscal.inf.br/nfe/wsdl/NFeRecepcaoEvento4';
const NS_NFE = 'http://www.portalfiscal.inf.br/nfe';

const arquivoConfig = () => (process.env.CONFIG_SEFAZ
  ? path.resolve(process.env.CONFIG_SEFAZ)
  : path.join(__dirname, '..', 'dados', 'config.json'));

// Lê a configuração. { config } ou { erro }. Sem arquivo = { semConfig: true }.
function lerConfig() {
  const arquivo = arquivoConfig();
  if (!fs.existsSync(arquivo)) return { semConfig: true, erro: 'O certificado digital ainda não foi configurado' };
  let c;
  try {
    c = JSON.parse(fs.readFileSync(arquivo, 'utf8'));
  } catch {
    return { erro: `O arquivo de configuração (${path.basename(arquivo)}) está com erro de digitação` };
  }
  const config = {
    certificado: path.resolve(path.dirname(arquivo), String(c.certificado || '')),
    senha: String(c.senha ?? ''),
    cnpj: String(c.cnpj || '').replace(/\D/g, ''),
    uf: String(c.uf || '43').replace(/\D/g, ''),
    ambiente: Number(c.ambiente) === 2 ? 2 : 1, // 1 = produção, 2 = homologação
    verificarServidor: c.verificarServidor !== false,
  };
  if (!c.certificado) return { erro: 'Falta o caminho do certificado (.pfx) na configuração' };
  if (!fs.existsSync(config.certificado)) return { erro: 'O arquivo do certificado (.pfx) não foi encontrado no caminho configurado' };
  if (!/^\d{14}$/.test(config.cnpj)) return { erro: 'O CNPJ na configuração precisa ter 14 números' };
  if (!/^\d{2}$/.test(config.uf)) return { erro: 'O código da UF na configuração precisa ter 2 números (RS = 43)' };
  return { config };
}

// Abre o .pfx e devolve a chave e o certificado em PEM, a validade e o CNPJ do titular.
function abrirCertificado(pfx, senha) {
  let p12;
  try {
    const asn1 = forge.asn1.fromDer(forge.util.createBuffer(pfx.toString('binary')));
    p12 = forge.pkcs12.pkcs12FromAsn1(asn1, false, senha);
  } catch {
    throw new Error('Não consegui abrir o certificado: a senha está errada ou o arquivo não é um .pfx');
  }
  const chaves = [
    ...(p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag] || []),
    ...(p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] || []),
  ].filter((b) => b.key);
  const certs = (p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] || []).filter((b) => b.cert);
  if (!chaves.length || !certs.length) throw new Error('O arquivo .pfx não tem a chave e o certificado');
  const chave = chaves[0].key;
  // o certificado da padaria é o que tem a mesma chave pública; os outros são da cadeia (autoridades)
  const doTitular = certs.find((b) => b.cert.publicKey.n && b.cert.publicKey.n.equals(chave.n)) || certs[0];
  const cert = doTitular.cert;
  const cn = cert.subject.getField('CN')?.value || '';
  return {
    chavePem: forge.pki.privateKeyToPem(chave),
    certPem: forge.pki.certificateToPem(cert),
    cadeiaPem: certs.filter((b) => b !== doTitular).map((b) => forge.pki.certificateToPem(b.cert)),
    titular: cn.replace(/:\d{11,14}$/, ''),
    cnpj: (cn.match(/:(\d{14})$/) || [])[1] || null, // e-CNPJ ICP-Brasil: "NOME DA EMPRESA:12345678000199"
    validoDe: cert.validity.notBefore,
    validoAte: cert.validity.notAfter,
  };
}

let cacheCert = null; // { chaveCache, dados }
function carregarCertificado(config) {
  const st = fs.statSync(config.certificado);
  const chaveCache = `${config.certificado}|${st.mtimeMs}|${st.size}`;
  if (cacheCert?.chaveCache === chaveCache && cacheCert.senha === config.senha) return cacheCert.dados;
  const dados = abrirCertificado(fs.readFileSync(config.certificado), config.senha);
  cacheCert = { chaveCache, senha: config.senha, dados };
  return dados;
}

// ---------- montagem das mensagens ----------
const soap12 = (corpo) => '<?xml version="1.0" encoding="utf-8"?>'
  + '<soap12:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" '
  + 'xmlns:soap12="http://www.w3.org/2003/05/soap-envelope"><soap12:Body>' + corpo + '</soap12:Body></soap12:Envelope>';

function montarConsultaChave({ chave, cnpj, uf, ambiente = 1 }) {
  return soap12(`<nfeDistDFeInteresse xmlns="${WSDL_DISTRIBUICAO}"><nfeDadosMsg>`
    + `<distDFeInt xmlns="${NS_NFE}" versao="1.01"><tpAmb>${ambiente}</tpAmb><cUFAutor>${uf}</cUFAutor>`
    + `<CNPJ>${cnpj}</CNPJ><consChNFe><chNFe>${chave}</chNFe></consChNFe></distDFeInt>`
    + '</nfeDadosMsg></nfeDistDFeInteresse>');
}

// Data e hora local com o fuso (ex.: 2026-10-12T14:30:00-03:00), como a SEFAZ pede.
function dataHoraComFuso(d = new Date()) {
  const fuso = -d.getTimezoneOffset();
  const dois = (n) => String(Math.floor(Math.abs(n))).padStart(2, '0');
  const local = new Date(d.getTime() + fuso * 60000).toISOString().slice(0, 19);
  return `${local}${fuso >= 0 ? '+' : '-'}${dois(fuso / 60)}:${dois(fuso % 60)}`;
}

// Evento 210210 (Ciência da Operação), ainda sem assinatura. Tudo numa linha só: a SEFAZ não aceita espaços entre as tags.
function montarEventoCiencia({ chave, cnpj, ambiente = 1, dhEvento = dataHoraComFuso(), idLote = String(Date.now()) }) {
  const id = `ID210210${chave}01`;
  return `<envEvento xmlns="${NS_NFE}" versao="1.00"><idLote>${idLote}</idLote>`
    + `<evento xmlns="${NS_NFE}" versao="1.00"><infEvento Id="${id}"><cOrgao>91</cOrgao><tpAmb>${ambiente}</tpAmb>`
    + `<CNPJ>${cnpj}</CNPJ><chNFe>${chave}</chNFe><dhEvento>${dhEvento}</dhEvento><tpEvento>210210</tpEvento>`
    + '<nSeqEvento>1</nSeqEvento><verEvento>1.00</verEvento>'
    + '<detEvento versao="1.00"><descEvento>Ciencia da Operacao</descEvento></detEvento>'
    + '</infEvento></evento></envEvento>';
}

// Assinatura XMLDSig "enveloped" (RSA-SHA1, C14N) do infEvento, colocada logo depois dele, dentro do evento.
function assinarEvento(xml, chavePem, certPem) {
  const assinatura = new SignedXml({
    privateKey: chavePem,
    publicCert: certPem,
    signatureAlgorithm: 'http://www.w3.org/2000/09/xmldsig#rsa-sha1',
    canonicalizationAlgorithm: 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315',
  });
  assinatura.addReference({
    xpath: "//*[local-name(.)='infEvento']",
    transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature', 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315'],
    digestAlgorithm: 'http://www.w3.org/2000/09/xmldsig#sha1',
  });
  assinatura.computeSignature(xml, { location: { reference: "//*[local-name(.)='infEvento']", action: 'after' } });
  return assinatura.getSignedXml();
}

const montarSoapEvento = (envEventoAssinado) =>
  soap12(`<nfeDadosMsg xmlns="${WSDL_EVENTO}">${envEventoAssinado}</nfeDadosMsg>`);

// ---------- leitura das respostas ----------
// Procura um elemento pelo nome em qualquer nível (a resposta vem dentro do envelope SOAP).
function acharNo(obj, nome) {
  if (!obj || typeof obj !== 'object') return null;
  if (obj[nome] !== undefined) return obj[nome];
  for (const v of Object.values(obj)) {
    const achou = acharNo(v, nome);
    if (achou != null) return achou;
  }
  return null;
}

// retDistDFeInt → { cStat, xMotivo, documentos: [{ nsu, schema, xml }] } (docZip = base64 + gzip).
function lerRespostaDistribuicao(soap) {
  const ret = acharNo(lerXml(soap), 'retDistDFeInt');
  if (!ret) throw new Error('Resposta da SEFAZ fora do formato esperado');
  const docs = acharNo(ret, 'docZip') || [];
  return {
    cStat: String(ret.cStat ?? ''),
    xMotivo: String(ret.xMotivo ?? ''),
    documentos: docs.map((d) => ({
      nsu: d['@NSU'],
      schema: String(d['@schema'] || ''),
      xml: zlib.gunzipSync(Buffer.from(String(d['#text'] ?? d), 'base64')).toString('utf8'),
    })),
  };
}

// retEnvEvento → { cStat, xMotivo, eventoCStat, eventoMotivo }
function lerRespostaEvento(soap) {
  const ret = acharNo(lerXml(soap), 'retEnvEvento');
  if (!ret) throw new Error('Resposta da SEFAZ fora do formato esperado');
  const inf = (ret.retEvento || [])[0]?.infEvento || {};
  return { cStat: String(ret.cStat ?? ''), xMotivo: String(ret.xMotivo ?? ''), eventoCStat: String(inf.cStat ?? ''), eventoMotivo: String(inf.xMotivo ?? '') };
}

// Códigos de retorno da SEFAZ → explicação simples.
const MENSAGENS = {
  137: 'A SEFAZ não achou esta nota para o CNPJ da padaria. Confira a chave. Se a nota é de hoje, tente de novo mais tarde.',
  656: 'A SEFAZ bloqueou as consultas da padaria por 1 hora porque foram feitas consultas demais. Espere 1 hora antes de tentar de novo. Enquanto isso, dá para importar o XML que o fornecedor mandou por e-mail.',
  593: 'O CNPJ da configuração não é o mesmo do certificado digital. Confira o "cnpj" no arquivo dados/config.json.',
  594: 'A SEFAZ recusou o CNPJ/certificado usado na consulta. Confira o "cnpj" no dados/config.json e o certificado.',
  472: 'O CPF/CNPJ da consulta não é o mesmo do certificado digital. Confira o "cnpj" no dados/config.json.',
  473: 'O certificado digital não tem CNPJ. Use o certificado A1 da empresa (e-CNPJ).',
  489: 'O CNPJ da configuração está errado. Confira o "cnpj" no dados/config.json.',
  280: 'A SEFAZ recusou o certificado digital. Confira se é o certificado A1 da padaria.',
  281: 'O certificado digital está vencido. É preciso renovar o certificado A1.',
  283: 'A SEFAZ não reconheceu a cadeia do certificado digital.',
  284: 'O certificado digital foi revogado. É preciso um certificado novo.',
  285: 'O certificado digital não é ICP-Brasil.',
  286: 'A SEFAZ não conseguiu conferir o certificado agora. Tente de novo mais tarde.',
  252: 'Ambiente errado (produção x homologação). Confira o "ambiente" no dados/config.json (produção = 1).',
  632: 'Esta nota é antiga demais para baixar pela SEFAZ (mais de 90 dias). Importe o XML que o fornecedor mandou.',
  640: 'A SEFAZ não libera esta nota para a padaria: o CNPJ da padaria não aparece como destinatário dela.',
  641: 'A SEFAZ não libera esta nota para a padaria.',
  653: 'Esta nota foi cancelada pelo fornecedor; a SEFAZ não libera o arquivo.',
  654: 'Esta nota foi denegada; a SEFAZ não libera o arquivo.',
  108: 'O serviço da SEFAZ está parado no momento. Tente de novo mais tarde.',
  109: 'O serviço da SEFAZ está fora do ar. Tente de novo mais tarde.',
};
const explicar = (cStat, xMotivo) => MENSAGENS[cStat] || `A SEFAZ respondeu: ${xMotivo || 'sem explicação'} (código ${cStat || '?'}).`;

// ---------- envio ----------
// POST SOAP 1.2 com o certificado do cliente (TLS mútuo). Devolve o texto da resposta.
function enviarSoap(url, soap, acao, cert, config) {
  return new Promise((resolve, reject) => {
    const corpo = Buffer.from(soap, 'utf8');
    const req = https.request(url, {
      method: 'POST',
      key: cert.chavePem,
      cert: [cert.certPem, ...cert.cadeiaPem].join('\n'),
      // as autoridades do Windows também valem (a cadeia ICP-Brasil costuma estar lá no PC com o certificado instalado)
      ca: [...tls.rootCertificates, ...tls.getCACertificates('system')],
      rejectUnauthorized: config.verificarServidor,
      headers: {
        'Content-Type': `application/soap+xml; charset=utf-8; action="${acao}"`,
        'Content-Length': corpo.length,
      },
      timeout: 30000,
    }, (res) => {
      const partes = [];
      res.on('data', (p) => partes.push(p));
      res.on('end', () => {
        const texto = Buffer.concat(partes).toString('utf8');
        if (res.statusCode === 403) return reject(new Error('A SEFAZ recusou o certificado digital (acesso negado). Confira se é o certificado A1 da padaria e se está dentro da validade.'));
        if (res.statusCode >= 500 && !texto.includes('cStat')) return reject(new Error(`A SEFAZ respondeu com erro ${res.statusCode}. Tente de novo mais tarde.`));
        resolve(texto);
      });
    });
    req.on('timeout', () => req.destroy(new Error('A SEFAZ demorou demais para responder. Tente de novo mais tarde.')));
    req.on('error', (e) => {
      if (/ISSUER|SELF_SIGNED|UNABLE_TO_VERIFY|CERT_UNTRUSTED/.test(e.code || '')) {
        return reject(new Error('Não foi possível confirmar o certificado do site da SEFAZ (cadeia ICP-Brasil). '
          + 'Se continuar, coloque "verificarServidor": false no dados/config.json.'));
      }
      if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT/.test(e.code || e.message)) {
        return reject(new Error('Sem conexão com a SEFAZ. Confira a internet do computador e tente de novo.'));
      }
      reject(e);
    });
    req.end(corpo);
  });
}

// ---------- fluxo completo ----------
let bloqueadoAte = 0; // depois de um erro 656, não consulta mais por 1 hora (não repete sozinho)
const cienciaEnviada = new Set(); // chaves que já tiveram a ciência enviada desde que o servidor abriu
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

// Tenta baixar o XML completo da nota. Devolve { xml } ou { erro, aguardar? }.
// opcoes.enviar e opcoes.pausa existem para os testes (simulam a SEFAZ sem internet).
async function baixarNota(chaveTexto, opcoes = {}) {
  const chave = limparChave(chaveTexto);
  if (!chave) return { erro: 'Chave de acesso inválida' };
  const { config, erro } = lerConfig();
  if (erro) return { erro, semConfig: true };
  if (Date.now() < bloqueadoAte) {
    const hora = new Date(bloqueadoAte).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    return { erro: `A SEFAZ bloqueou as consultas por consultas demais. Tente de novo depois das ${hora}.` };
  }
  let cert;
  try {
    cert = carregarCertificado(config);
  } catch (e) {
    return { erro: e.message, semConfig: true };
  }
  if (cert.validoAte < new Date()) return { erro: 'O certificado digital está vencido. É preciso renovar o certificado A1.' };

  const enviar = opcoes.enviar || ((url, soap, acao) => enviarSoap(url, soap, acao, cert, config));
  const consultar = async () => {
    const r = lerRespostaDistribuicao(await enviar(escolherUrl('distribuicao', config.ambiente), montarConsultaChave({ chave, cnpj: config.cnpj, uf: config.uf, ambiente: config.ambiente }),
      `${WSDL_DISTRIBUICAO}/nfeDistDFeInteresse`));
    if (r.cStat === '656') bloqueadoAte = Date.now() + 60 * 60 * 1000;
    return r;
  };
  const completo = (r) => r.documentos.find((d) => /^procNFe/i.test(d.schema) || d.xml.includes('<nfeProc'));
  const naoLiberou = { erro: 'A SEFAZ ainda não liberou o XML completo desta nota (a "ciência da operação" já foi enviada). Tente de novo em alguns minutos.', aguardar: true };

  try {
    let r = await consultar();
    if (r.cStat !== '138') return { erro: explicar(r.cStat, r.xMotivo) };
    if (completo(r)) return { xml: completo(r).xml };
    if (!r.documentos.some((d) => /^resNFe/i.test(d.schema))) return { erro: 'A SEFAZ devolveu um documento que não é a nota. Tente importar o XML.' };
    if (cienciaEnviada.has(chave)) return naoLiberou;

    // Só veio o resumo: manda a ciência da operação e consulta mais uma vez.
    const evento = assinarEvento(montarEventoCiencia({ chave, cnpj: config.cnpj, ambiente: config.ambiente }), cert.chavePem, cert.certPem);
    // operação do WSDL do Ambiente Nacional (nfeRecepcaoEventoNF): confirmar no 1º teste real
    const re = lerRespostaEvento(await enviar(escolherUrl('evento', config.ambiente), montarSoapEvento(evento), `${WSDL_EVENTO}/nfeRecepcaoEventoNF`));
    // 135/136 = evento registrado; 573 = a ciência já tinha sido enviada antes
    if (re.cStat !== '128' || !['135', '136', '573'].includes(re.eventoCStat)) {
      return { erro: `A SEFAZ não aceitou a ciência da operação: ${re.eventoMotivo || re.xMotivo} (código ${re.eventoCStat || re.cStat}).` };
    }
    cienciaEnviada.add(chave);
    await esperar(opcoes.pausa ?? 3000);
    r = await consultar();
    if (r.cStat === '138' && completo(r)) return { xml: completo(r).xml };
    if (r.cStat !== '138' && r.cStat !== '137') return { erro: explicar(r.cStat, r.xMotivo) };
    return naoLiberou;
  } catch (e) {
    return { erro: e.message || 'Erro ao falar com a SEFAZ' };
  }
}

// Situação do certificado para a tela (sem a senha).
function situacao() {
  const { config, erro, semConfig } = lerConfig();
  const base = { configurado: false, bloqueado_ate: Date.now() < bloqueadoAte ? new Date(bloqueadoAte).toISOString() : null };
  if (erro) return { ...base, sem_config: !!semConfig, erro };
  try {
    const c = carregarCertificado(config);
    const dias = Math.floor((c.validoAte - new Date()) / 86400000);
    return {
      ...base,
      configurado: dias >= 0,
      titular: c.titular,
      cnpj: config.cnpj,
      cnpj_certificado: c.cnpj,
      vence_em: c.validoAte.toISOString().slice(0, 10),
      dias_para_vencer: dias,
      erro: dias < 0 ? 'O certificado digital está vencido' : c.cnpj && c.cnpj.slice(0, 8) !== config.cnpj.slice(0, 8)
        ? 'O CNPJ da configuração não é o mesmo do certificado' : null,
    };
  } catch (e) {
    return { ...base, erro: e.message };
  }
}

const zerarBloqueio = () => { bloqueadoAte = 0; cienciaEnviada.clear(); }; // só para os testes

function escolherUrl(servico, ambiente = 1) {
  if (Number(ambiente) === 2) return servico === 'evento'
    ? 'https://hom1.nfe.fazenda.gov.br/NFeRecepcaoEvento4/NFeRecepcaoEvento4.asmx'
    : 'https://hom1.nfe.fazenda.gov.br/NFeDistribuicaoDFe/NFeDistribuicaoDFe.asmx';
  return servico === 'evento' ? URL_EVENTO : URL_DISTRIBUICAO;
}

module.exports = { escolherUrl,
  lerConfig, abrirCertificado, montarConsultaChave, montarEventoCiencia, assinarEvento, montarSoapEvento,
  lerRespostaDistribuicao, lerRespostaEvento, explicar, baixarNota, situacao, dataHoraComFuso, zerarBloqueio,
  URL_DISTRIBUICAO, URL_EVENTO,
};
