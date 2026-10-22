export const E2E_HTTP_PORT = Number(process.env.E2E_HTTP_PORT ?? 18200);
export const MAILPIT_PORT = Number(process.env.MAILPIT_PORT ?? 18235);
export const BASE_URL = `http://127.0.0.1:${E2E_HTTP_PORT}`;
export const MAILPIT_URL = `http://127.0.0.1:${MAILPIT_PORT}`;
export const PROJECT = 'pcp-e2e';
export const CADDY_ADDRESS = '172.31.9.10';
/** Repository-relative work directory shared by global setup and the agent journey. */
export const E2E_WORK_DIR = new URL('../.tmp/', import.meta.url).pathname;
