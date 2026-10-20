#!/usr/bin/env node
/**
 * shopify-redirects.js — Shopify 301 Redirect Manager for Cannibalized Pages
 *
 * Creates 301 redirects in Shopify for cannibalized/duplicate pages identified
 * during an SEO cannibalization triage (GSC position + impression analysis).
 *
 * Multiple URLs were competing for the same keywords, splitting ranking signals.
 * This script consolidates link equity by redirecting weaker duplicates to their
 * canonical versions via the Shopify Admin REST API.
 *
 * ─────────────────────────────────────────────────────────────
 * USAGE
 * ─────────────────────────────────────────────────────────────
 *   node shopify-redirects.js                # Preview all redirects (dry run)
 *   node shopify-redirects.js --apply        # Create redirects in Shopify
 *   node shopify-redirects.js --list         # List all existing Shopify redirects
 *   node shopify-redirects.js --verify       # HTTP-check each redirect (301?)
 *   node shopify-redirects.js --delete-dupes # Remove stale redirects not in our map
 *
 * The redirect map lives in a JSON file (REDIRECTS_FILE, default
 * ./redirects.json) so the script can be reused without code changes:
 *   [{ "path": "/old", "target": "/new", "reason": "why" }, ...]
 *
 * Noindex handling for pages that should stay live but out of the index
 * (tag archives, pagination, search, cart) lives in theme/seo-noindex.liquid.
 */

require('dotenv').config();
const fs = require('fs');

const _fetch = globalThis.fetch; // Node 18+ built-in fetch

// ─── Config ──────────────────────────────────────────────────────────────────
const path     = require('path');
const STORE    = process.env.SHOPIFY_STORE       || 'your-store.myshopify.com';
const TOKEN    = process.env.SHOPIFY_ADMIN_TOKEN;
const API_VER  = process.env.SHOPIFY_API_VERSION || '2024-10';
const REST     = `https://${STORE}/admin/api/${API_VER}`;
const SITE_URL = (process.env.SITE_URL || 'https://example.com').replace(/\/$/, '');
const REDIRECTS_FILE = path.resolve(process.cwd(), process.env.REDIRECTS_FILE || 'redirects.json');
const HEADERS  = { 'X-Shopify-Access-Token': TOKEN, 'Content-Type': 'application/json' };

// Rate limit: Shopify REST API allows 2 req/sec for most plans. 600ms is safe.
const RATE_LIMIT_MS = 600;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── CLI Flags ───────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const MODE_APPLY       = args.includes('--apply');
const MODE_LIST        = args.includes('--list');
const MODE_VERIFY      = args.includes('--verify');
const MODE_DELETE_DUPES = args.includes('--delete-dupes');
// Default: dry-run preview
const MODE_PREVIEW     = !MODE_APPLY && !MODE_LIST && !MODE_VERIFY && !MODE_DELETE_DUPES;

// ─── ANSI colors ─────────────────────────────────────────────────────────────
const c = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  red:    '\x1b[31m',
  cyan:   '\x1b[36m',
  magenta:'\x1b[35m',
  blue:   '\x1b[34m',
};

// ─────────────────────────────────────────────────────────────
// REDIRECT MAP — Cannibalized pages → canonical targets
// ─────────────────────────────────────────────────────────────
// Loaded from REDIRECTS_FILE. Each redirect consolidates ranking signals from
// a weaker duplicate into the canonical page that should rank for the keyword.
function loadRedirectMap(file) {
  if (!fs.existsSync(file)) {
    console.error(`\n  ${c.red}❌ Redirect map not found: ${file}${c.reset}`);
    console.error(`  ${c.dim}Copy redirects.example.json to redirects.json, or set REDIRECTS_FILE.${c.reset}\n`);
    process.exit(1);
  }
  const map = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(map)) throw new Error('Redirect map must be a JSON array');
  for (const [i, r] of map.entries()) {
    if (!r.path?.startsWith('/') || !r.target) throw new Error(`Entry ${i}: needs "path" (starting with /) and "target"`);
    if (r.path.toLowerCase() === r.target.toLowerCase()) throw new Error(`Entry ${i}: path and target are identical`);
  }
  return map;
}
const REDIRECT_MAP = loadRedirectMap(REDIRECTS_FILE);

// ─────────────────────────────────────────────────────────────
// Shopify API helpers
// ─────────────────────────────────────────────────────────────

/**
 * Fetch ALL existing redirects from Shopify (paginated, up to 250 per page).
 */
