// Testes da leitura do XML, da chave e da parte da SEFAZ, sem internet: certificado de teste autoassinado
// e respostas da SEFAZ de exemplo. Rodar: npm test
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const forge = require('node-forge');
const { SignedXml } = require('xml-crypto');
const { lerNota, limparChave, digitoChave } = require('../src/nfe-xml');
const sefaz = require('../src/sefaz');

const FIXTURES = path.join(__dirname, 'fixtures');
const fixture = (nome, cod = 'utf8') => fs.readFileSync(path.join(FIXTURES, nome), cod);
const CHAVE1 = '43261011222333000181550010000458711123456788';

// Certificado A1 de teste (autoassinado), no formato .pfx com senha, como o da padaria.
function criarPfx(senha, cn = 'PADARIA TESTE LTDA:99888777000166') {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const chave = forge.pki.privateKeyFromPem(privateKey.export({ type: 'pkcs1', format: 'pem' }));
  const cert = forge.pki.createCertificate();
  cert.publicKey = forge.pki.setRsaPublicKey(chave.n, chave.e);
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date(Date.now() - 86400000);
  cert.validity.notAfter = new Date(Date.now() + 200 * 86400000);
  cert.setSubject([{ name: 'commonName', value: cn }]);
  cert.setIssuer([{ name: 'commonName', value: cn }]);
  cert.sign(chave, forge.md.sha256.create());
  const p12 = forge.pkcs12.toPkcs12Asn1(chave, [cert], senha, { algorithm: '3des' });
  return Buffer.from(forge.asn1.toDer(p12).getBytes(), 'binary');
}

const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'nfe-teste-'));
const SENHA = 'senha-de-teste';
const arquivoPfx = path.join(pasta, 'teste.pfx');
fs.writeFileSync(arquivoPfx, criarPfx(SENHA));
const arquivoConfig = path.join(pasta, 'config.json');
fs.writeFileSync(arquivoConfig, JSON.stringify({ certificado: arquivoPfx, senha: SENHA, cnpj: '99888777000166', uf: '43' }));
process.env.CONFIG_SEFAZ = arquivoConfig;

// Resposta do NFeDistribuicaoDFe como a SEFAZ manda (docZip = gzip + base64).
const docZip = (xml, schema, nsu = '000000000000123') =>
  `<docZip NSU="${nsu}" schema="${schema}">${zlib.gzipSync(Buffer.from(xml)).toString('base64')}</docZip>`;
const respostaDist = (cStat, xMotivo, docs = '') => '<?xml version="1.0" encoding="utf-8"?>'
  + '<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"><soap:Body>'
  + '<nfeDistDFeInteresseResponse xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe"><nfeDistDFeInteresseResult>'
  + `<retDistDFeInt xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.01"><tpAmb>1</tpAmb><verAplic>1.4.0</verAplic><cStat>${cStat}</cStat>`
  + `<xMotivo>${xMotivo}</xMotivo><dhResp>2026-10-12T10:00:00-03:00</dhResp><ultNSU>000000000000123</ultNSU><maxNSU>000000000000123</maxNSU>`
  + (docs ? `<loteDistDFeInt>${docs}</loteDistDFeInt>` : '')
  + '</retDistDFeInt></nfeDistDFeInteresseResult></nfeDistDFeInteresseResponse></soap:Body></soap:Envelope>';
const resumo = (chave) => `<resNFe xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.01"><chNFe>${chave}</chNFe>`
  + '<CNPJ>11222333000181</CNPJ><xNome>LACTALIS TESTE</xNome><vNF>413.71</vNF><cSitNFe>1</cSitNFe></resNFe>';
const respostaEvento = (cStat) => '<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"><soap:Body>'
  + '<nfeRecepcaoEventoNFResult xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeRecepcaoEvento4">'
  + '<retEnvEvento xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.00"><idLote>1</idLote><tpAmb>1</tpAmb><cOrgao>91</cOrgao>'
  + '<cStat>128</cStat><xMotivo>Lote de Evento Processado</xMotivo>'
  + `<retEvento versao="1.00"><infEvento><tpAmb>1</tpAmb><cOrgao>91</cOrgao><cStat>${cStat}</cStat>`
  + '<xMotivo>Evento registrado e vinculado a NF-e</xMotivo><tpEvento>210210</tpEvento></infEvento></retEvento>'
  + '</retEnvEvento></nfeRecepcaoEventoNFResult></soap:Body></soap:Envelope>';

