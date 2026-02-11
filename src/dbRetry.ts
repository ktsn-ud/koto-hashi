// Prisma のエラー型は状況で揺れるので「コード文字列を含むか」で判定（堅牢寄り）
function isRetryable40001(e: unknown): boolean {
  const msg = String((e as any)?.message ?? '');
  const code = (e as any)?.code;
  // Cockroach: SQLSTATE 40001 / "restart transaction" が典型
  // https://www.cockroachlabs.com/docs/v26.1/transaction-retry-error-reference#client-side-retry-handling
  return (
    code === '40001' ||
    msg.includes('40001') ||
    msg.includes('restart transaction')
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function withDbRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 3
): Promise<T> {
  for (let retries = 0; ; retries++) {
    try {
      return await fn();
    } catch (e) {
      if (retries > maxRetries || !isRetryable40001(e)) throw e;
      await sleep(50 * (retries + 1)); // 軽いバックオフ
    }
  }
}