async function fetchAllRedirects() {
  const all = [];
  let url = `${REST}/redirects.json?limit=250`;

  while (url) {
    const res = await _fetch(url, { headers: HEADERS });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Failed to fetch redirects: ${res.status} ${text}`);
    }
    const data = await res.json();
    all.push(...(data.redirects || []));

    // Pagination: Shopify sends Link header with rel="next"
    const linkHeader = res.headers.get('link') || '';
    const nextMatch = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
    url = nextMatch ? nextMatch[1] : null;

    if (url) await sleep(300);
  }

  return all;
}

/**
 * Create a single redirect in Shopify.
 */
async function createRedirect(path, target) {
  const res = await _fetch(`${REST}/redirects.json`, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify({ redirect: { path, target } }),
  });
  const data = await res.json();
  if (!res.ok || data.errors) {
    return { ok: false, errors: data.errors || `HTTP ${res.status}` };
  }
  return { ok: true, redirect: data.redirect };
}

/**
 * Delete a redirect by ID.
 */
async function deleteRedirect(id) {
  const res = await _fetch(`${REST}/redirects/${id}.json`, {
    method: 'DELETE',
    headers: HEADERS,
  });
  return res.ok || res.status === 404; // 404 = already gone
}

/**
 * Verify a redirect by sending an HTTP request to the live site.
 * Returns { status, location, ok }.
 */
async function verifyRedirect(path) {
  try {
    const res = await _fetch(`${SITE_URL}${path}`, { redirect: 'manual' });
    const location = res.headers.get('location') || '';
    return {
      status: res.status,
      location,
      ok: res.status === 301 || res.status === 302,
    };
  } catch (e) {
    return { status: 0, location: '', ok: false, error: e.message };
  }
}

// ─────────────────────────────────────────────────────────────
// CLI modes
// ─────────────────────────────────────────────────────────────

/**
 * Preview mode (dry run) — show what would be created.
 */
async function runPreview() {
  console.log(`\n${c.bold}${c.cyan}📝  Redirect Preview (DRY RUN)${c.reset}`);
  console.log(`${c.dim}   Run with --apply to create these redirects in Shopify${c.reset}\n`);

  // Fetch existing to flag duplicates
  console.log(`  Fetching existing redirects from Shopify...`);
  const existing = await fetchAllRedirects();
  const existingPaths = new Set(existing.map(r => r.path.toLowerCase()));
  console.log(`  Found ${existing.length} existing redirects.\n`);

  let wouldCreate = 0, alreadyExists = 0;

  const tagOf = p => p.startsWith('/products/') ? 'PRODUCT'
                  : p.startsWith('/blogs/') ? 'BLOG'
                  : p.startsWith('/collections/') ? 'COLLECTION' : 'OTHER';
  const ordered = [...REDIRECT_MAP].sort((a, b) => tagOf(a.path).localeCompare(tagOf(b.path)));
  let currentTag = null;

  for (let i = 0; i < ordered.length; i++) {
    const r = ordered[i];
    const exists = existingPaths.has(r.path.toLowerCase());
    const tag = tagOf(r.path);

    if (tag !== currentTag) {
      currentTag = tag;
      const n = ordered.filter(x => tagOf(x.path) === tag).length;
      console.log(`\n  ${c.bold}${tag} REDIRECTS (${n}):${c.reset}`);
      console.log(`  ${'─'.repeat(70)}`);
    }

    if (exists) {
      console.log(`  ${c.yellow}⏭  SKIP${c.reset} [${tag}] Already exists`);
      console.log(`     ${c.dim}${r.path}${c.reset}`);
      alreadyExists++;
    } else {
      console.log(`  ${c.green}➕ CREATE${c.reset} [${tag}]`);
      console.log(`     ${c.dim}FROM: ${r.path}${c.reset}`);
      console.log(`     ${c.dim}  TO: ${r.target}${c.reset}`);
      wouldCreate++;
    }
    if (r.reason) console.log(`     ${c.dim}Reason: ${r.reason}${c.reset}`);
    console.log();
  }

  console.log(`  ${'─'.repeat(70)}`);
  console.log(`  ${c.bold}Summary:${c.reset}`);
  console.log(`    ➕ Would create:    ${c.green}${wouldCreate}${c.reset}`);
  console.log(`    ⏭  Already exist:   ${c.yellow}${alreadyExists}${c.reset}`);
  console.log(`    📊 Total in map:    ${REDIRECT_MAP.length}`);
  console.log(`\n  ${c.cyan}Run with --apply to execute.${c.reset}\n`);
}

/**
 * Apply mode — create redirects in Shopify.
 */
async function runApply() {
  console.log(`\n${c.bold}${c.green}🚀  Creating Redirects in Shopify${c.reset}`);
  console.log(`${c.dim}   Store: ${STORE} | API: ${API_VER}${c.reset}\n`);

  // Fetch existing to skip duplicates
  console.log(`  Fetching existing redirects...`);
  const existing = await fetchAllRedirects();
  const existingPaths = new Set(existing.map(r => r.path.toLowerCase()));
  console.log(`  Found ${existing.length} existing redirects.\n`);

  let created = 0, skipped = 0, failed = 0;
  const results = [];

  for (let i = 0; i < REDIRECT_MAP.length; i++) {
    const r = REDIRECT_MAP[i];
    const num = `[${i + 1}/${REDIRECT_MAP.length}]`;

    if (existingPaths.has(r.path.toLowerCase())) {
      console.log(`  ${c.yellow}⏭  ${num} SKIP${c.reset} — already exists: ${c.dim}${r.path.slice(0, 60)}${c.reset}`);
      skipped++;
      results.push({ ...r, status: 'skipped' });
      continue;
    }

    const { ok, errors, redirect } = await createRedirect(r.path, r.target);

    if (ok) {
      console.log(`  ${c.green}✅ ${num} CREATED${c.reset} — ${c.dim}${r.path.slice(0, 60)}${c.reset}`);
      console.log(`     ${c.dim}→ ${r.target.slice(0, 60)}${c.reset}`);
      created++;
      results.push({ ...r, status: 'created', id: redirect?.id });
    } else {
      // Check if the error is "path has already been taken" (still a success)
      const errStr = JSON.stringify(errors);
      if (errStr.includes('taken') || errStr.includes('already')) {
        console.log(`  ${c.yellow}⏭  ${num} SKIP${c.reset} — path taken: ${c.dim}${r.path.slice(0, 60)}${c.reset}`);
        skipped++;
        results.push({ ...r, status: 'skipped' });
      } else {
        console.log(`  ${c.red}❌ ${num} FAILED${c.reset} — ${c.dim}${r.path.slice(0, 60)}${c.reset}`);
        console.log(`     ${c.red}Error: ${errStr}${c.reset}`);
        failed++;
        results.push({ ...r, status: 'failed', error: errStr });
      }
    }

    await sleep(RATE_LIMIT_MS);
  }

  // Summary
  console.log(`\n  ${'═'.repeat(60)}`);
  console.log(`  ${c.bold}RESULTS SUMMARY${c.reset}`);
  console.log(`  ${'═'.repeat(60)}`);
  console.log(`    ${c.green}✅ Created:${c.reset}    ${created}`);
  console.log(`    ${c.yellow}⏭  Skipped:${c.reset}    ${skipped}`);
  console.log(`    ${c.red}❌ Failed:${c.reset}     ${failed}`);
  console.log(`    📊 Total:       ${REDIRECT_MAP.length}`);
  console.log(`  ${'═'.repeat(60)}\n`);

  if (failed > 0) {
    console.log(`  ${c.red}${c.bold}Failed redirects:${c.reset}`);
    results.filter(r => r.status === 'failed').forEach(r => {
      console.log(`    ❌ ${r.path}`);
      console.log(`      ${c.dim}Error: ${r.error}${c.reset}`);
    });
    console.log();
  }

  if (created > 0) {
    console.log(`  ${c.green}✅ ${created} redirect(s) created successfully.${c.reset}`);
    console.log(`  ${c.dim}Google will discover these within 1-2 crawl cycles.${c.reset}`);
    console.log(`  ${c.dim}Run --verify in 24h to confirm they're working.${c.reset}\n`);
  }
}