test('chave de acesso: dígito verificador módulo 11', () => {
  assert.strictEqual(limparChave(CHAVE1), CHAVE1);
  assert.strictEqual(limparChave(CHAVE1.replace(/(\d{4})/g, '$1 ')), CHAVE1, 'aceita a chave com espaços');
  assert.strictEqual(limparChave(CHAVE1.slice(0, 43) + '0'), null, 'dígito errado');
  assert.strictEqual(limparChave('123'), null);
  // exemplo do manual: resto 0 ou 1 → dígito 0
  assert.ok([0, 1, 2, 3, 4, 5, 6, 7, 8, 9].includes(digitoChave('4'.repeat(43))));
});

test('lê nfeProc, NFe sozinha, prefixo nfe:, ISO-8859-1 e &amp;', () => {
  const a = lerNota(fixture('nota-lactalis-1.xml')).nota;
  assert.strictEqual(a.chave, CHAVE1);
  assert.strictEqual(a.numero, '45871');
  assert.strictEqual(a.emitente_cnpj, '11222333000181');
  assert.strictEqual(a.valor_total, 413.71);
  assert.strictEqual(a.itens.length, 4);
  assert.deepStrictEqual(a.itens[1], {
    n: 2, codigo: '1002', ean: '7896000000017', descricao: 'CREME DE LEITE ELEGE 200G', unidade: 'UN',
    quantidade: 27, valor_unit: 3.49, valor_total: 94.23, validade: '2027-01-15',
  });
  assert.strictEqual(a.itens[0].ean, null, 'SEM GTIN = sem código');
  assert.strictEqual(a.itens[2].descricao, 'QUEIJO MUSSARELA & PRATO FATIADO KG');
  assert.strictEqual(a.itens[2].quantidade, 4.25);

  const b = lerNota(fixture('nota-lactalis-2.xml')).nota;
  assert.strictEqual(b.itens.length, 3);
  const c = lerNota(fixture('nota-fritz-iso.xml', 'latin1')).nota;
  assert.strictEqual(c.itens[0].descricao, 'PÃO DE QUEIJO CONGELADO 1KG FD C/10');
  assert.strictEqual(c.itens[0].ean, '7890000000013', 'usa o cEANTrib quando o cEAN é SEM GTIN');
  assert.strictEqual(c.itens[0].validade, '2027-02-01', 'dois lotes: vale a validade que vence antes');

  assert.match(lerNota('<html>').erro, /NF-e/);
  assert.match(lerNota('isto não é xml <').erro, /XML|NF-e/);
  assert.match(lerNota(fixture('nota-lactalis-1.xml').replace('NFe4326', 'NFe4327')).erro, /chave/);
});

test('abre o .pfx com a senha e acha o CNPJ do titular', () => {
  const c = sefaz.abrirCertificado(fs.readFileSync(arquivoPfx), SENHA);
  assert.strictEqual(c.cnpj, '99888777000166');
  assert.strictEqual(c.titular, 'PADARIA TESTE LTDA');
  assert.match(c.chavePem, /PRIVATE KEY/);
  assert.throws(() => sefaz.abrirCertificado(fs.readFileSync(arquivoPfx), 'errada'), /senha/);
  const s = sefaz.situacao();
  assert.strictEqual(s.configurado, true);
  assert.ok(s.dias_para_vencer >= 198);
  assert.ok(!JSON.stringify(s).includes(SENHA), 'a senha nunca aparece');
});

test('consulta pela chave: SOAP 1.2 do NFeDistribuicaoDFe', () => {
  const soap = sefaz.montarConsultaChave({ chave: CHAVE1, cnpj: '99888777000166', uf: '43' });
  assert.match(soap, /<soap12:Envelope [^>]*xmlns:soap12="http:\/\/www.w3.org\/2003\/05\/soap-envelope"/);
  assert.match(soap, /<nfeDistDFeInteresse xmlns="http:\/\/www.portalfiscal.inf.br\/nfe\/wsdl\/NFeDistribuicaoDFe"><nfeDadosMsg>/);
  assert.match(soap, /<distDFeInt xmlns="http:\/\/www.portalfiscal.inf.br\/nfe" versao="1.01"><tpAmb>1<\/tpAmb><cUFAutor>43<\/cUFAutor><CNPJ>99888777000166<\/CNPJ><consChNFe><chNFe>43261011222333000181550010000458711123456788<\/chNFe><\/consChNFe><\/distDFeInt>/);
});

