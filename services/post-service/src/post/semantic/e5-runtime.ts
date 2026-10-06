import { DIMENSIONS } from './policy.js';
import { verifyModel } from './model-artifacts.js';

export interface E5Runtime {
  tokenize(text: string): number[];
  readonly prefix: number[];
  readonly suffix: number[];
  infer(tokens: number[]): Promise<number[]>;
  close(): Promise<void>;
}

export async function loadE5Runtime(path: string): Promise<E5Runtime> {
  await verifyModel(path);
  // 무거운 네이티브 모듈 로딩도 준비 과정에 포함한다. 앱 import 때 다운로드하지 않는다.
  const { AutoTokenizer, AutoModel, Tensor, mean_pooling } = await import(
    '@huggingface/transformers'
  );
  const tokenizer = await AutoTokenizer.from_pretrained(path, {
    local_files_only: true,
  });
  const model = await AutoModel.from_pretrained(path, {
    local_files_only: true,
    device: 'cpu',
    dtype: 'fp32',
    session_options: { intraOpNumThreads: 1, interOpNumThreads: 1 },
  });
  try {
    // 본문 토큰이 단어 경계 공백을 포함한다. 접두사만 토큰화할 때 공백을 붙이면
    // 단독 공백 토큰이 추가되어 `query: ${text}`의 기준 벡터와 달라진다.
    const prefix = tokenizer.encode('query:');
    const end = prefix.pop();
    if (end !== tokenizer.eos_token_id || prefix[0] !== tokenizer.bos_token_id)
      throw new Error('Unexpected E5 special tokens');
    return {
      prefix,
      suffix: [end!],
      tokenize: (text) => tokenizer.encode(text, { add_special_tokens: false }),
      async infer(tokens) {
        const tensor = (values: number[]) =>
          new Tensor('int64', BigInt64Array.from(values, BigInt), [
            1,
            values.length,
          ]);
        const mask = tensor(tokens.map(() => 1));
        const output = await model({
          input_ids: tensor(tokens),
          attention_mask: mask,
          token_type_ids: tensor(tokens.map(() => 0)),
        });
        const pooled = mean_pooling(output.last_hidden_state, mask).normalize(
          2,
          -1,
        );
        if (pooled.dims[1] !== DIMENSIONS)
          throw new Error('Unexpected E5 output dimensions');
        return Array.from(pooled.data, Number);
      },
      async close() {
        await model.dispose();
      },
    };
  } catch (error) {
    await model.dispose();
    throw error;
  }
}