/**
 * List mode — show all existing redirects from Shopify.
 */
async function runList() {
  console.log(`\n${c.bold}${c.cyan}📋  Existing Shopify Redirects${c.reset}`);
  console.log(`${c.dim}   Store: ${STORE}${c.reset}\n`);

  const redirects = await fetchAllRedirects();

  if (redirects.length === 0) {
    console.log(`  ${c.yellow}No redirects found.${c.reset}\n`);
    return;
  }

  // Group by type
  const blogRedirects = redirects.filter(r => r.path.includes('/blogs/'));
  const productRedirects = redirects.filter(r => r.path.includes('/products/'));
  const otherRedirects = redirects.filter(r => !r.path.includes('/blogs/') && !r.path.includes('/products/'));

  const printGroup = (label, items) => {
    if (items.length === 0) return;
    console.log(`  ${c.bold}${label} (${items.length}):${c.reset}`);
    items.forEach(r => {
      const inMap = REDIRECT_MAP.some(m => m.path.toLowerCase() === r.path.toLowerCase());
      const badge = inMap ? `${c.green}[IN MAP]${c.reset}` : `${c.dim}[OTHER]${c.reset}`;
      console.log(`    ${badge} ${c.dim}id:${r.id}${c.reset}`);
      console.log(`      ${r.path}`);
      console.log(`      ${c.dim}→ ${r.target}${c.reset}`);
    });
    console.log();
  };

  printGroup('Blog Redirects', blogRedirects);
  printGroup('Product Redirects', productRedirects);
  printGroup('Other Redirects', otherRedirects);

  console.log(`  ${'─'.repeat(50)}`);
  console.log(`  ${c.bold}Total: ${redirects.length} redirects${c.reset}`);
  const mapPaths = new Set(REDIRECT_MAP.map(r => r.path.toLowerCase()));
  const inMap = redirects.filter(r => mapPaths.has(r.path.toLowerCase())).length;
  console.log(`  ${c.green}In our map: ${inMap}${c.reset} | ${c.dim}Other: ${redirects.length - inMap}${c.reset}\n`);
}

