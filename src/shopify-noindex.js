#!/usr/bin/env node
/**
 * shopify-noindex.js — Add noindex meta tags to dead-weight blog posts
 *
 * Uses Shopify REST API to add a "seo.noindex" metafield to identified blog
 * articles that waste crawl budget (0 clicks, off-topic, or dead-end rankings).
 *
 * The Shopify Liquid theme must check this metafield and output:
 *   <meta name="robots" content="noindex, follow">
 * when the metafield is truthy. See theme/seo-noindex.liquid.
 *
 * Target article handles are read from NOINDEX_FILE (default ./noindex.json):
 *   ["article-handle-one", "article-handle-two", ...]
 *
 * Usage:
 *   node src/shopify-noindex.js                # Dry run — preview what would change
 *   node src/shopify-noindex.js --apply        # Actually set noindex metafields
 *   node src/shopify-noindex.js --list         # List articles that already have noindex
 *   node src/shopify-noindex.js --remove-all   # Remove all noindex metafields (revert)
 */

require('dotenv').config();
const fs   = require('fs');
const path = require('path');

const _fetch = globalThis.fetch; // Node 18+ built-in fetch

// ─── Config ─────────────────────────────────────────────────────────────────
const STORE   = process.env.SHOPIFY_STORE       || 'your-store.myshopify.com';
const TOKEN   = process.env.SHOPIFY_ADMIN_TOKEN;
const BLOG_ID = process.env.SHOPIFY_BLOG_ID     || '';
const API_VER = process.env.SHOPIFY_API_VERSION || '2024-10';
const REST    = `https://${STORE}/admin/api/${API_VER}`;
const HEADERS = { 'X-Shopify-Access-Token': TOKEN, 'Content-Type': 'application/json' };
const NOINDEX_FILE = path.resolve(process.cwd(), process.env.NOINDEX_FILE || 'noindex.json');
const sleep   = ms => new Promise(r => setTimeout(r, ms));

const args         = process.argv.slice(2);
const MODE_APPLY   = args.includes('--apply');
const MODE_LIST    = args.includes('--list');
const MODE_REMOVE  = args.includes('--remove-all');
const MODE_PREVIEW = !MODE_APPLY && !MODE_LIST && !MODE_REMOVE;

// ─── NOINDEX TARGET LIST ────────────────────────────────────────────────────
// Criteria used in production: 0 clicks, off-topic content, or dead-end
// rankings (position 30+) with no realistic path to page one.
function loadNoindexSlugs(file) {
  if (!fs.existsSync(file)) {
    console.error(`❌ Noindex list not found: ${file}`);
    console.error('   Copy noindex.example.json to noindex.json, or set NOINDEX_FILE.');
    process.exit(1);
  }
  const list = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(list) || !list.every(s => typeof s === 'string')) {
    throw new Error('Noindex list must be a JSON array of article handles');
  }
  return list;
}
const NOINDEX_SLUGS = loadNoindexSlugs(NOINDEX_FILE);

// ─── Shopify API helpers ────────────────────────────────────────────────────

/** Fetch ALL blog articles (paginated) to find article IDs by handle */
async function fetchAllArticles() {
  const all = [];
  let url = `${REST}/blogs/${BLOG_ID}/articles.json?limit=250&fields=id,handle,title,published_at`;
  while (url) {
    const res = await _fetch(url, { headers: HEADERS });
    if (!res.ok) throw new Error(`GET articles: ${res.status} ${await res.text()}`);
    const data = await res.json();
    all.push(...(data.articles || []));
    const linkHeader = res.headers.get('link') || '';
    const nextMatch = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
    url = nextMatch ? nextMatch[1] : null;
    if (url) await sleep(300);
  }
  return all;
}

/** Get metafields for an article */
async function getArticleMetafields(articleId) {
  const res = await _fetch(
    `${REST}/blogs/${BLOG_ID}/articles/${articleId}/metafields.json`,
    { headers: HEADERS }
  );
  if (!res.ok) throw new Error(`GET metafields ${articleId}: ${res.status}`);
  const data = await res.json();
  return data.metafields || [];
}

/** Set noindex metafield on an article */
async function setNoindexMetafield(articleId) {
  const res = await _fetch(
    `${REST}/blogs/${BLOG_ID}/articles/${articleId}/metafields.json`,
    {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify({
        metafield: {
          namespace: 'seo',
          key: 'noindex',
          value: 'true',
          type: 'single_line_text_field',
        },
      }),
    }
  );
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`POST metafield ${articleId}: ${res.status} — ${txt.slice(0, 200)}`);
  }
  return res.json();
}

