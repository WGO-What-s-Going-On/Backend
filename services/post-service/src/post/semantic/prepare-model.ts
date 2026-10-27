import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import {
  artifactHash,
  E5_FILES,
  E5_MODEL,
  E5_REVISION,
  modelPath,
  verifyModel,
} from './model-artifacts.js';

async function main() {
  const path = modelPath();
  for (const [name, expected] of Object.entries(E5_FILES)) {
    const destination = resolve(path, name);
    const json = name.endsWith('.json');
    if ((await artifactHash(destination, json).catch(() => '')) === expected)
      continue;
    await mkdir(dirname(destination), { recursive: true });
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try {
      const response = await fetch(
        `https://huggingface.co/${E5_MODEL}/resolve/${E5_REVISION}/${name}`,
        { signal: AbortSignal.timeout(600000) },
      );
      if (!response.ok || !response.body)
        throw new Error(`Model download failed: ${name} (${response.status})`);
      await pipeline(
        Readable.fromWeb(response.body),
        createWriteStream(temporary, { flags: 'wx' }),
      );
      if ((await artifactHash(temporary, json)) !== expected)
        throw new Error(`Model checksum mismatch: ${name}`);
      // 검증 실패/다운로드 중단 시 기존 정상 파일을 덮어쓰지 않는다.
      await rename(temporary, destination);
      console.info(`Prepared ${name}`);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  await verifyModel(path);
  console.info(`Model ready on disk: ${path} (${E5_REVISION})`);
}

void main().catch((error) => {
  console.error(String(error));
  process.exitCode = 1;
});
