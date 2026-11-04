const fs = require('fs');
const path = require('path');
const { request } = require('./utils/httpClient');
const adapters = require('./adapters');

const CATALOG_URL = 'https://openrouter.ai/api/v1/models';
const CACHE_FILE = 'model-cache.json';
const CACHE_TTL = 24 * 60 * 60 * 1000;

class ModelCatalog {
  constructor() {
    this.cachePath = null;
    this.cache = null;
    this.loading = null;
  }

  init(userDataDir) {
    this.cachePath = path.join(userDataDir, CACHE_FILE);
    this.cache = this.readCache();
  }

  readCache() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.cachePath, 'utf8'));
      if (raw && raw.fetchedAt && Date.now() - raw.fetchedAt < CACHE_TTL && raw.bySite) {
        return raw;
      }
      return null;
    } catch (e) {
      return null;
    }
  }

  writeCache(data) {
    try {
      fs.writeFileSync(this.cachePath, JSON.stringify({ fetchedAt: Date.now(), bySite: data }, null, 2), 'utf8');
    } catch (e) {}
  }

  async refresh() {
    if (this.loading) return this.loading;
    this.loading = (async () => {
      try {
        const res = await request({ url: CATALOG_URL, method: 'GET', headers: { Accept: 'application/json' } });
        if (res.statusCode !== 200) throw new Error(`HTTP ${res.statusCode}`);
        const j = JSON.parse(res.body.toString('utf8'));
        const list = Array.isArray(j.data) ? j.data : [];
        const bySite = {};
        for (const a of adapters.list()) {
          bySite[a.id] = this.filterModels(list, a);
        }
        this.cache = { fetchedAt: Date.now(), bySite };
        this.writeCache(bySite);
        return bySite;
      } catch (e) {
        this.cache = null;
        throw e;
      } finally {
        this.loading = null;
      }
    })();
    return this.loading;
  }

  filterModels(list, adapter) {
    const filters = adapter.catalogFilter || [];
    const out = [];
    const seen = new Set();
    for (const m of list) {
      const id = String(m.id || '');
      const lower = id.toLowerCase();
      let hit = false;
      for (const f of filters) {
        if (lower.includes(f.toLowerCase())) {
          hit = true;
          break;
        }
      }
      if (!hit) continue;
      let clean = id.replace(/^~/, '');
      clean = clean.replace(/^[a-z0-9-]+\//, '');
      clean = clean.split(':')[0];
      if (!clean || seen.has(clean)) continue;
      seen.add(clean);
      out.push(clean);
    }
    return out;
  }

  getModels(adapterId) {
    if (this.cache && this.cache.bySite && this.cache.bySite[adapterId]) {
      const m = this.cache.bySite[adapterId];
      if (m.length) return m;
    }
    const a = adapters.get(adapterId);
    return a ? a.models : [];
  }

  getSource() {
    if (this.cache) return 'online';
    return 'static';
  }
}

module.exports = new ModelCatalog();
