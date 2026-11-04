const fs = require('fs');
const path = require('path');

let wasmInstance = null;
let wasmReady = null;

async function loadWasm() {
  if (wasmReady) return wasmReady;
  wasmReady = (async () => {
    const wasmPath = path.join(__dirname, 'deepseek_pow.wasm');
    const bytes = fs.readFileSync(wasmPath);
    const { instance } = await WebAssembly.instantiate(bytes, { wbg: {} });
    wasmInstance = instance.exports;
  })();
  return wasmReady;
}

function encodeString(text, malloc, realloc) {
  const memory = wasmInstance.memory;
  const bytes = Buffer.from(text, 'utf8');
  const len = bytes.length;
  const ptr = malloc(len, 1) >>> 0;
  const view = new Uint8Array(memory.buffer, ptr, len);
  view.set(bytes);
  return { ptr, len };
}

async function solveDeepSeekPoW(challenge) {
  await loadWasm();
  const { wasm_solve, __wbindgen_add_to_stack_pointer, __wbindgen_export_0: malloc, memory } = wasmInstance;

  if (challenge.algorithm !== 'DeepSeekHashV1') {
    throw new Error(`不支持的算法: ${challenge.algorithm}`);
  }

  const prefix = `${challenge.salt}_${challenge.expireAt}_`;
  const { ptr: challengePtr, len: challengeLen } = encodeString(challenge.challenge, malloc, malloc);
  const { ptr: prefixPtr, len: prefixLen } = encodeString(prefix, malloc, malloc);

  const stack = __wbindgen_add_to_stack_pointer(-16) >>> 0;
  try {
    wasm_solve(stack, challengePtr, challengeLen, prefixPtr, prefixLen, challenge.difficulty);
    const view = new DataView(memory.buffer);
    const status = view.getInt32(stack, true);
    const answer = view.getFloat64(stack + 8, true);
    if (status === 0) {
      throw new Error('PoW 求解失败');
    }
    return answer;
  } finally {
    __wbindgen_add_to_stack_pointer(16);
  }
}

async function buildPowHeader(challenge, targetPath) {
  const answer = await solveDeepSeekPoW(challenge);
  const payload = {
    algorithm: challenge.algorithm,
    challenge: challenge.challenge,
    salt: challenge.salt,
    answer,
    signature: challenge.signature,
    target_path: targetPath,
  };
  return {
    name: 'X-DS-PoW-Response',
    value: Buffer.from(JSON.stringify(payload)).toString('base64'),
  };
}

module.exports = { solveDeepSeekPoW, buildPowHeader };
