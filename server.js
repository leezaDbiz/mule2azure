/**
 * Mule2Azure v3 — AI Migration Console
 * Node.js + Express + Azure OpenAI (gpt-5-mini)
 *
 * Setup:
 *   npm install
 *   export AZURE_OPENAI_API_KEY=<key>
 *   node server.js  →  http://localhost:7433
 */

const express  = require('express');
const cors     = require('cors');
const axios    = require('axios');
const { AzureOpenAI } = require('openai');
const path     = require('path');

const app    = express();
const openai = new AzureOpenAI({
  endpoint:   'https://mulesoft-ai-capability.openai.azure.com',
  apiKey:     process.env.AZURE_OPENAI_API_KEY || '',
  apiVersion: '2025-01-01-preview',
});
const MODEL = 'gpt-5-mini';
const PORT  = process.env.PORT || 7433;

app.use(cors({ origin: '*', methods: ['GET','POST','OPTIONS'], allowedHeaders: ['Content-Type','Authorization'] }));
app.options('/{*path}', cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.static('.'));

// ── helpers ────────────────────────────────────────────────────────────────────
function sseHead(res) {
  res.writeHead(200, { 'Content-Type':'text/event-stream', 'Cache-Control':'no-cache', 'X-Accel-Buffering':'no' });
}
function sseWrite(res, data) { res.write(`data: ${JSON.stringify(data)}\n\n`); }
async function streamCompletion(res, messages, maxTokens = 2048) {
  const stream = await openai.chat.completions.create({
    model: MODEL, max_completion_tokens: maxTokens, stream: true, messages,
  });
  for await (const chunk of stream) {
    const text = chunk.choices[0]?.delta?.content;
    if (text) sseWrite(res, { text });
  }
  sseWrite(res, { done: true });
}

const ghHeaders = (token) => ({
  'Accept': 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'Mule2Azure-Migration-Tool',
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
});

// ── health / debug ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({
  ok: true, model: MODEL, node: process.version,
  key: !!process.env.AZURE_OPENAI_API_KEY,
}));

app.get('/api/debug', (req, res) => res.json({
  ok: true, time: new Date().toISOString(), node: process.version,
  env: { hasKey: !!process.env.AZURE_OPENAI_API_KEY, port: PORT },
}));

// ══════════════════════════════════════════════════════════════════════════════
// GITHUB ENDPOINTS
// ══════════════════════════════════════════════════════════════════════════════

// List repos in an org/user
app.post('/api/github/repos', async (req, res) => {
  const { org, token } = req.body;
  if (!org) return res.status(400).json({ error: 'org is required' });
  try {
    let repos = [];
    try {
      const r = await axios.get(`https://api.github.com/orgs/${org}/repos?per_page=100&sort=updated`, { headers: ghHeaders(token) });
      repos = r.data;
    } catch {
      const r = await axios.get(`https://api.github.com/users/${org}/repos?per_page=100&sort=updated`, { headers: ghHeaders(token) });
      repos = r.data;
    }
    res.json({
      repos: repos.map(r => ({
        name: r.name, fullName: r.full_name, description: r.description || '',
        private: r.private, language: r.language, updatedAt: r.updated_at,
        defaultBranch: r.default_branch, url: r.html_url,
        likelyMule: /mule|api|integration|esb|connector|anypoint/i.test(r.name + (r.description || '')),
      })),
      total: repos.length,
    });
  } catch (e) {
    const status = e.response?.status || 502;
    const msg    = e.response?.data?.message || e.message;
    res.status(status === 404 ? 404 : 502).json({
      error: msg,
      hint: status === 404 ? 'Org/user not found — check spelling. Private orgs need read:org scope.'
          : status === 401 ? 'Token invalid — generate a new one at github.com/settings/tokens'
          : 'Check org name and token permissions (repo scope for private repos)',
    });
  }
});

// Bulk fetch all Mule project files for multiple repos in one call
app.post('/api/github/fetch-mule-files', async (req, res) => {
  const { org, repos, token } = req.body;
  if (!org || !repos?.length) return res.status(400).json({ error: 'org and repos required' });

  const PATTERNS = [
    { re: /^src\/main\/mule\/.+\.xml$/,                         type: 'mule-xml'      },
    { re: /^src\/main\/resources\/api\/.+\.(raml|yaml|yml)$/,   type: 'raml'          },
    { re: /^src\/main\/resources\/dwl\/.+\.dwl$/,               type: 'dwl'           },
    { re: /^pom\.xml$/,                                         type: 'pom'           },
    { re: /^mule-artifact\.json$/,                              type: 'mule-artifact' },
    { re: /^src\/main\/resources\/.+\.(yaml|yml|properties)$/,  type: 'config'        },
  ];

  const fetchContent = async (fullName, filePath) => {
    const r = await axios.get(`https://api.github.com/repos/${fullName}/contents/${filePath}`, { headers: ghHeaders(token) });
    return Buffer.from(r.data.content, 'base64').toString('utf8');
  };

  const results = [];
  for (const repoName of repos) {
    const fullName = `${org}/${repoName}`;
    let tree = null, branch = 'main';
    for (const b of ['main', 'master']) {
      try {
        const r = await axios.get(`https://api.github.com/repos/${fullName}/git/trees/${b}?recursive=1`, { headers: ghHeaders(token) });
        tree = r.data.tree; branch = b; break;
      } catch (_) { /* try next */ }
    }
    if (!tree) { results.push({ repo: repoName, files: [], error: 'Could not fetch tree' }); continue; }

    const matched = tree.filter(f => f.type === 'blob').filter(f => PATTERNS.some(p => p.re.test(f.path)));
    const fetched = await Promise.allSettled(matched.map(async f => {
      const patt = PATTERNS.find(p => p.re.test(f.path));
      const content = await fetchContent(fullName, f.path);
      return { path: f.path, content, type: patt.type };
    }));
    results.push({
      repo: repoName, branch,
      files: fetched.filter(r => r.status === 'fulfilled').map(r => r.value),
    });
  }
  res.json({ results });
});

