import { definitions } from '@captain/steps';
import { installQueues } from './queue.ts';
const url = process.env.MIGRATION_DATABASE_URL;
if (!url) throw Error('MIGRATION_DATABASE_URL is required; only the operator installs queue metadata.');
await installQueues(url, definitions);
