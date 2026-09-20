// Build step: downloads the encoder into the image so the running service never reaches the internet.
import { loadEncoder, NAME, VERSION, DIMENSIONS } from './model.mjs';
const dir = process.argv[2] ?? './models';
const encoder = await loadEncoder(dir, { remote: true });
const [vector] = await encoder.embed(['warm up']);
if (vector.length !== DIMENSIONS) throw new Error(`expected ${DIMENSIONS} dimensions, got ${vector.length}`);
console.log(`fetched ${NAME} v${VERSION} into ${dir}`);
