import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

let cachedCatalog = null;

function loadCatalog() {
  if (cachedCatalog) return cachedCatalog;
  const path = resolve(__dirname, '../schemas/mcp-tools.json');
  const raw = readFileSync(path, 'utf8');
  const parsed = JSON.parse(raw);
  const tools = parsed.tools.map((t) => ({
    name: t.name,
    category: t.name.includes('/') ? t.name.split('/')[0] : 'misc',
    description: t.description || '',
    input_schema: t.inputSchema || {},
  }));
  const categories = Array.from(new Set(tools.map(t => t.category)));
  cachedCatalog = { tools, categories };
  return cachedCatalog;
}

export async function toolRoutes(app) {
  app.get('/tools', async () => loadCatalog());
}