// Single file content
app.post('/api/github/file', async (req, res) => {
  const { fullName, filePath, token } = req.body;
  if (!fullName || !filePath) return res.status(400).json({ error: 'fullName and filePath required' });
  try {
    const r = await axios.get(`https://api.github.com/repos/${fullName}/contents/${filePath}`, { headers: ghHeaders(token) });
    res.json({ content: Buffer.from(r.data.content, 'base64').toString('utf8'), path: filePath, size: r.data.size });
  } catch (e) { res.status(502).json({ error: e.response?.data?.message || e.message }); }
});

// ══════════════════════════════════════════════════════════════════════════════
// ANYPOINT ENDPOINTS
// ══════════════════════════════════════════════════════════════════════════════

// Auth — Connected App (client credentials) or username/password
app.post('/api/anypoint/auth', async (req, res) => {
  const { clientId, clientSecret, username, password } = req.body;
  try {
    let tokenData;
    if (clientId && clientSecret) {
      const r = await axios.post(
        'https://anypoint.mulesoft.com/accounts/api/v2/oauth2/token',
        new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
      );
      tokenData = r.data;
    } else if (username && password) {
      const r = await axios.post('https://anypoint.mulesoft.com/accounts/login', { username, password }, { headers: { 'Content-Type': 'application/json' } });
      tokenData = { access_token: r.data.access_token, token_type: 'Bearer' };
    } else {
      return res.status(400).json({ error: 'Provide clientId+clientSecret or username+password' });
    }
    const meR = await axios.get('https://anypoint.mulesoft.com/accounts/api/me', { headers: { Authorization: `Bearer ${tokenData.access_token}` } });
    res.json({
      accessToken: tokenData.access_token, tokenType: tokenData.token_type, expiresIn: tokenData.expires_in,
      orgId: meR.data.user?.organizationId, orgName: meR.data.user?.organization?.name, username: meR.data.user?.username,
    });
  } catch (e) {
    const d = e.response?.data;
    const msg = (d && typeof d === 'object') ? (d.error_description || d.message || d.error || JSON.stringify(d)) : e.message;
    res.status(401).json({ error: msg, hint: 'Connected App must be set to "Act on its own behalf" with Runtime Manager + API Manager scopes.' });
  }
});

// List environments
app.post('/api/anypoint/environments', async (req, res) => {
  const { accessToken, orgId } = req.body;
  if (!accessToken || !orgId) return res.status(400).json({ error: 'accessToken and orgId required' });
  try {
    const r = await axios.get(`https://anypoint.mulesoft.com/accounts/api/organizations/${orgId}/environments`, { headers: { Authorization: `Bearer ${accessToken}` } });
    res.json({ environments: r.data.data.map(e => ({ id: e.id, name: e.name, type: e.type, isProduction: e.isProduction, clientId: e.clientId })) });
  } catch (e) { res.status(502).json({ error: e.response?.data?.message || e.message }); }
});

// Discover Runtime Manager (CloudHub 1, CloudHub 2, Hybrid)
app.post('/api/anypoint/runtime-manager', async (req, res) => {
  const { accessToken, orgId, envId } = req.body;
  if (!accessToken || !orgId || !envId) return res.status(400).json({ error: 'accessToken, orgId, envId required' });
  try {
    const hdrs = { Authorization: `Bearer ${accessToken}`, 'X-ANYPNT-ENV-ID': envId, 'X-ANYPNT-ORG-ID': orgId };
    const [ch1, ch2, hybrid] = await Promise.allSettled([
      axios.get('https://anypoint.mulesoft.com/cloudhub/api/v2/applications', { headers: hdrs }),
      axios.get(`https://anypoint.mulesoft.com/amc/application-manager/api/v2/organizations/${orgId}/environments/${envId}/deployments`, { headers: hdrs }),
      axios.get('https://anypoint.mulesoft.com/hybrid/api/v2/applications', { headers: hdrs }),
    ]);
    const apps = [];
    if (ch1.status === 'fulfilled') for (const a of (ch1.value.data || []))
      apps.push({ name: a.domain, status: a.status, type: 'CloudHub 1.0', workers: a.workers?.amount, workerType: a.workers?.type?.name, muleVersion: a.muleVersion?.version, region: a.region, lastUpdated: a.lastUpdateTime });
    if (ch2.status === 'fulfilled') for (const a of (ch2.value.data?.items || []))
      apps.push({ name: a.name, status: a.status, type: 'CloudHub 2.0', workers: a.target?.deploymentSettings?.replicas, muleVersion: a.application?.ref?.version, region: a.target?.region, lastUpdated: a.lastModifiedDate });
    if (hybrid.status === 'fulfilled') for (const a of (hybrid.value.data?.data || hybrid.value.data || []))
      apps.push({ name: a.name, status: a.lastReportedStatus || a.desiredStatus, type: 'Hybrid', server: a.target?.name, muleVersion: a.artifact?.name, lastUpdated: a.lastUpdateTime });
    res.json({ apps, total: apps.length });
  } catch (e) { res.status(502).json({ error: e.response?.data?.message || e.message }); }
});

