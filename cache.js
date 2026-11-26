import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CACHE_TTL = 60 * 60 * 1000;

export async function cachedOpenCli({ workspace, toolDir, command, args, refresh, run, sanitize }) {
  const credentials = await Promise.all([
    join(homedir(), '.figma', 'token'),
    join(toolDir, '.env'),
  ].map((file) => readFile(file, 'utf8').catch(() => '')));
  const key = createHash('sha256').update(JSON.stringify([
    command, args, process.env.FIGMA_TOKEN, process.env.FIGMA_ACCESS_TOKEN,
    process.env.FIGMA_PERSONAL_ACCESS_TOKEN, ...credentials,
  ])).digest('hex');
  const dir = join(workspace, '.figma-mcp', 'cache');
  const file = join(dir, `${key}.json`);

  if (!refresh) {
    try {
      const cached = JSON.parse(await readFile(file, 'utf8'));
      if (Number.isFinite(cached.createdAt) && Date.now() - cached.createdAt >= 0 && Date.now() - cached.createdAt < CACHE_TTL && 'result' in cached) {
        return cached.result;
      }
    } catch {}
  }

  const result = sanitize(await run());
  const temporary = join(dir, `.${key}.${randomUUID()}.tmp`);
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(temporary, JSON.stringify({ createdAt: Date.now(), result }), { mode: 0o600 });
    await rename(temporary, file);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    console.error(`Figma cache write failed: ${error.code || 'unknown error'}`);
  }
  return result;
}
