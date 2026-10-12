import { handleHealth } from '../src/health.js';

export default function handler(req, res) {
  return handleHealth(req, res);
}