// Discover API Manager (with policies inline)
app.post('/api/anypoint/api-manager', async (req, res) => {
  const { accessToken, orgId, envId } = req.body;
  if (!accessToken || !orgId || !envId) return res.status(400).json({ error: 'accessToken, orgId, envId required' });
  try {
    const hdrs = { Authorization: `Bearer ${accessToken}` };
    const apisR = await axios.get(`https://anypoint.mulesoft.com/apimanager/api/v1/organizations/${orgId}/environments/${envId}/apis?limit=100`, { headers: hdrs });
    const rawApis = apisR.data.assets || [];
    const results = await Promise.allSettled(rawApis.map(async api => {
      let policies = [];
      try {
        const polR = await axios.get(`https://anypoint.mulesoft.com/apimanager/api/v1/organizations/${orgId}/environments/${envId}/apis/${api.id}/policies`, { headers: hdrs });
        policies = (polR.data || []).map(p => p.template?.assetId || p.policyTemplateId || String(p.id)).filter(Boolean);
      } catch (_) { /* no policies or no permission */ }
      return { id: api.id, name: api.assetId || api.exchangeAssetName || api.name, version: api.productVersion || api.assetVersion, status: api.status, technology: api.technology || (api.endpoint?.muleVersion4OrAbove ? 'mule4' : null), endpoint: api.endpoint?.uri, policies, autodiscovery: api.autodiscoveryInstanceName };
    }));
    res.json({ apis: results.filter(r => r.status === 'fulfilled').map(r => r.value), total: rawApis.length });
  } catch (e) { res.status(502).json({ error: e.response?.data?.message || e.message }); }
});

// Policies for a specific API
app.post('/api/anypoint/policies', async (req, res) => {
  const { accessToken, orgId, envId, apiId } = req.body;
  if (!accessToken || !orgId || !envId || !apiId) return res.status(400).json({ error: 'accessToken, orgId, envId, apiId required' });
  try {
    const r = await axios.get(`https://anypoint.mulesoft.com/apimanager/api/v1/organizations/${orgId}/environments/${envId}/apis/${apiId}/policies`, { headers: { Authorization: `Bearer ${accessToken}` } });
    res.json({ policies: (r.data || []).map(p => ({ policyId: p.id, name: p.template?.name || p.template?.assetId || p.policyTemplateId, configurationData: p.configuration || p.configurationData || {}, order: p.order })) });
  } catch (e) { res.status(502).json({ error: e.response?.data?.message || e.message }); }
});

// SLA tiers for a specific API
app.post('/api/anypoint/sla-tiers', async (req, res) => {
  const { accessToken, orgId, envId, apiId } = req.body;
  if (!accessToken || !orgId || !envId || !apiId) return res.status(400).json({ error: 'accessToken, orgId, envId, apiId required' });
  try {
    const r = await axios.get(`https://anypoint.mulesoft.com/apimanager/api/v1/organizations/${orgId}/environments/${envId}/apis/${apiId}/tiers`, { headers: { Authorization: `Bearer ${accessToken}` } });
    res.json({ tiers: (r.data?.tiers || r.data || []).map(t => ({ name: t.name, limits: (t.limits || []).map(l => ({ timePeriodInMilliseconds: l.timePeriodInMilliseconds, maximumRequests: l.maximumRequests })) })) });
  } catch (e) { res.status(502).json({ error: e.response?.data?.message || e.message }); }
});

// Contracts (consumers) for a specific API
app.post('/api/anypoint/contracts', async (req, res) => {
  const { accessToken, orgId, envId, apiId } = req.body;
  if (!accessToken || !orgId || !envId || !apiId) return res.status(400).json({ error: 'accessToken, orgId, envId, apiId required' });
  try {
    const r = await axios.get(`https://anypoint.mulesoft.com/apimanager/api/v1/organizations/${orgId}/environments/${envId}/apis/${apiId}/contracts`, { headers: { Authorization: `Bearer ${accessToken}` } });
    res.json({ contracts: (r.data?.contracts || r.data || []).map(c => ({ applicationName: c.application?.name || c.applicationName, status: c.status, tier: c.tier?.name || c.tierName })) });
  } catch (e) { res.status(502).json({ error: e.response?.data?.message || e.message }); }
});

