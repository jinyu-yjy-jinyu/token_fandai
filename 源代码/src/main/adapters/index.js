const deepseek = require('./deepseek');
const kimi = require('./kimi');
const zhipu = require('./zhipu');
const zai = require('./zai');
const tongyi = require('./tongyi');
const doubao = require('./doubao');
const yiyan = require('./yiyan');

const ALL = [deepseek, kimi, zhipu, zai, tongyi, doubao, yiyan];

class AdapterRegistry {
  constructor() {
    this.map = new Map();
    for (const a of ALL) this.map.set(a.id, a);
  }
  get(id) {
    return this.map.get(id);
  }
  list() {
    return [...this.map.values()];
  }
  findByModel(model) {
    if (!model) return null;
    for (const a of this.map.values()) {
      if (a.models && a.models.includes(model)) return a;
      if (a.defaultModel === model) return a;
    }
    const prefix = String(model).split('-')[0].toLowerCase();
    for (const a of this.map.values()) {
      if (a.id.toLowerCase().includes(prefix) || prefix.includes(a.id.toLowerCase())) return a;
    }
    return null;
  }
}

module.exports = new AdapterRegistry();
