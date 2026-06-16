/**
 * Mule2Azure — Node.js server
 * 
 * Handles all 13 migration steps:
 * Steps 1-4:  Real GitHub + Anypoint Platform API calls
 * Steps 5-8:  Mule XML parsing + AI architecture decisions
 * Steps 9-11: Artifact generation + Azure deployment
 * Steps 12-13: Validation + migration report
 * 
 * Setup:
 *   npm install
 *   export OPENAI_API_KEY=sk-...
 *   node server.js
 *   open http://localhost:7433
 */

const express = require('express');
const cors    = require('cors');
const axios   = require('axios');
const OpenAI  = require('openai');
const path    = require('path');
const fs      = require('fs');

const app    = express();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || '' });
const MODEL  = 'gpt-4o';
const PORT   = process.env.PORT || 7433;  // Render sets PORT automatically

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.options('*', cors()); // handle preflight for all routes
app.use(express.json({ limit: '10mb' }));
app.use(express.static('.'));

// ─────────────────────────────────────────────
// Health check
// ─────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    model: MODEL,
    key: !!process.env.OPENAI_API_KEY,
    node: process.version,
  });
});

// ─────────────────────────────────────────────
// Debug endpoint — test in browser: /api/debug
// ─────────────────────────────────────────────
app.get('/api/debug', (req, res) => {
  res.json({
    ok: true,
    time: new Date().toISOString(),
    node: process.version,
    env: {
      hasOpenAiKey: !!process.env.OPENAI_API_KEY,
      port: process.env.PORT || 7433,
      nodeEnv: process.env.NODE_ENV || 'development',
    },
    headers: req.headers,
  });
});

// ─────────────────────────────────────────────
// STEP 1 — GitHub: list repos in an org/user
// ─────────────────────────────────────────────
app.post('/api/github/repos', async (req, res) => {
  const { org, token } = req.body;
  if (!org) return res.status(400).json({ error: 'org is required' });

  try {
    const headers = {
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'Mule2Azure-Migration-Tool',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };

    // Try org endpoint first, fall back to user endpoint
    let repos = [];
    try {
      const r = await axios.get(
        `https://api.github.com/orgs/${org}/repos?per_page=100&sort=updated`,
        { headers }
      );
      repos = r.data;
    } catch {
      const r = await axios.get(
        `https://api.github.com/users/${org}/repos?per_page=100&sort=updated`,
        { headers }
      );
      repos = r.data;
    }

    // Filter likely Mule projects by name patterns or language
    const muleRepos = repos.map(r => ({
      name:        r.name,
      fullName:    r.full_name,
      description: r.description || '',
      private:     r.private,
      language:    r.language,
      updatedAt:   r.updated_at,
      defaultBranch: r.default_branch,
      url:         r.html_url,
      // Heuristic: likely Mule if name contains these keywords
      likelyMule:  /mule|api|integration|esb|connector|anypoint/i.test(r.name + (r.description || '')),
    }));

    res.json({ repos: muleRepos, total: muleRepos.length });
  } catch (e) {
    const status = e.response?.status || 502;
    const message = e.response?.data?.message || e.message;
    console.error(`GitHub API error [${status}]:`, message);
    res.status(status === 404 ? 404 : 502).json({
      error: message,
      status,
      hint: status === 404
        ? 'Org/user not found — check spelling. If it is a private org, a token with "read:org" scope is required.'
        : status === 401
        ? 'Token invalid or expired — generate a new one at github.com/settings/tokens'
        : 'Check org name and token permissions (repo scope needed for private repos)',
      docs: 'https://docs.github.com/en/rest/repos/repos#list-organization-repositories',
    });
  }
});

