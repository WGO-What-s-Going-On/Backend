import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// 전처리·창 분할·pooling·추론 패키지가 달라지면 버전과 인덱스를 함께 바꾼다.
export const E5_VERSION = 'e5-small-761b726-fp32-w480-o64-v1';
export const E5_MODEL = 'Xenova/multilingual-e5-small';
export const E5_REVISION = '761b726dd34fb83930e26aab4e9ac3899aa1fa78';
export const E5_FILES = {
  'config.json':
    '39ae266ada9abf9607577a820dd175ad2643006550aeb91b3d4d6e16321cb51f',
  'tokenizer_config.json':
    '0b7c625f06a64043b2956d5901f4a3544b0f1fddd3faefdb3fb4083e8497906d',
  'tokenizer.json':
    '47a2f17e41a229a5b5811b31bfd6106b08a2e994a3deef7838b9b24d260d75fb',
  'onnx/model.onnx':
    '4aa845c27760e06e9a686b9d8b5d440eae4b6612cd09e5b522b716d3941f77ff',
} as const;

export function modelPath() {
  return resolve(
    process.env.SEMANTIC_MODEL_PATH ?? `.cache/models/${E5_MODEL}`,
  );
}

export async function artifactHash(path: string, json: boolean) {
  const hash = createHash('sha256');
  // JSON 포맷 공백은 모델 의미를 바꾸지 않는다. ONNX는 원본 바이트로 검증한다.
  if (json)
    hash.update(JSON.stringify(JSON.parse(await readFile(path, 'utf8'))));
  else for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export async function verifyModel(path: string) {
  for (const [name, expected] of Object.entries(E5_FILES)) {
    if (
      (await artifactHash(resolve(path, name), name.endsWith('.json'))) !==
      expected
    )
      throw new Error(`Embedding model checksum mismatch: ${name}`);
  }
}