/** Delete a metafield by ID */
async function deleteMetafield(metafieldId) {
  const res = await _fetch(`${REST}/metafields/${metafieldId}.json`, {
    method: 'DELETE',
    headers: HEADERS,
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`DELETE metafield ${metafieldId}: ${res.status}`);
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────
(async () => {
  console.log(`\n🚫  Shopify Noindex Manager — ${STORE}\n`);
  if (!TOKEN) { console.error('❌ SHOPIFY_ADMIN_TOKEN not set'); process.exit(1); }
  if (!BLOG_ID) { console.error('❌ SHOPIFY_BLOG_ID not set'); process.exit(1); }

  // Fetch all articles to match slugs → IDs
  console.log('  📚 Fetching all blog articles...');
  const articles = await fetchAllArticles();
  console.log(`  Found ${articles.length} articles\n`);

  // Build handle → article map
  const byHandle = {};
  for (const a of articles) byHandle[a.handle] = a;

  if (MODE_LIST) {
    // ── List mode: show which articles already have noindex ──
    console.log('  Checking noindex metafields...\n');
    let count = 0;
    for (const slug of NOINDEX_SLUGS) {
      const article = byHandle[slug];
      if (!article) { console.log(`  ⚠️  Not found: ${slug}`); continue; }
      const mfs = await getArticleMetafields(article.id);
      const noindex = mfs.find(m => m.namespace === 'seo' && m.key === 'noindex');
      if (noindex) {
        console.log(`  ✅ NOINDEX: ${article.title.slice(0, 60)} (id: ${article.id})`);
        count++;
      } else {
        console.log(`  ❌ No tag:  ${article.title.slice(0, 60)} (id: ${article.id})`);
      }
      await sleep(500);
    }
    console.log(`\n  Total with noindex: ${count}/${NOINDEX_SLUGS.length}`);
    return;
  }

  if (MODE_REMOVE) {
    // ── Remove mode: delete all noindex metafields we set ──
    console.log('  Removing noindex metafields...\n');
    let removed = 0;
    for (const slug of NOINDEX_SLUGS) {
      const article = byHandle[slug];
      if (!article) continue;
      const mfs = await getArticleMetafields(article.id);
      const noindex = mfs.find(m => m.namespace === 'seo' && m.key === 'noindex');
      if (noindex) {
        await deleteMetafield(noindex.id);
        console.log(`  🗑️  Removed: ${article.title.slice(0, 60)}`);
        removed++;
      }
      await sleep(500);
    }
    console.log(`\n  Removed ${removed} noindex metafields.`);
    return;
  }

  // ── Preview / Apply mode ──
  if (MODE_PREVIEW) console.log('  ⚠️  DRY RUN — no changes will be made\n');
  if (MODE_APPLY) console.log('  🔴 LIVE MODE — setting noindex metafields in Shopify\n');

  let applied = 0, skipped = 0, notFound = 0, errors = 0;

  for (const slug of NOINDEX_SLUGS) {
    const article = byHandle[slug];
    if (!article) {
      console.log(`  ⚠️  Not found: ${slug}`);
      notFound++;
      continue;
    }

    // Check if already has noindex
    const mfs = await getArticleMetafields(article.id);
    const existing = mfs.find(m => m.namespace === 'seo' && m.key === 'noindex');
    if (existing) {
      console.log(`  ⏭️  Already noindex: ${article.title.slice(0, 55)}`);
      skipped++;
      await sleep(300);
      continue;
    }

    if (MODE_PREVIEW) {
      console.log(`  📋 Would noindex: ${article.title.slice(0, 55)} (${article.id})`);
      applied++;
      continue;
    }

    try {
      await setNoindexMetafield(article.id);
      console.log(`  ✅ Noindexed: ${article.title.slice(0, 55)} (${article.id})`);
      applied++;
      await sleep(600);
    } catch (e) {
      console.error(`  ❌ Error: ${e.message}`);
      errors++;
    }
  }

  console.log('\n' + '─'.repeat(50));
  console.log(`  ✅ ${MODE_PREVIEW ? 'Would apply' : 'Applied'}:   ${applied}`);
  console.log(`  ⏭️  Already set:  ${skipped}`);
  console.log(`  ⚠️  Not found:    ${notFound}`);
  console.log(`  ❌ Errors:       ${errors}`);

  if (MODE_PREVIEW) {
    console.log('\n  To apply: node src/shopify-noindex.js --apply');
  }
  console.log('\n  Reminder: the theme must render the metafield — see theme/seo-noindex.liquid\n');
})();