test('evento de ciência assinado: a assinatura confere com o certificado', () => {
  const c = sefaz.abrirCertificado(fs.readFileSync(arquivoPfx), SENHA);
  const evento = sefaz.montarEventoCiencia({ chave: CHAVE1, cnpj: '99888777000166', dhEvento: '2026-10-12T10:00:00-03:00', idLote: '1' });
  assert.ok(!/>\s+</.test(evento), 'sem espaços entre as tags');
  const assinado = sefaz.assinarEvento(evento, c.chavePem, c.certPem);
  assert.match(assinado, /<\/infEvento><Signature xmlns="http:\/\/www.w3.org\/2000\/09\/xmldsig#">/, 'assinatura logo depois do infEvento');
  assert.ok(assinado.includes(`<infEvento Id="ID210210${CHAVE1}01">`));
  assert.ok(assinado.includes(`<Reference URI="#ID210210${CHAVE1}01">`), 'referência ao Id do infEvento');
  assert.match(assinado, /Algorithm="http:\/\/www.w3.org\/2000\/09\/xmldsig#rsa-sha1"/);
  assert.match(assinado, /<Transform Algorithm="http:\/\/www.w3.org\/2000\/09\/xmldsig#enveloped-signature"\/><Transform Algorithm="http:\/\/www.w3.org\/TR\/2001\/REC-xml-c14n-20010315"\/>/);
  assert.match(assinado, /<X509Certificate>[A-Za-z0-9+/=]+<\/X509Certificate>/);
  assert.match(assinado, /<tpEvento>210210<\/tpEvento>.*<descEvento>Ciencia da Operacao<\/descEvento>/);

  const conferir = (xml) => {
    const v = new SignedXml({ publicCert: c.certPem });
    const doc = new (require('@xmldom/xmldom').DOMParser)().parseFromString(xml, 'text/xml');
    v.loadSignature(doc.getElementsByTagNameNS('http://www.w3.org/2000/09/xmldsig#', 'Signature')[0]);
    try { return v.checkSignature(xml); } catch { return false; }
  };
  assert.strictEqual(conferir(assinado), true, 'assinatura válida');
  assert.strictEqual(conferir(assinado.replace('<nSeqEvento>1<', '<nSeqEvento>2<')), false, 'mexeu no evento = assinatura inválida');

  // Conferência independente (só com node:crypto), como a SEFAZ faria: digest SHA-1 do infEvento canônico
  // (C14N: o namespace herdado entra no elemento) e RSA-SHA1 do SignedInfo canônico.
  const infEvento = evento.match(/<infEvento .*<\/infEvento>/)[0]
    .replace('<infEvento ', '<infEvento xmlns="http://www.portalfiscal.inf.br/nfe" ');
  const digest = crypto.createHash('sha1').update(infEvento).digest('base64');
  assert.strictEqual(assinado.match(/<DigestValue>(.*?)<\/DigestValue>/)[1], digest);
  const signedInfo = assinado.match(/<SignedInfo>.*<\/SignedInfo>/)[0]
    .replace('<SignedInfo>', '<SignedInfo xmlns="http://www.w3.org/2000/09/xmldsig#">')
    .replace(/<(\w+)([^>]*?)\/>/g, '<$1$2></$1>');
  const valor = Buffer.from(assinado.match(/<SignatureValue>(.*?)<\/SignatureValue>/)[1], 'base64');
  assert.ok(crypto.verify('RSA-SHA1', Buffer.from(signedInfo), c.certPem, valor), 'RSA-SHA1 confere com o certificado');

  const soap = sefaz.montarSoapEvento(assinado);
  assert.match(soap, /<soap12:Body><nfeDadosMsg xmlns="http:\/\/www.portalfiscal.inf.br\/nfe\/wsdl\/NFeRecepcaoEvento4"><envEvento /);
});

test('lê a resposta da SEFAZ e abre o docZip', () => {
  const xml = fixture('nota-lactalis-1.xml');
  const r = sefaz.lerRespostaDistribuicao(respostaDist(138, 'Documento localizado', docZip(xml, 'procNFe_v4.00.xsd')));
  assert.strictEqual(r.cStat, '138');
  assert.strictEqual(r.documentos.length, 1);
  assert.strictEqual(r.documentos[0].schema, 'procNFe_v4.00.xsd');
  assert.strictEqual(r.documentos[0].xml, xml);
  const e = sefaz.lerRespostaEvento(respostaEvento(135));
  assert.deepStrictEqual([e.cStat, e.eventoCStat], ['128', '135']);
  assert.match(sefaz.explicar('656', 'Rejeicao: Consumo Indevido'), /1 hora/);
  assert.match(sefaz.explicar('593', ''), /CNPJ/);
  assert.match(sefaz.explicar('999', 'Erro nao catalogado'), /Erro nao catalogado \(código 999\)/);
});