// Exchange assets
app.post('/api/anypoint/exchange', async (req, res) => {
  const { accessToken, orgId } = req.body;
  if (!accessToken || !orgId) return res.status(400).json({ error: 'accessToken and orgId required' });
  try {
    const r = await axios.get(`https://anypoint.mulesoft.com/exchange/api/v2/assets?organizationId=${orgId}&types=rest-api,raml-fragment&limit=100`, { headers: { Authorization: `Bearer ${accessToken}` } });
    res.json({ assets: (r.data || []).map(a => ({ assetId: a.assetId, name: a.name, version: a.version, type: a.type, description: a.description })) });
  } catch (e) { res.status(502).json({ error: e.response?.data?.message || e.message }); }
});

// ══════════════════════════════════════════════════════════════════════════════
// AI ENDPOINTS — all streaming SSE
// ══════════════════════════════════════════════════════════════════════════════

// Score a project — AI inventory scoring (most important step)
app.post('/api/ai/score-project', async (req, res) => {
  sseHead(res);
  const { name, tier, flowXml, ramlContent, dwlFiles, pomContent, anypointApp, policies, slaTiers, contracts } = req.body;

  const connectors = [];
  if (/sap:/i.test(flowXml || '')) connectors.push('SAP');
  if (/salesforce:/i.test(flowXml || '')) connectors.push('Salesforce');
  if (/db:|database:/i.test(flowXml || '')) connectors.push('Database');
  if (/kafka:/i.test(flowXml || '')) connectors.push('Kafka');
  if (/jms:/i.test(flowXml || '')) connectors.push('JMS');

  const prompt = `You are a MuleSoft migration expert. Analyse this MuleSoft project and produce a structured assessment for migration to Azure.

Project: ${name}
Tier: ${tier}
Connectors detected: ${connectors.join(', ') || 'HTTP only'}
Has Object Store: ${/os:|object-store/i.test(flowXml || '')}
Has batch jobs: ${/<batch:/i.test(flowXml || '')}
Has SAP RFC: ${/sap:|BAPI_/i.test(flowXml || '')}
Has DWL transforms: ${(dwlFiles || []).length + (flowXml || '').split('<ee:transform').length - 1} total
Has idempotency: ${/idempoten|os:contains/i.test(flowXml || '')}
Has error handlers: ${/<error-handler/i.test(flowXml || '')}
Orchestration chains: ${(flowXml || '').match(/flow-ref/g)?.length || 0} flow-refs
Applied Anypoint policies: ${(policies || []).map(p => p.name || p).join(', ') || 'none'}
SLA tiers: ${(slaTiers || []).map(t => t.name).join(', ') || 'none'}
Consumer contracts: ${(contracts || []).length} apps consuming this API
CloudHub workers: ${anypointApp?.workers || 'unknown'} × ${anypointApp?.workerType || 'unknown'}
Mule version: ${anypointApp?.muleVersion || 'unknown'}

RAML spec available: ${!!ramlContent}
Flow XML length: ${(flowXml || '').length} chars

Respond in EXACTLY this format — one value per line, no extra text:
BUSINESS_DESCRIPTION: [2-3 sentence plain English description of what this API does for the business — not technical, not "it has flows", explain the business function]
COMPLEXITY: [Low|Medium|High|Critical]
COMPLEXITY_REASON: [one sentence explaining why this complexity score]
KEY_SIGNALS: [comma-separated list from: SAP,ObjectStore,Batch,ComplexDWL,MultipleOrchestration,ExternalDB,Kafka,JMS,CustomPolicies,HighTraffic,ManyConsumers]
STAKEHOLDER_IMPACT: [number of consumer apps or "unknown"]
RECOMMENDED_STRATEGY: [A|B] where A=convert code, B=replicate functionality
STRATEGY_REASON: [one sentence — why A or B for this specific project]
RUNTIME_TARGET: [FunctionApp|LogicApp|LogicAppWithFunctions|FunctionApp+ServiceBus]
MIGRATION_ORDER: [1|2|3] where 1=first(system APIs), 2=middle(process APIs), 3=last(experience APIs)
EFFORT_WEEKS: [integer — realistic estimate]
TOP_RISK: [one sentence — single biggest risk for this specific project]
AZURE_SERVICES: [comma-separated Azure services needed: e.g. FunctionApp,APIM,ServiceBus,TableStorage,KeyVault,VNet]`;

  try {
    await streamCompletion(res, [
      { role: 'system', content: 'You are a MuleSoft-to-Azure migration expert. Respond ONLY in the exact format shown. No preamble, no explanation, no markdown.' },
      { role: 'user', content: prompt },
    ]);
  } catch (e) { sseWrite(res, { error: e.message }); }
  res.end();
});

