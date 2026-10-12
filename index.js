import { handleHealth } from './src/health.js';
import { handleRokuVast } from './src/gateway.js';
import { runNodeHandler } from './src/node-handler.js';

const ROUTES = new Map([
  ['/health', handleHealth],
  ['/api/health', handleHealth],
  ['/roku/vast', handleRokuVast],
  ['/api/roku-vast', handleRokuVast]
]);

export default {
  async fetch(request) {
    const pathname = new URL(request.url).pathname;
    const handler = ROUTES.get(pathname);
    if (!handler) {
      return new Response('Not Found', { status: 404 });
    }
    return runNodeHandler(handler, request);
  }
};
