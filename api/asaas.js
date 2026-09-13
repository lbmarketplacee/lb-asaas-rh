// Intermediário seguro LB — integração com Asaas pra pagamento de colaboradoras via PIX.
// Variável de ambiente necessária na Vercel: ASAAS_API_KEY, ASAAS_AMBIENTE (sandbox|producao)

const HOSTS = {
  sandbox: 'https://api-sandbox.asaas.com/v3',
  producao: 'https://api.asaas.com/v3'
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const chave = process.env.ASAAS_API_KEY;
  const ambiente = process.env.ASAAS_AMBIENTE || 'sandbox';
  const host = HOSTS[ambiente];
  if (!chave) return res.status(500).json({ erro: 'Chave do Asaas não configurada na Vercel.' });

  try {
    const params = req.method === 'GET' ? req.query : req.body;
    const { acao } = params;

    // Diagnóstico — nunca expõe a chave, só confirma tamanho/ambiente
    if (acao === 'diagnostico') {
      return res.status(200).json({ ok: true, ambiente, chave_configurada: true, chave_tamanho: chave.length });
    }

    // Cria uma transferência PIX pra uma chave (pagamento de salário)
    if (acao === 'criar_transferencia') {
      const { value, pixAddressKey, pixAddressKeyType, description, externalReference } = params;
      if (!value || !pixAddressKey) return res.status(400).json({ erro: 'Faltam dados: valor e chave PIX são obrigatórios.' });

      const resp = await fetch(`${host}/transfers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'access_token': chave },
        body: JSON.stringify({
          value: Number(value),
          pixAddressKey,
          pixAddressKeyType: pixAddressKeyType || 'CPF',
          description: description || 'Pagamento LB Marketplace',
          externalReference: externalReference || ''
        })
      });
      const data = await resp.json();
      if (!resp.ok) {
        return res.status(200).json({ ok: false, erro: data?.errors?.[0]?.description || 'Erro ao criar transferência.', debug: data });
      }
      return res.status(200).json({ ok: true, transferencia: data });
    }

    // Consulta o status de uma transferência já feita
    if (acao === 'consultar_transferencia') {
      const { id } = params;
      const resp = await fetch(`${host}/transfers/${id}`, {
        headers: { 'access_token': chave }
      });
      const data = await resp.json();
      return res.status(200).json({ ok: resp.ok, transferencia: data });
    }

    // Consulta o saldo disponível na conta Asaas (pra saber se tem saldo suficiente antes de pagar)
    if (acao === 'consultar_saldo') {
      const resp = await fetch(`${host}/finance/balance`, {
        headers: { 'access_token': chave }
      });
      const data = await resp.json();
      return res.status(200).json({ ok: resp.ok, saldo: data?.balance });
    }

    // Lista as cobranças (pagamentos recebidos de clientes) num período — pra montar o DRE
    if (acao === 'listar_cobrancas') {
      const { data_inicio, data_fim } = params;
      let todas = [];
      let offset = 0;
      const limit = 100;
      let temMais = true;
      while (temMais) {
        const query = new URLSearchParams({
          limit: String(limit),
          offset: String(offset),
          ...(data_inicio ? { 'paymentDate[ge]': data_inicio } : {}),
          ...(data_fim ? { 'paymentDate[le]': data_fim } : {})
        });
        const resp = await fetch(`${host}/payments?${query}`, { headers: { 'access_token': chave } });
        const data = await resp.json();
        if (!resp.ok) return res.status(200).json({ ok: false, erro: data?.errors?.[0]?.description || 'Erro ao listar cobranças.' });
        todas = todas.concat(data.data || []);
        temMais = !data.hasMore ? false : true;
        offset += limit;
        if (offset > 2000) break; // segurança, evita loop longo demais
      }
      return res.status(200).json({ ok: true, cobrancas: todas });
    }

    // Lista todas as transferências feitas (pagamento de colaboradoras) num período — pra montar o DRE
    if (acao === 'listar_transferencias') {
      const { data_inicio, data_fim } = params;
      let todas = [];
      let offset = 0;
      const limit = 100;
      let temMais = true;
      while (temMais) {
        const query = new URLSearchParams({
          limit: String(limit),
          offset: String(offset),
          ...(data_inicio ? { 'dateCreated[ge]': data_inicio } : {}),
          ...(data_fim ? { 'dateCreated[le]': data_fim } : {})
        });
        const resp = await fetch(`${host}/transfers?${query}`, { headers: { 'access_token': chave } });
        const data = await resp.json();
        if (!resp.ok) return res.status(200).json({ ok: false, erro: data?.errors?.[0]?.description || 'Erro ao listar transferências.' });
        todas = todas.concat(data.data || []);
        temMais = !data.hasMore ? false : true;
        offset += limit;
        if (offset > 2000) break;
      }
      return res.status(200).json({ ok: true, transferencias: todas });
    }

    // Lista os clientes cadastrados no Asaas (id + nome) — usado pra trocar o ID técnico pelo nome real
    if (acao === 'listar_clientes_asaas') {
      let todos = [];
      let offset = 0;
      const limit = 100;
      let temMais = true;
      while (temMais) {
        const resp = await fetch(`${host}/customers?limit=${limit}&offset=${offset}`, { headers: { 'access_token': chave } });
        const data = await resp.json();
        if (!resp.ok) return res.status(200).json({ ok: false, erro: data?.errors?.[0]?.description || 'Erro ao listar clientes.' });
        todos = todos.concat(data.data || []);
        temMais = !!data.hasMore;
        offset += limit;
        if (offset > 2000) break;
      }
      return res.status(200).json({ ok: true, clientes: todos.map(c => ({ id: c.id, nome: c.name })) });
    }

    // Lista as assinaturas (cobranças recorrentes) ativas — usado pro MRR e vencimentos no DRE
    if (acao === 'listar_assinaturas') {
      let todas = [];
      let offset = 0;
      const limit = 100;
      let temMais = true;
      while (temMais) {
        const resp = await fetch(`${host}/subscriptions?status=ACTIVE&limit=${limit}&offset=${offset}`, { headers: { 'access_token': chave } });
        const data = await resp.json();
        if (!resp.ok) return res.status(200).json({ ok: false, erro: data?.errors?.[0]?.description || 'Erro ao listar assinaturas.' });
        todas = todas.concat(data.data || []);
        temMais = !!data.hasMore;
        offset += limit;
        if (offset > 2000) break;
      }
      return res.status(200).json({ ok: true, assinaturas: todas });
    }

    return res.status(400).json({ erro: 'Ação não reconhecida.' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ erro: 'Erro interno: ' + (e.message || 'desconhecido') });
  }
}
