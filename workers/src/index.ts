export interface Env {
	TARGET_ENDPOINT_URL: string;
	HEALTHCHECK_RETRIES: number;
	HEALTHCHECK_TIMEOUT_MS: number;
}

export default {
	async fetch(request: Request, env: Env, _ctx: ExecutionContext) {
		return new Response('Hello, world!');
	},
};
