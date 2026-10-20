#!/usr/bin/env node
/**
 * noindex-thin-collections.js — Hide thin collections from search engines
 *
 * Finds every collection (custom + smart) with fewer than MIN_PRODUCTS products
 * and sets Shopify's built-in `seo.hidden` metafield (number_integer = 1).
 * Shopify themes honour this metafield natively: the page gets
 * <meta name="robots" content="noindex"> and is dropped from sitemap.xml —
 * no theme edit required.
 *
 * Uses the Admin GraphQL API (cursor pagination + metafieldsSet).
 *
 * Usage:
 *   node src/noindex-thin-collections.js            # Dry run — list thin collections
 *   node src/noindex-thin-collections.js --apply    # Set seo.hidden on them
 *
 * Collections hidden by --apply are recorded in NOINDEX_STATE_FILE so there is
 * a record of exactly what this tool changed.
 */

require('dotenv').config();
const fs   = require('fs');
const path = require('path');

// ─── Config ──────────────────────────────────────────────────────────────────
const STORE        = process.env.SHOPIFY_STORE       || 'your-store.myshopify.com';
const TOKEN        = process.env.SHOPIFY_ADMIN_TOKEN;
const API_VER      = process.env.SHOPIFY_API_VERSION || '2024-10';
const MIN_PRODUCTS = parseInt(process.env.MIN_PRODUCTS || '4', 10);
const STATE_FILE   = path.resolve(process.cwd(), process.env.NOINDEX_STATE_FILE || '.noindexed-collections.json');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const args        = process.argv.slice(2);
const MODE_APPLY  = args.includes('--apply');

// ─── State (which collections this tool has hidden) ──────────────────────────
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return { noindexed_collections: [] }; }
}
function saveState(s) { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }

// ─── Shopify GraphQL ─────────────────────────────────────────────────────────
async function shopifyGraphql(query, variables = {}) {
  const res = await fetch(`https://${STORE}/admin/api/${API_VER}/graphql.json`, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const data = await res.json();
  if (!res.ok || data.errors) {
    throw new Error(`Shopify GraphQL: ${JSON.stringify(data.errors || res.status)}`);
  }
  return data.data;
}

// Covers BOTH custom and smart collections in one paginated query.
async function getCollectionsWithCounts() {
  const results = [];
  let cursor = null;
  while (true) {
    const data = await shopifyGraphql(`
      query($cursor: String) {
        collections(first: 100, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id handle title
            productsCount { count }
            ruleSet { rules { column } }
            hidden: metafield(namespace: "seo", key: "hidden") { id value }
          }
        }
      }`, { cursor });
    const conn = data.collections;
    for (const n of conn.nodes) {
      const pc = n.productsCount;
      results.push({
        gid: n.id,
        handle: n.handle,
        title: n.title,
        productCount: typeof pc === 'object' ? (pc?.count ?? 0) : (pc ?? 0),
        isSmart: !!n.ruleSet,
        alreadyHidden: n.hidden?.value === '1',
      });
    }
    if (!conn.pageInfo.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }
  return results;
}

async function setHidden(col) {
  const data = await shopifyGraphql(`
    mutation($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        userErrors { field message }
      }
    }`, {
    metafields: [{
      ownerId: col.gid,
      namespace: 'seo', key: 'hidden', type: 'number_integer', value: '1',
    }],
  });
  const errs = data.metafieldsSet?.userErrors || [];
  if (errs.length) throw new Error(`metafieldsSet: ${errs.map(e => e.message).join('; ')}`);
}

// ─── Main ────────────────────────────────────────────────────────────────────
(async () => {
  if (!TOKEN) { console.error('❌  SHOPIFY_ADMIN_TOKEN not set'); process.exit(1); }
  const mode = MODE_APPLY ? 'apply (LIVE)' : 'dry run';
  console.log(`\n🗂  Thin-collection noindex — ${STORE} — threshold < ${MIN_PRODUCTS} products — ${mode}\n`);

  const collections = await getCollectionsWithCounts();
  const state = loadState();

  const thin = collections.filter(c => c.productCount < MIN_PRODUCTS);
  console.log(`Scanned ${collections.length} collections; ${thin.length} are thin:\n`);

  let applied = 0, skipped = 0;
  for (const col of thin) {
    const label = `${col.handle.padEnd(45)} ${String(col.productCount).padStart(3)} products${col.isSmart ? ' (smart)' : ''}`;
    if (col.alreadyHidden) {
      console.log(`  ⏭️  ${label} — already hidden`);
      skipped++;
      continue;
    }
    if (!MODE_APPLY) {
      console.log(`  📋 ${label} — would hide`);
      continue;
    }
    await setHidden(col);
    if (!state.noindexed_collections.includes(col.handle)) state.noindexed_collections.push(col.handle);
    console.log(`  🚫 ${label} — hidden`);
    applied++;
    await sleep(300);
  }

  if (MODE_APPLY) saveState(state);
  console.log(`\n${MODE_APPLY ? `✅  Hidden ${applied}` : `Would hide ${thin.length - skipped}`}, already hidden ${skipped}.`);
  if (!MODE_APPLY) console.log('   Run with --apply to make changes.');
  console.log('');
})().catch(err => {
  console.error(`\n❌ Fatal error: ${err.message}`);
  process.exit(1);
});
