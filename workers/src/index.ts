export interface Env {
	TARGET_ENDPOINT_URL: string;
	HEALTHCHECK_RETRIES: number;
	HEALTHCHECK_TIMEOUT_MS: number;
}

export default {
	async fetch(request: Request, env: Env, _ctx: ExecutionContext) {
		return new Response('Hello, world!');
	},

	async scheduled(event: ScheduledEvent, env: Env, _ctx: ExecutionContext) {
		const timestamp = new Date().toISOString();
		console.log(`[Healthcheck] Starting at ${timestamp}`);

		const maxRetries = env.HEALTHCHECK_RETRIES || 3;
		const timeoutMs = env.HEALTHCHECK_TIMEOUT_MS || 5000;

		let lastError: string | null = null;

		for (let attempt = 1; attempt <= maxRetries; attempt++) {
			try {
				// タイムアウト
				const controller = new AbortController();
				const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

				// 死活用エンドポイントにリクエスト
				const response = await fetch(`${env.TARGET_ENDPOINT_URL}`, {
					method: 'GET',
					signal: controller.signal,
				});

				clearTimeout(timeoutId);

				if (response.ok) {
					console.log('[Healthcheck] ✓ Server is healthy');
					return;
				}

				lastError = `HTTP ${response.status} ${response.statusText}`;
				console.warn(`[Attempt ${attempt}] ${lastError}`);
			} catch (err) {
				lastError = err instanceof Error ? err.message : String(err);
				console.warn(`[Attempt ${attempt}] Error: ${lastError}`);

				if (attempt < maxRetries) {
					await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
				}
			}
		}

		// 全て失敗
		const errorMessage = `[Healthcheck] Error: Server healthcheck failed after ${maxRetries} attempts: ${lastError}`;
		console.error(errorMessage);
	},
};
