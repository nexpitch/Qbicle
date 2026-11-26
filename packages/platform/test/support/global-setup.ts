import { buildTemplate } from './db.ts';

export default async function setup(): Promise<void> {
  await buildTemplate();
}