// Batch score up to 20 projects in parallel
app.post('/api/ai/batch-score', async (req, res) => {
  const { projects } = req.body;
  if (!projects?.length) return res.status(400).json({ error: 'projects array required' });

  const results = await Promise.allSettled(projects.map(async p => {
    const connectors = [];
    if (/sap:/i.test(p.flowXml || '')) connectors.push('SAP');
    if (/salesforce:/i.test(p.flowXml || '')) connectors.push('Salesforce');
    if (/db:|database:/i.test(p.flowXml || '')) connectors.push('Database');

    const prompt = `Analyse this MuleSoft project for migration to Azure.
Project: ${p.name} | Tier: ${p.tier}
Connectors: ${connectors.join(',') || 'HTTP'}
Has ObjectStore: ${/os:|object-store/i.test(p.flowXml||'')}
Has SAP: ${/sap:/i.test(p.flowXml||'')}
Has Batch: ${/<batch:/i.test(p.flowXml||'')}
DWL count: ${(p.flowXml||'').split('<ee:transform').length-1}
Flow-refs: ${(p.flowXml||'').match(/flow-ref/g)?.length||0}
Consumers: ${(p.contracts||[]).length}

BUSINESS_DESCRIPTION: [2-3 sentence plain English business description]
COMPLEXITY: [Low|Medium|High|Critical]
COMPLEXITY_REASON: [one sentence]
KEY_SIGNALS: [comma list]
RECOMMENDED_STRATEGY: [A|B]
RUNTIME_TARGET: [FunctionApp|LogicApp|LogicAppWithFunctions]
MIGRATION_ORDER: [1|2|3]
EFFORT_WEEKS: [integer]
TOP_RISK: [one sentence]`;

    const completion = await openai.chat.completions.create({
      model: MODEL, max_completion_tokens: 500, stream: false,
      messages: [
        { role: 'system', content: 'MuleSoft-to-Azure migration expert. Respond only in the exact format shown.' },
        { role: 'user', content: prompt },
      ],
    });
    return { name: p.name, raw: completion.choices[0].message.content };
  }));

  res.json({
    scores: results.map((r, i) => ({
      name: projects[i].name,
      raw:  r.status === 'fulfilled' ? r.value.raw : null,
      error: r.status === 'rejected' ? r.reason?.message : null,
    })),
  });
});

// Option B — extract intent then implement natively then generate tests
app.post('/api/ai/intent', async (req, res) => {
  sseHead(res);
  const { project, tier, flowXml, businessDescription, keySignals } = req.body;

  const prompt = `You are a senior Azure integration architect doing Option B migration: understand the business intent of a MuleSoft flow then implement it natively in Azure — NOT a mechanical translation.

Project: ${project} (${tier})
Business description: ${businessDescription}
Key signals: ${keySignals}

Mule flow XML:
\`\`\`xml
${(flowXml || '').slice(0, 3000)}
\`\`\`

Produce EXACTLY four sections in this order:

=== BUSINESS INTENT ===
What this flow does in plain English — 5-10 bullet points covering:
- What triggers it
- What it validates
- What it calls downstream and why
- What it returns
- What happens on each error condition
This must be understandable by a business analyst, not just a developer.

=== EDGE CASES AND ERROR CONDITIONS ===
List every edge case and error condition you can identify from the XML:
- Each Mule error type and what it means
- Retry/reconnect logic
- Idempotency checks
- Timeout scenarios
- Each condition in choice routers
Be specific — use the actual error type names from the XML.

=== AZURE NATIVE IMPLEMENTATION ===
Write complete production Python code for the Azure Function that implements this business intent.
Requirements:
- import azure.functions as func
- Implement the ACTUAL business logic — not TODO placeholders
- Use Managed Identity for all Azure service access (no connection strings)
- Structured JSON logging with correlation_id on every log line
- Mirror each error condition from EDGE CASES with correct HTTP status codes
- If idempotency: Azure Table Storage conditional check before processing
- If queue publish: Azure Service Bus with Managed Identity
- Read all config from os.environ
- Include function.json configuration at the top as a comment block

=== PYTEST TESTS ===
Write pytest tests for the business behaviour (not the implementation):
- One test per edge case identified above
- Use unittest.mock to mock Azure SDK calls
- Test happy path
- Test each error condition
- Test idempotency (duplicate request returns 409)
- Include realistic test data based on the actual field names in the XML`;

  try {
    await streamCompletion(res, [
      { role: 'system', content: 'You are a senior Azure integration architect. Write production-quality code and tests.' },
      { role: 'user', content: prompt },
    ], 3000);
  } catch (e) { sseWrite(res, { error: e.message }); }
  res.end();
});

