// The one encoder this service runs. Changing the model or its quantisation is a new VERSION:
// every stored vector carries (name, version), and housekeeping re-embeds rows on an older one (D21).
import { pipeline, env } from '@huggingface/transformers';
export const NAME = 'bge-small-en-v1.5';
export const VERSION = '1';
export const DIMENSIONS = 384;
export const MODEL = 'Xenova/bge-small-en-v1.5';
export const DTYPE = 'q8';
// Units are encoded eight at a time: peak memory grows with the padded batch (about 270 MB at 8,
// 600 MB at 64 on the measured machine) while throughput does not.
export const BATCH = 8;
export function configure(modelDir, { remote = false } = {}) {
 env.cacheDir = modelDir;
 env.allowRemoteModels = remote;
 env.allowLocalModels = true;
}
export async function loadEncoder(modelDir, options) {
 configure(modelDir, options);
 const extract = await pipeline('feature-extraction', MODEL, { dtype: DTYPE });
 return {
  name: NAME, version: VERSION, dimensions: DIMENSIONS,
  // bge models take the CLS vector, normalised; longer units are truncated by the tokenizer at 512 tokens.
  async embed(units) {
   const vectors = [];
   for (let start = 0; start < units.length; start += BATCH) {
    const out = await extract(units.slice(start, start + BATCH), { pooling: 'cls', normalize: true });
    vectors.push(...out.tolist());
   }
   return vectors;
  },
 };
}
