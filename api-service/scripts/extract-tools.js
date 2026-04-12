#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INC_PATH = resolve(__dirname, '../../libs/surfaces/mcp_http/tools_json.inc');
const OUT_PATH = resolve(__dirname, '../src/schemas/mcp-tools.json');

const src = readFileSync(INC_PATH, 'utf8');

// tools_json.inc is wrapped in R"mcp( ... )mcp"
const match = src.match(/R"mcp\(([\s\S]*?)\)mcp"/);
if (!match) {
  console.error('Could not find R"mcp(...)mcp" block in', INC_PATH);
  process.exit(1);
}

const json = match[1].trim();
const parsed = JSON.parse(json);

if (!parsed.tools || !Array.isArray(parsed.tools)) {
  console.error('Expected { tools: [...] } structure');
  process.exit(1);
}

writeFileSync(OUT_PATH, JSON.stringify(parsed, null, 2) + '\n');
console.log(`Extracted ${parsed.tools.length} tools to ${OUT_PATH}`);