// HLD — High Level Design document
app.post('/api/ai/hld', async (req, res) => {
  sseHead(res);
  const { projects, decisions, totalEffortWeeks } = req.body;

  const prompt = `You are a senior Azure integration architect. Generate a High Level Design (HLD) document for migrating these MuleSoft projects to Azure Integration Services.

Projects being migrated:
${(projects || []).map(p => `- ${p.name} (${p.tier}): ${p.flowCount||'?'} flows, connectors: [${p.connectors?.join(',')||'HTTP'}], complexity: ${p.complexity||'?'}, strategy: Option ${p.strategy||'A'}, runtime: ${p.runtime||'FunctionApp'}`).join('\n')}

Total estimated effort: ${totalEffortWeeks || '?'} weeks
Migration order: System APIs → Process APIs → Experience APIs (strangler fig)

Generate a structured HLD covering:
1. EXECUTIVE SUMMARY — business drivers, scope, expected outcomes, cost impact (30% savings conservative estimate)
2. AZURE TARGET ARCHITECTURE — service selection per project tier with justification
3. NETWORK TOPOLOGY — VNet design, subnets, private endpoints, ExpressRoute for SAP if applicable
4. SECURITY DESIGN — Managed Identity, Key Vault, Entra ID replacing Mule OAuth, APIM policies
5. INTEGRATION PATTERNS — sync vs async, retry strategy, DLQ alerting from day one, idempotency
6. OBSERVABILITY — App Insights, Log Analytics, correlation IDs, structured logging standard
7. MIGRATION STRATEGY — strangler fig with APIM as façade, parallel run criteria, cutover checklist
8. TEAM AND SKILLS — skills gap between Mule and Azure, training needed
9. RISKS AND MITIGATIONS — top risks based on actual signals found (SAP, DataWeave, Object Store etc)

Be specific. Reference actual Azure service names and SKUs. Use the project data above.`;

  try {
    await streamCompletion(res, [
      { role: 'system', content: 'You are a senior Azure integration architect. Write technical design documents.' },
      { role: 'user', content: prompt },
    ], 3000);
  } catch (e) { sseWrite(res, { error: e.message }); }
  res.end();
});

// LLD — Low Level Design per project
app.post('/api/ai/lld', async (req, res) => {
  sseHead(res);
  const { project, analysis } = req.body;

  const prompt = `Generate a Low Level Design (LLD) for migrating this MuleSoft project to Azure.

Project: ${project.name} (${project.tier})
Business description: ${project.businessDescription || 'not provided'}
Flows: ${analysis.flowCount}, DWL transforms: ${analysis.dwlCount}
Connectors: ${analysis.connectors?.join(', ') || 'HTTP only'}
Has Object Store: ${analysis.hasObjectStore}
Has idempotency: ${analysis.hasIdempotency}
Orchestration chains: ${analysis.orchChains || 'none'}
Applied policies: ${analysis.policies?.join(', ') || 'none'}
SLA tiers: ${analysis.slaTiers?.map(t=>t.name).join(', ') || 'none'}
Consumers: ${analysis.contracts?.length || 0} apps

Generate LLD covering:
1. COMPONENT DESIGN — each Azure Function/Logic App with inputs, outputs, dependencies
2. API SPECIFICATION — every endpoint with method, path, request/response schema, error codes
3. DATA MAPPING — DataWeave transforms mapped to Python, flagging complex ones needing review
4. ERROR HANDLING — every Mule error type mapped to Azure pattern with HTTP status
5. CONFIGURATION — all environment variables, Key Vault secret names, connection strings
6. TESTING APPROACH — unit tests, integration tests, idempotency tests with example payloads
7. DEPLOYMENT SEQUENCE — ordered steps with validation checkpoints between each`;

  try {
    await streamCompletion(res, [
      { role: 'system', content: 'You are a senior Azure integration architect. Write detailed technical specifications.' },
      { role: 'user', content: prompt },
    ], 2500);
  } catch (e) { sseWrite(res, { error: e.message }); }
  res.end();
});

// Generic convert — analyse, function, dwl, rbac, logicapp
app.post('/api/ai/convert', async (req, res) => {
  if (!process.env.AZURE_OPENAI_API_KEY) return res.status(500).json({ error: 'AZURE_OPENAI_API_KEY not set' });
  sseHead(res);
  const { system, prompt } = buildPrompt(req.body.task, req.body.payload);
  try {
    await streamCompletion(res, [{ role: 'system', content: system }, { role: 'user', content: prompt }]);
  } catch (e) { sseWrite(res, { error: e.message }); }
  res.end();
});

