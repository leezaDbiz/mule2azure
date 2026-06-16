# Mule2Azure v2 — 13-step Migration Console

Node.js server + single-page frontend covering the full migration workflow.

## Setup

```bash
npm install
export OPENAI_API_KEY=sk-...
node server.js
# open http://localhost:7433
```

## The 13 steps

### Source & discovery
1. **Connect GitHub** — real GitHub API, lists org repos, filters likely Mule projects
2. **Connect Anypoint** — real Anypoint Platform auth (Connected App or username/password)
3. **Select environment** — lists DEV/UAT/PROD environments from your Anypoint org
4. **Discover deployments** — pulls Runtime Manager apps + API Manager APIs live

### Analysis
5. **Parse applications** — upload Mule XML files, real parser (flows, DWL, connectors, SAP, Object Store)
6. **Blueprint** — dependency diagram, cost impact (30% saving), risk register

### Design
7. **HLD & LLD** — AI generates High Level Design + per-project Low Level Design
8. **Review mappings** — Azure service mapping table, override runtime decisions per project

### Generation
9. **Generate artifacts** — AI generates Functions, DWL→Python, RBAC, Logic Apps, Bicep

### Deployment
10. **Connect Azure** — save subscription/resource group/region config
11. **Deploy** — deployment commands + artifact download

### Validation & report
12. **Validate** — HTTP tests against deployed endpoints
13. **Migration report** — AI generates executive + technical report

## API endpoints

| Method | Path | Purpose |
|--------|------|---------|
| POST | /api/github/repos | List GitHub org repos |
| POST | /api/github/tree | Get repo file tree |
| POST | /api/github/file | Fetch file content |
| POST | /api/anypoint/auth | Anypoint OAuth (Connected App or user/pass) |
| POST | /api/anypoint/environments | List org environments |
| POST | /api/anypoint/runtime-manager | Discover deployed apps |
| POST | /api/anypoint/api-manager | Discover managed APIs |
| POST | /api/ai/hld | Stream HLD generation |
| POST | /api/ai/lld | Stream LLD generation |
| POST | /api/ai/convert | Stream any AI task (analyse/function/dwl/rbac/logicapp) |
| POST | /api/report | Stream migration report |