// ─────────────────────────────────────────────
// STEP 1b — GitHub: fetch file tree of a repo
// ─────────────────────────────────────────────
app.post('/api/github/tree', async (req, res) => {
  const { fullName, branch, token } = req.body;
  if (!fullName) return res.status(400).json({ error: 'fullName is required' });

  try {
    const headers = {
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'Mule2Azure-Migration-Tool',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
    const branchName = branch || 'main';

    const r = await axios.get(
      `https://api.github.com/repos/${fullName}/git/trees/${branchName}?recursive=1`,
      { headers }
    );

    // Filter to relevant Mule files
    const muleFiles = r.data.tree
      .filter(f => f.type === 'blob')
      .filter(f => /\.(xml|raml|yaml|yml|dwl|json)$/.test(f.path))
      .filter(f => !/node_modules|\.git|target\//.test(f.path))
      .map(f => ({ path: f.path, sha: f.sha, size: f.size }));

    res.json({ files: muleFiles, total: muleFiles.length, branch: branchName });
  } catch (e) {
    // Try 'master' if 'main' fails
    if (branch !== 'master') {
      req.body.branch = 'master';
      return app._router.handle(
        Object.assign(req, { url: '/api/github/tree' }), res, () => {}
      );
    }
    res.status(502).json({ error: e.response?.data?.message || e.message });
  }
});

// ─────────────────────────────────────────────
// STEP 1c — GitHub: fetch file content
// ─────────────────────────────────────────────
app.post('/api/github/file', async (req, res) => {
  const { fullName, filePath, token } = req.body;
  if (!fullName || !filePath) return res.status(400).json({ error: 'fullName and filePath required' });

  try {
    const headers = {
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'Mule2Azure-Migration-Tool',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
    const r = await axios.get(
      `https://api.github.com/repos/${fullName}/contents/${filePath}`,
      { headers }
    );
    const content = Buffer.from(r.data.content, 'base64').toString('utf8');
    res.json({ content, path: filePath, size: r.data.size });
  } catch (e) {
    res.status(502).json({ error: e.response?.data?.message || e.message });
  }
});

// ─────────────────────────────────────────────
// STEP 2 — Anypoint Platform auth
// ─────────────────────────────────────────────
app.post('/api/anypoint/auth', async (req, res) => {
  const { clientId, clientSecret, username, password } = req.body;

  try {
    let tokenData;

    if (clientId && clientSecret) {
      // Connected App auth (OAuth2 client credentials)
      const r = await axios.post(
        'https://anypoint.mulesoft.com/accounts/api/v2/oauth2/token',
        new URLSearchParams({
          grant_type:    'client_credentials',
          client_id:     clientId,
          client_secret: clientSecret,
        }),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
      );
      tokenData = r.data;
    } else if (username && password) {
      // Username/password auth
      const r = await axios.post(
        'https://anypoint.mulesoft.com/accounts/login',
        { username, password },
        { headers: { 'Content-Type': 'application/json' } }
      );
      tokenData = { access_token: r.data.access_token, token_type: 'Bearer' };
    } else {
      return res.status(400).json({ error: 'Provide clientId+clientSecret or username+password' });
    }

    // Get org info
    const meR = await axios.get('https://anypoint.mulesoft.com/accounts/api/me', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });

    res.json({
      accessToken:  tokenData.access_token,
      tokenType:    tokenData.token_type,
      expiresIn:    tokenData.expires_in,
      orgId:        meR.data.user?.organizationId,
      orgName:      meR.data.user?.organization?.name,
      username:     meR.data.user?.username,
    });
  } catch (e) {
    res.status(401).json({
      error: e.response?.data?.message || e.response?.data?.error || e.message,
      hint: 'Check credentials. Connected App needs "Runtime Manager" and "API Manager" scopes.',
    });
  }
});

// ─────────────────────────────────────────────
// STEP 3 — Anypoint: list environments
// ─────────────────────────────────────────────
app.post('/api/anypoint/environments', async (req, res) => {
  const { accessToken, orgId } = req.body;
  if (!accessToken || !orgId) return res.status(400).json({ error: 'accessToken and orgId required' });

  try {
    const r = await axios.get(
      `https://anypoint.mulesoft.com/accounts/api/organizations/${orgId}/environments`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    const envs = r.data.data.map(e => ({
      id:         e.id,
      name:       e.name,
      type:       e.type,        // production | sandbox | design
      isProduction: e.isProduction,
      clientId:   e.clientId,
    }));

    res.json({ environments: envs });
  } catch (e) {
    res.status(502).json({ error: e.response?.data?.message || e.message });
  }
});

// ─────────────────────────────────────────────
// STEP 4 — Anypoint: discover Runtime Manager apps
// ─────────────────────────────────────────────
app.post('/api/anypoint/runtime-manager', async (req, res) => {
  const { accessToken, orgId, envId } = req.body;
  if (!accessToken || !orgId || !envId) return res.status(400).json({ error: 'accessToken, orgId, envId required' });

  try {
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      'X-ANYPNT-ENV-ID': envId,
      'X-ANYPNT-ORG-ID': orgId,
    };

    // Runtime Manager: deployed apps
    const appsR = await axios.get(
      `https://anypoint.mulesoft.com/cloudhub/api/v2/applications`,
      { headers }
    );

    const apps = appsR.data.map(app => ({
      name:          app.domain,
      status:        app.status,
      workers:       app.workers?.amount,
      workerType:    app.workers?.type?.name,
      muleVersion:   app.muleVersion?.version,
      region:        app.region,
      lastUpdated:   app.lastUpdateTime,
      properties:    Object.keys(app.properties || {}).length,
    }));

    res.json({ apps, total: apps.length });
  } catch (e) {
    res.status(502).json({ error: e.response?.data?.message || e.message });
  }
});

// ─────────────────────────────────────────────
// STEP 4b — Anypoint: discover API Manager APIs
// ─────────────────────────────────────────────
app.post('/api/anypoint/api-manager', async (req, res) => {
  const { accessToken, orgId, envId } = req.body;
  if (!accessToken || !orgId || !envId) return res.status(400).json({ error: 'accessToken, orgId, envId required' });

  try {
    const headers = { Authorization: `Bearer ${accessToken}` };

    const apisR = await axios.get(
      `https://anypoint.mulesoft.com/apimanager/api/v1/organizations/${orgId}/environments/${envId}/apis?limit=100`,
      { headers }
    );

    const apis = (apisR.data.assets || []).map(api => ({
      id:           api.id,
      name:         api.assetId,
      version:      api.assetVersion,
      status:       api.status,
      technology:   api.technology,   // mule4 | mule3 | flexGateway
      endpoint:     api.endpoint?.uri,
      policies:     (api.policies || []).map(p => p.template?.assetId),
      autodiscovery: api.autodiscoveryInstanceName,
    }));

    res.json({ apis, total: apis.length });
  } catch (e) {
    res.status(502).json({ error: e.response?.data?.message || e.message });
  }
});

// ─────────────────────────────────────────────
// STEP 7 — AI: Generate HLD + LLD
// ─────────────────────────────────────────────
app.post('/api/ai/hld', async (req, res) => {
  const { projects } = req.body;

  res.writeHead(200, {
    'Content-Type':  'text/event-stream',
    'Cache-Control': 'no-cache',
    'X-Accel-Buffering': 'no',
  });

  const prompt = `You are a senior Azure integration architect. Generate a High Level Design (HLD) document for migrating these MuleSoft projects to Azure Integration Services.

Projects:
${projects.map(p => `- ${p.name} (${p.tier}): ${p.flowCount} flows, connectors: [${p.connectors?.join(', ') || 'HTTP'}]`).join('\n')}

Generate a structured HLD covering:
1. EXECUTIVE SUMMARY — business drivers, scope, target state
2. AZURE ARCHITECTURE — which Azure services replace which Mule components, with justification
3. NETWORK TOPOLOGY — VNet design, subnets, private endpoints, ExpressRoute for SAP
4. SECURITY DESIGN — Managed Identity, Key Vault, Entra ID, APIM policies
5. INTEGRATION PATTERNS — sync vs async, retry strategy, DLQ handling, idempotency
6. OBSERVABILITY — App Insights, Log Analytics, alerts, correlation IDs
7. MIGRATION STRATEGY — strangler fig order, parallel run approach, cutover criteria
8. RISKS AND MITIGATIONS — top 5 risks with mitigation plan

Be specific and technical. Reference actual Azure service names and SKUs.`;

  try {
    const stream = await openai.chat.completions.create({
      model: MODEL, max_tokens: 2048, stream: true,
      messages: [
        { role: 'system', content: 'You are a senior Azure integration architect. Write technical design documents.' },
        { role: 'user', content: prompt },
      ],
    });

    for await (const chunk of stream) {
      const text = chunk.choices[0]?.delta?.content;
      if (text) res.write(`data: ${JSON.stringify({ text })}\n\n`);
    }
    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
  } catch (e) {
    res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`);
  }
  res.end();
});

app.post('/api/ai/lld', async (req, res) => {
  const { project, analysis } = req.body;

  res.writeHead(200, {
    'Content-Type':  'text/event-stream',
    'Cache-Control': 'no-cache',
    'X-Accel-Buffering': 'no',
  });

  const prompt = `Generate a Low Level Design (LLD) for migrating this MuleSoft project to Azure.

Project: ${project.name} (${project.tier})
Flows: ${analysis.flowCount}, DWL transforms: ${analysis.dwlCount}
Connectors: ${analysis.connectors?.join(', ') || 'HTTP only'}
Has Object Store: ${analysis.hasObjectStore}
Has idempotency: ${analysis.hasIdempotency}
Orchestration chains: ${analysis.orchChains || 'none'}

Generate LLD covering:
1. COMPONENT DESIGN — each Azure Function/Logic App with inputs, outputs, dependencies
2. API SPECIFICATION — endpoint list with methods, request/response schemas, error codes
3. DATA MAPPING — DataWeave field mappings with Azure equivalent, flagging complex transforms
4. ERROR HANDLING — per-error-type response codes mirroring Mule error hierarchy
5. CONFIGURATION — environment variables, Key Vault secret names, connection strings
6. TESTING APPROACH — unit tests per function, integration test scenarios, idempotency test cases
7. DEPLOYMENT STEPS — ordered deployment sequence with validation checkpoints

Be specific about variable names, secret names, and Azure resource names.`;

  try {
    const stream = await openai.chat.completions.create({
      model: MODEL, max_tokens: 2048, stream: true,
      messages: [
        { role: 'system', content: 'You are a senior Azure integration architect. Write detailed technical specifications.' },
        { role: 'user', content: prompt },
      ],
    });

    for await (const chunk of stream) {
      const text = chunk.choices[0]?.delta?.content;
      if (text) res.write(`data: ${JSON.stringify({ text })}\n\n`);
    }
    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
  } catch (e) {
    res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`);
  }
  res.end();
});

// ─────────────────────────────────────────────
// AI: Generic streaming endpoint (steps 5-6, 8-9, 12-13)
// ─────────────────────────────────────────────
app.post('/api/ai/convert', async (req, res) => {
  const { task, payload } = req.body;

  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({ error: 'OPENAI_API_KEY not set' });
  }

  res.writeHead(200, {
    'Content-Type':  'text/event-stream',
    'Cache-Control': 'no-cache',
    'X-Accel-Buffering': 'no',
  });

  const { system, prompt } = buildPrompt(task, payload);

  try {
    const stream = await openai.chat.completions.create({
      model: MODEL, max_tokens: 2048, stream: true,
      messages: [
        { role: 'system', content: system },
        { role: 'user',   content: prompt },
      ],
    });

    for await (const chunk of stream) {
      const text = chunk.choices[0]?.delta?.content;
      if (text) res.write(`data: ${JSON.stringify({ text })}\n\n`);
    }
    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
  } catch (e) {
    res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`);
  }
  res.end();
});

// ─────────────────────────────────────────────
// STEP 13 — Generate migration report
// ─────────────────────────────────────────────
app.post('/api/report', async (req, res) => {
  const { summary, projects, testResults, aiDecisions } = req.body;

  res.writeHead(200, {
    'Content-Type':  'text/event-stream',
    'Cache-Control': 'no-cache',
    'X-Accel-Buffering': 'no',
  });

  const prompt = `Generate a professional migration report for a MuleSoft to Azure Integration Services migration.

Migration summary:
- Projects migrated: ${projects?.length || 0}
- Total APIs: ${summary?.totalApis || 0}
- Total flows converted: ${summary?.totalFlows || 0}
- DataWeave transforms: ${summary?.totalDwl || 0} (${summary?.dwlManualReview || 0} need manual review)
- Test results: ${testResults?.passed || 0} passed, ${testResults?.failed || 0} failed
- Estimated cost saving: ${summary?.costSavingPct || 30}% vs MuleSoft licensing

AI architecture decisions:
${projects?.map(p => `- ${p.name}: ${aiDecisions?.[p.name]?.runtime || 'FunctionApp'}, ${aiDecisions?.[p.name]?.effortWeeks || '?'} weeks`).join('\n') || 'Not available'}

Generate a report with these sections:
1. EXECUTIVE SUMMARY (non-technical, 3-4 sentences for management)
2. MIGRATION SCOPE (what was migrated)
3. AZURE ARCHITECTURE ADOPTED (key decisions)
4. TEST RESULTS (pass/fail breakdown, any warnings)
5. COST IMPACT (estimated savings with reasoning)
6. RISKS AND OUTSTANDING ITEMS (what still needs manual attention)
7. RECOMMENDED NEXT STEPS (prioritised list)
8. SIGN-OFF CHECKLIST (items to verify before production cutover)

Write professionally. Be specific about numbers. Flag DataWeave transforms that need review.`;

  try {
    const stream = await openai.chat.completions.create({
      model: MODEL, max_tokens: 2048, stream: true,
      messages: [
        { role: 'system', content: 'You are a technical delivery manager writing a professional migration report.' },
        { role: 'user',   content: prompt },
      ],
    });

    for await (const chunk of stream) {
      const text = chunk.choices[0]?.delta?.content;
      if (text) res.write(`data: ${JSON.stringify({ text })}\n\n`);
    }
    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
  } catch (e) {
    res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`);
  }
  res.end();
});