// Per-project migration runbook (the main deliverable)
app.post('/api/ai/runbook', async (req, res) => {
  sseHead(res);
  const { project, score, decision, artifacts, policies, slaTiers, contracts, anypointApp } = req.body;

  const prompt = `You are a technical delivery manager. Write a migration runbook for this specific API.
This runbook will be given to the development team to execute the migration.

API: ${project.name} (${project.tier})
Business description: ${score?.businessDescription || 'not provided'}
Complexity: ${score?.complexity || 'unknown'}
Key risks: ${score?.topRisk || 'none identified'}
Azure target: ${decision?.runtime || 'FunctionApp'}
Migration strategy: Option ${decision?.strategy || 'A'} (${decision?.strategy === 'B' ? 'replicate functionality' : 'convert code'})
Effort estimate: ${score?.effortWeeks || '?'} weeks
Applied Mule policies: ${(policies || []).map(p=>p.name||p).join(', ') || 'none'}
SLA tiers: ${(slaTiers || []).map(t=>t.name+': '+t.limits?.map(l=>`${l.maximumRequests} req/${Math.round((l.timePeriodInMilliseconds||60000)/60000)}min`).join(',')).join(' | ') || 'none'}
Current consumers: ${(contracts || []).map(c=>c.applicationName).join(', ') || 'none known'}
Current workers: ${anypointApp?.workers || '?'} × ${anypointApp?.workerType || '?'} on ${anypointApp?.region || '?'}
Artifacts generated: ${(artifacts || []).join(', ') || 'none yet'}

Write the runbook with these sections:

## ${project.name} — Migration Runbook

### 1. What this API does
[Plain English. What business process does this enable. Who uses it. What happens if it goes down.]

### 2. What replaces it in Azure
[Specific Azure services, resource names with naming convention, how they map to the current Mule components]

### 3. Security and policies to recreate
[Each Mule policy mapped to its Azure APIM equivalent. SLA tiers mapped to APIM products.]

### 4. Migration steps (ordered)
[Numbered list. Specific. Actionable. Include validation between each step.]

### 5. Parallel run criteria
[What must be true to run Mule and Azure in parallel. How to compare responses. How long to run in parallel before cutover.]

### 6. Cutover checklist
[Items to verify before switching traffic fully to Azure. Include consumer notification.]

### 7. Consumer impact
[Who is consuming this API. What they need to do. Who to notify and when.]

### 8. Rollback plan
[If something goes wrong after cutover, exactly how to roll back to Mule.]

Be specific. Use actual resource names. This document will be followed by a developer.`;

  try {
    await streamCompletion(res, [
      { role: 'system', content: 'You are a technical delivery manager writing migration runbooks for a development team.' },
      { role: 'user', content: prompt },
    ], 2500);
  } catch (e) { sseWrite(res, { error: e.message }); }
  res.end();
});

// Executive report across all projects
app.post('/api/report', async (req, res) => {
  sseHead(res);
  const { summary, projects, scores, decisions } = req.body;

  const prompt = `Generate a professional executive migration report for a MuleSoft to Azure Integration Services migration.

Migration overview:
- Total APIs: ${summary?.totalApis || projects?.length || 0}
- Total flows: ${summary?.totalFlows || 0}
- DataWeave transforms: ${summary?.totalDwl || 0}
- Complexity breakdown: ${summary?.complexityBreakdown || 'not available'}
- Total estimated effort: ${summary?.totalWeeks || '?'} weeks
- Estimated cost saving: ~30% vs MuleSoft licensing (conservative, based on real migrations)

Projects:
${(projects||[]).map(p => {
  const s = scores?.[p.name] || {};
  const d = decisions?.[p.name] || {};
  return `- ${p.name} (${p.tier}): ${s.complexity||'?'} complexity, Option ${d.strategy||'A'}, ${s.effortWeeks||'?'} weeks, ${s.stakeholderImpact||'?'} consumers`;
}).join('\n')}

Generate report with sections:
1. EXECUTIVE SUMMARY (3-4 sentences for CTO/VP — cost, timeline, business impact)
2. MIGRATION SCOPE (what is being migrated and why)
3. ARCHITECTURE DECISIONS (key choices made and why)
4. EFFORT AND TIMELINE (total weeks, phase breakdown, team size needed)
5. COST ANALYSIS (MuleSoft vCore cost vs Azure consumption, projected savings)
6. RISKS AND MITIGATIONS (top 5 risks across all projects)
7. WHAT NEEDS HUMAN ATTENTION (DataWeave reviews, SAP VNet, policy recreation)
8. RECOMMENDED MIGRATION SEQUENCE (strangler fig order with milestones)
9. SIGN-OFF CHECKLIST (before production cutover)

Write professionally. Be specific with numbers. Suitable for board presentation.`;

  try {
    await streamCompletion(res, [
      { role: 'system', content: 'You are a technical delivery manager writing board-level migration reports.' },
      { role: 'user', content: prompt },
    ], 2500);
  } catch (e) { sseWrite(res, { error: e.message }); }
  res.end();
});