/**
 * Verify mode — HTTP-check each redirect on the live site.
 */
async function runVerify() {
  console.log(`\n${c.bold}${c.magenta}🔍  Verifying Redirects on Live Site${c.reset}`);
  console.log(`${c.dim}   Testing: ${SITE_URL}${c.reset}\n`);

  let working = 0, broken = 0, other = 0;

  for (let i = 0; i < REDIRECT_MAP.length; i++) {
    const r = REDIRECT_MAP[i];
    const num = `[${i + 1}/${REDIRECT_MAP.length}]`;

    const result = await verifyRedirect(r.path);

    if (result.ok) {
      // Check if it redirects to the expected target
      const expectedFull = `${SITE_URL}${r.target}`;
      const matchesTarget = result.location === r.target ||
                            result.location === expectedFull ||
                            result.location.endsWith(r.target);
      if (matchesTarget) {
        console.log(`  ${c.green}✅ ${num} 301 OK${c.reset} ${c.dim}${r.path.slice(0, 55)}${c.reset}`);
        working++;
      } else {
        console.log(`  ${c.yellow}⚠️  ${num} ${result.status} WRONG TARGET${c.reset} ${c.dim}${r.path.slice(0, 55)}${c.reset}`);
        console.log(`     Expected: ${c.dim}${r.target}${c.reset}`);
        console.log(`     Got:      ${c.dim}${result.location}${c.reset}`);
        other++;
      }
    } else if (result.status === 404) {
      console.log(`  ${c.red}❌ ${num} 404 NOT FOUND${c.reset} ${c.dim}${r.path.slice(0, 55)}${c.reset}`);
      console.log(`     ${c.dim}Redirect not set up yet. Run --apply first.${c.reset}`);
      broken++;
    } else if (result.status === 200) {
      console.log(`  ${c.yellow}⚠️  ${num} 200 NO REDIRECT${c.reset} ${c.dim}${r.path.slice(0, 55)}${c.reset}`);
      console.log(`     ${c.dim}Page loads normally — redirect not active or page still exists.${c.reset}`);
      other++;
    } else {
      console.log(`  ${c.red}❓ ${num} HTTP ${result.status}${c.reset} ${c.dim}${r.path.slice(0, 55)}${c.reset}`);
      if (result.error) console.log(`     ${c.dim}Error: ${result.error}${c.reset}`);
      broken++;
    }

    await sleep(300); // gentle on the server
  }

  console.log(`\n  ${'═'.repeat(50)}`);
  console.log(`  ${c.bold}Verification Summary${c.reset}`);
  console.log(`  ${'═'.repeat(50)}`);
  console.log(`    ${c.green}✅ Working:${c.reset}    ${working}`);
  console.log(`    ${c.red}❌ Broken:${c.reset}     ${broken}`);
  console.log(`    ${c.yellow}⚠️  Other:${c.reset}      ${other}`);
  console.log(`    📊 Total:       ${REDIRECT_MAP.length}`);
  console.log(`  ${'═'.repeat(50)}\n`);
}

