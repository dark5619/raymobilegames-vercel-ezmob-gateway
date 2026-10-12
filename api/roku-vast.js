import { handleRokuVast } from '../src/gateway.js';

export default async function handler(req, res) {
  return handleRokuVast(req, res);
}