// ── prompt builder (kept for backward compat with /api/ai/convert) ────────────
function buildPrompt(task, p) {
  if (task === 'analyse') return {
    system: 'You are a MuleSoft-to-Azure migration expert. Respond ONLY in the exact format shown — no preamble.',
    prompt: `Analyse this MuleSoft project for Azure Integration Services migration.
Project: ${p.name} | Tier: ${p.tier}
Flows: ${p.flow_count} (${p.endpoint_count} HTTP endpoints)
Connectors: ${p.connectors || 'HTTP only'}
DataWeave transforms: ${p.dwl_count}
Has Object Store: ${p.has_object_store} | Has idempotency: ${p.has_idempotency}
Has error handlers: ${p.has_error_handler} | Has batch: ${p.has_batch}
Orchestration chains: ${p.orchestration_chains || 'none'}
Reconnect configs: ${p.reconnects} flows
RUNTIME_TARGET: [FunctionApp|LogicApp|LogicAppWithFunctions|FunctionApp+ServiceBus]
REASON: [one sentence]
DWL_COMPLEXITY: [Low|Medium|High|VeryHigh]
DWL_NOTES: [one sentence]
EFFORT_WEEKS: [integer]
TOP_RISK: [one sentence]
RBAC_NEEDS: [comma-separated Azure services]
MIGRATION_ORDER: [first|middle|last]`,
  };

  if (task === 'function') return {
    system: 'You are an Azure Functions expert. Output ONLY Python code — no markdown fences.',
    prompt: `Write a production Azure Function HTTP trigger in Python.
Project: ${p.project} | Tier: ${p.tier}
Flow: ${p.flow_name} | ${p.http_method} ${p.http_path}
Downstream calls: ${p.downstream_calls || 'none'}
Has DataWeave: ${p.has_transform} | Has error handler: ${p.has_error_handler}
Publishes to queue: ${p.publishes || 'no'} | Has idempotency: ${p.has_idempotency}
MuleSoft flow XML:\n\`\`\`xml\n${(p.flow_xml || '').slice(0, 2000)}\n\`\`\`
Requirements:
1. import azure.functions as func
2. Derive ACTUAL business logic from the flow XML — no TODOs
3. CONNECTIVITY → 503, validation → 400, ANY → 500
4. Structured JSON logging with correlation_id
5. If has_idempotency: check Azure Table Storage first
6. If publishes: send to Azure Service Bus using Managed Identity
7. Read all config from os.environ
Start with imports.`,
  };

  if (task === 'dwl') return {
    system: 'You are a DataWeave-to-Python expert. Output ONLY Python code — no markdown fences.',
    prompt: `Transpile this DataWeave 2.0 transform to Python precisely.
Project: ${p.project} | Transform: ${p.name}
DataWeave source:\n\`\`\`\n${p.source}\n\`\`\`
Write transform(payload, attributes=None) that:
1. Replicates every field exactly — no shortcuts, no TODOs
2. None/null safety everywhere DWL handles it silently
3. map (item,idx) -> → list comprehension with enumerate
4. sum(x map ...) → sum() + comprehension
5. sizeOf() → len(), uuid() → str(uuid.uuid4()), now() → datetime.now()
6. payload.field default "x" → payload.get('field','x')
7. leftPad/trim → write helpers above transform()
8. Inline comment per DWL construct showing the mapping
Start with imports.`,
  };

  if (task === 'rbac') return {
    system: 'You are an Azure RBAC expert. Output ONLY a valid JSON array — no markdown.',
    prompt: `Generate Azure RBAC role assignments for this migrated project.
Project: ${p.project} | Tier: ${p.tier}
Connectors: ${p.connectors || 'HTTP only'}
Publishes to Service Bus: ${p.publishes_sb}
Needs Cosmos/Table (Object Store): ${p.has_object_store}
SAP connector (VNet): ${p.has_sap}
Runtime: ${p.runtime_target}
Output a JSON array. Each element:
{ "description": "...", "principalType": "ServicePrincipal", "principalId": "{{MANAGED_IDENTITY_OBJECT_ID}}", "roleDefinitionName": "exact Azure built-in role name", "scope": "/subscriptions/{{SUB_ID}}/resourceGroups/{{RG}}/providers/..." }
Rules: least privilege, Managed Identity only, Key Vault Secrets User always, Monitoring Metrics Publisher always.`,
  };

  if (task === 'logicapp') return {
    system: 'You are an Azure Logic Apps Standard expert. Output ONLY valid Logic App workflow JSON — no markdown.',
    prompt: `Generate an Azure Logic App Standard workflow for this MuleSoft process flow.
Project: ${p.project} | Flow: ${p.flow_name}
Steps in order: ${p.steps}
Each step: ${p.step_details}
Publishes to Service Bus: ${p.publishes || 'no'}
Has idempotency: ${p.has_idempotency}
Generate the workflow "definition" object with HTTP Request trigger, one HTTP action per step with runAfter chaining, Fixed retry policy (count 3, interval PT5S), Scope+Catch for error handling, Service Bus action if publishes (Managed Identity), Table Storage idempotency check if needed, Response action 201.`,
  };

  return { system: 'You are a helpful assistant.', prompt: 'Help with this migration task.' };
}

// ── serve frontend ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ── start ──────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  const key = process.env.AZURE_OPENAI_API_KEY || '';
  console.log('\n' + '─'.repeat(52));
  console.log('  Mule2Azure v3 — AI Migration Console');
  console.log('  Runtime : Node.js ' + process.version);
  console.log('  LLM     : Azure OpenAI (' + MODEL + ')');
  console.log('  Target  : Azure Integration Services');
  console.log('─'.repeat(52));
  if (!key) { console.log('\n  ⚠  AZURE_OPENAI_API_KEY not set\n'); }
  else { console.log(`\n  ✓ API key: ${key.slice(0,8)}...\n  ✓ http://localhost:${PORT}\n`); }
});