/**
 * Delete-dupes mode — remove redirects not in our map.
 */
async function runDeleteDupes() {
  console.log(`\n${c.bold}${c.red}🧹  Cleaning Stale Redirects${c.reset}`);
  console.log(`${c.dim}   Removes any Shopify redirect whose path is NOT in our redirect map.${c.reset}\n`);

  const existing = await fetchAllRedirects();
  const mapPaths = new Set(REDIRECT_MAP.map(r => r.path.toLowerCase()));

  const stale = existing.filter(r => !mapPaths.has(r.path.toLowerCase()));
  const kept  = existing.filter(r => mapPaths.has(r.path.toLowerCase()));

  console.log(`  Total existing: ${existing.length}`);
  console.log(`  ${c.green}In our map (keep): ${kept.length}${c.reset}`);
  console.log(`  ${c.red}NOT in map (stale): ${stale.length}${c.reset}\n`);

  if (stale.length === 0) {
    console.log(`  ${c.green}✅ No stale redirects to remove.${c.reset}\n`);
    return;
  }

  // Show what will be deleted
  console.log(`  ${c.bold}Stale redirects to delete:${c.reset}`);
  stale.forEach((r, i) => {
    console.log(`    ${c.red}${i + 1}.${c.reset} ${c.dim}id:${r.id}${c.reset} ${r.path}`);
    console.log(`       ${c.dim}→ ${r.target}${c.reset}`);
  });

  if (!MODE_APPLY && !args.includes('--confirm')) {
    console.log(`\n  ${c.yellow}⚠️  Dry run — add --confirm to actually delete these.${c.reset}`);
    console.log(`  ${c.dim}   Example: node shopify-redirects.js --delete-dupes --confirm${c.reset}\n`);
    return;
  }

  console.log(`\n  Deleting ${stale.length} stale redirects...\n`);

  let deleted = 0, errors = 0;
  for (let i = 0; i < stale.length; i++) {
    const r = stale[i];
    const ok = await deleteRedirect(r.id);
    if (ok) {
      console.log(`  ${c.green}🗑️  ${c.reset}Deleted id:${r.id} ${c.dim}${r.path.slice(0, 50)}${c.reset}`);
      deleted++;
    } else {
      console.log(`  ${c.red}❌${c.reset} Failed to delete id:${r.id}`);
      errors++;
    }
    await sleep(RATE_LIMIT_MS);
  }

  console.log(`\n  ${c.bold}Cleanup Summary:${c.reset}`);
  console.log(`    ${c.green}🗑️  Deleted:${c.reset} ${deleted}`);
  if (errors) console.log(`    ${c.red}❌ Errors:${c.reset}  ${errors}`);
  console.log();
}

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────
(async () => {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ${c.bold}🔁 Shopify 301 Redirect Manager — ${SITE_URL}${c.reset}`);
  console.log(`${'═'.repeat(60)}`);
  console.log(`  Store:      ${c.cyan}${STORE}${c.reset}`);
  console.log(`  API:        ${API_VER}`);
  console.log(`  Redirects:  ${REDIRECT_MAP.length} defined in ${path.basename(REDIRECTS_FILE)}`);
  console.log(`  Mode:       ${c.bold}${MODE_APPLY ? c.green + '--apply (LIVE)' :
                                           MODE_LIST ? c.cyan + '--list' :
                                           MODE_VERIFY ? c.magenta + '--verify' :
                                           MODE_DELETE_DUPES ? c.red + '--delete-dupes' :
                                           c.yellow + 'preview (dry run)'}${c.reset}`);

  if (!TOKEN) {
    console.error(`\n  ${c.red}❌ SHOPIFY_ADMIN_TOKEN not set in .env${c.reset}`);
    console.error(`  ${c.dim}Add SHOPIFY_ADMIN_TOKEN=shpat_... to your .env file${c.reset}\n`);
    process.exit(1);
  }

  try {
    if (MODE_LIST)              await runList();
    else if (MODE_VERIFY)       await runVerify();
    else if (MODE_DELETE_DUPES) await runDeleteDupes();
    else if (MODE_APPLY)        await runApply();
    else                        await runPreview();
  } catch (err) {
    console.error(`\n  ${c.red}❌ Fatal error: ${err.message}${c.reset}`);
    if (err.stack) console.error(`  ${c.dim}${err.stack.split('\n').slice(1, 4).join('\n  ')}${c.reset}`);
    process.exit(1);
  }
})();