test('baixarNota: XML completo direto', async () => {
  sefaz.zerarBloqueio();
  const xml = fixture('nota-lactalis-1.xml');
  const chamadas = [];
  const r = await sefaz.baixarNota(CHAVE1, {
    pausa: 0,
    enviar: async (url, soap) => { chamadas.push(url); return respostaDist(138, 'Documento localizado', docZip(xml, 'procNFe_v4.00.xsd')); },
  });
  assert.strictEqual(r.xml, xml);
  assert.deepStrictEqual(chamadas, [sefaz.URL_DISTRIBUICAO]);
});

test('baixarNota: só o resumo → manda a ciência e consulta de novo', async () => {
  sefaz.zerarBloqueio();
  const xml = fixture('nota-lactalis-1.xml');
  const chamadas = [];
  let consultas = 0;
  const r = await sefaz.baixarNota(CHAVE1, {
    pausa: 0,
    enviar: async (url, soap) => {
      chamadas.push(url);
      if (url === sefaz.URL_EVENTO) {
        assert.match(soap, /<tpEvento>210210<\/tpEvento>/);
        assert.match(soap, /<SignatureValue>/);
        return respostaEvento(135);
      }
      consultas++;
      return consultas === 1
        ? respostaDist(138, 'Documento localizado', docZip(resumo(CHAVE1), 'resNFe_v1.01.xsd'))
        : respostaDist(138, 'Documento localizado', docZip(xml, 'procNFe_v4.00.xsd'));
    },
  });
  assert.strictEqual(r.xml, xml);
  assert.deepStrictEqual(chamadas, [sefaz.URL_DISTRIBUICAO, sefaz.URL_EVENTO, sefaz.URL_DISTRIBUICAO]);

  // a SEFAZ ainda não liberou: avisa para tentar depois e, na próxima tentativa, não manda a ciência de novo
  sefaz.zerarBloqueio();
  let eventos = 0;
  const soResumo = async (url) => {
    if (url === sefaz.URL_EVENTO) { eventos++; return respostaEvento(573); }
    return respostaDist(138, 'Documento localizado', docZip(resumo(CHAVE1), 'resNFe_v1.01.xsd'));
  };
  const r2 = await sefaz.baixarNota(CHAVE1, { pausa: 0, enviar: soResumo });
  assert.strictEqual(r2.aguardar, true);
  assert.match(r2.erro, /ainda não liberou/);
  const r3 = await sefaz.baixarNota(CHAVE1, { pausa: 0, enviar: soResumo });
  assert.strictEqual(r3.aguardar, true);
  assert.strictEqual(eventos, 1);
});

test('baixarNota: erro 656 bloqueia por 1 hora sem consultar de novo', async () => {
  sefaz.zerarBloqueio();
  let chamadas = 0;
  const enviar = async () => { chamadas++; return respostaDist(656, 'Rejeicao: Consumo Indevido'); };
  const r = await sefaz.baixarNota(CHAVE1, { enviar });
  assert.match(r.erro, /1 hora/);
  const r2 = await sefaz.baixarNota(CHAVE1, { enviar });
  assert.match(r2.erro, /Tente de novo depois das/);
  assert.strictEqual(chamadas, 1, 'a segunda vez nem chega na SEFAZ');
  sefaz.zerarBloqueio();
  const r3 = await sefaz.baixarNota(CHAVE1, { enviar: async () => respostaDist(137, 'Nenhum documento localizado') });
  assert.match(r3.erro, /não achou/);
});

test('sem configuração: avisa e não tenta a SEFAZ', async () => {
  const antes = process.env.CONFIG_SEFAZ;
  process.env.CONFIG_SEFAZ = path.join(pasta, 'nao-existe.json');
  try {
    const r = await sefaz.baixarNota(CHAVE1, { enviar: async () => assert.fail('não devia chamar a SEFAZ') });
    assert.strictEqual(r.semConfig, true);
    assert.strictEqual(sefaz.situacao().sem_config, true);
  } finally {
    process.env.CONFIG_SEFAZ = antes;
  }
});