// ─────────────────────────────────────────────
// Prompt builder (tasks: analyse, function, dwl, rbac, logicapp)
// ─────────────────────────────────────────────
function buildPrompt(task, p) {

  if (task === 'analyse') {
    return {
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

Respond in EXACTLY this format:
RUNTIME_TARGET: [FunctionApp | LogicApp | LogicAppWithFunctions | FunctionApp+ServiceBus]
REASON: [one sentence]
DWL_COMPLEXITY: [Low | Medium | High | VeryHigh]
DWL_NOTES: [one sentence]
EFFORT_WEEKS: [integer]
TOP_RISK: [one sentence]
RBAC_NEEDS: [comma-separated Azure services]
MIGRATION_ORDER: [first | middle | last]`,
    };
  }

  if (task === 'function') {
    return {
      system: 'You are an Azure Functions expert. Output ONLY Python code — no markdown fences.',
      prompt: `Write a production Azure Function HTTP trigger in Python.

Project: ${p.project} | Tier: ${p.tier}
Flow: ${p.flow_name} | ${p.http_method} ${p.http_path}
Downstream calls: ${p.downstream_calls || 'none'}
Has DataWeave: ${p.has_transform} | Has error handler: ${p.has_error_handler}
Publishes to queue: ${p.publishes || 'no'} | Has idempotency: ${p.has_idempotency}

MuleSoft flow XML:
\`\`\`xml
${(p.flow_xml || '').slice(0, 2000)}
\`\`\`

Requirements:
1. import azure.functions as func
2. Derive ACTUAL business logic from the flow XML
3. CONNECTIVITY → 503, validation → 400, ANY → 500
4. Structured JSON logging with correlation_id
5. If has_idempotency: check Azure Table Storage first
6. If publishes: send to Azure Service Bus using Managed Identity
7. Read all URLs from os.environ — never hardcode
Start with imports.`,
    };
  }

  if (task === 'dwl') {
    return {
      system: 'You are a DataWeave-to-Python expert. Output ONLY Python code — no markdown fences.',
      prompt: `Transpile this DataWeave 2.0 transform to Python precisely.

Project: ${p.project} | Transform: ${p.name}

DataWeave source:
\`\`\`
${p.source}
\`\`\`

Write transform(payload, attributes=None) that:
1. Replicates every field exactly — no shortcuts
2. None/null safety everywhere
3. map (item,idx) -> → list comprehension with enumerate
4. sum(x map ...) → sum() + comprehension
5. sizeOf() → len(), uuid() → str(uuid.uuid4()), now() → datetime.now()
6. payload.field default "x" → payload.get('field','x')
7. leftPad/trim → write helpers
8. Inline comments per DWL construct
Start with imports.`,
    };
  }

  if (task === 'rbac') {
    return {
      system: 'You are an Azure RBAC expert. Output ONLY a valid JSON array — no markdown.',
      prompt: `Generate Azure RBAC role assignments for this migrated project.

Project: ${p.project} | Tier: ${p.tier}
Connectors: ${p.connectors || 'HTTP only'}
Publishes to Service Bus: ${p.publishes_sb}
Needs Cosmos/Table (Object Store): ${p.has_object_store}
SAP connector (VNet): ${p.has_sap}
Runtime: ${p.runtime_target}

Output a JSON array. Each element:
{ "description": "...", "principalType": "ServicePrincipal",
  "principalId": "{{MANAGED_IDENTITY_OBJECT_ID}}",
  "roleDefinitionName": "exact Azure built-in role name",
  "scope": "/subscriptions/{{SUB_ID}}/resourceGroups/{{RG}}/providers/..." }

Rules: least privilege only, Managed Identity, Key Vault Secrets User always,
Monitoring Metrics Publisher always, Service Bus only if publishes, Table Storage only if Object Store.`,
    };
  }

  if (task === 'logicapp') {
    return {
      system: 'You are an Azure Logic Apps Standard expert. Output ONLY valid Logic App workflow JSON — no markdown.',
      prompt: `Generate an Azure Logic App Standard workflow for this MuleSoft process flow.

Project: ${p.project} | Flow: ${p.flow_name}
Steps in order: ${p.steps}
Each step: ${p.step_details}
Publishes to Service Bus: ${p.publishes || 'no'}
Has idempotency: ${p.has_idempotency}

Generate the workflow "definition" object with:
1. HTTP Request trigger
2. One HTTP action per step with runAfter chaining
3. Retry policy: Fixed, count 3, interval PT5S
4. Scope with Catch for error handling
5. If publishes: Service Bus action using Managed Identity
6. If idempotency: Table Storage check as first action
7. Response action with 201
Use @triggerBody() for payload, @actions('name').outputs for chaining.`,
    };
  }

  if (task === 'report_summary') {
    return {
      system: 'You are a technical delivery manager. Write concise professional summaries.',
      prompt: `Write a 3-sentence executive summary for a MuleSoft to Azure migration.

Projects: ${p.projects}
APIs migrated: ${p.api_count}
Test pass rate: ${p.pass_rate}%
Cost saving: ${p.cost_saving}%
Key risks: ${p.key_risks}

Be specific about numbers. Suitable for a CTO or VP Engineering.`,
    };
  }

  return {
    system: 'You are a helpful assistant.',
    prompt:  'Help with this migration task.',
  };
}

// ─────────────────────────────────────────────
// Serve frontend
// ─────────────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ─────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────
app.listen(PORT, () => {
  const key = process.env.OPENAI_API_KEY || '';
  console.log('\n' + '─'.repeat(52));
  console.log('  Mule2Azure — AI Migration Console');
  console.log('  Runtime : Node.js ' + process.version);
  console.log('  LLM     : OpenAI ChatGPT (' + MODEL + ')');
  console.log('  Target  : Azure Integration Services');
  console.log('─'.repeat(52));
  if (!key) {
    console.log('\n  ⚠  OPENAI_API_KEY not set');
    console.log('     export OPENAI_API_KEY=sk-...\n');
  } else {
    console.log('\n  ✓ API key: ' + key.slice(0, 8) + '...');
  }
  console.log('  ✓ http://localhost:' + PORT + '\n');
});
