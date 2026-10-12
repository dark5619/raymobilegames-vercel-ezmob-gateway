/**
 * Bridge Web Standard Request/Response to the existing req/res handlers.
 */
export async function runNodeHandler(handler, request) {
  const headers = Object.fromEntries(request.headers);
  const req = {
    method: request.method,
    url: request.url,
    headers
  };

  const state = { statusCode: 200, headers: {}, body: '' };
  const res = {
    setHeader(key, value) {
      state.headers[String(key).toLowerCase()] = String(value);
      return this;
    },
    status(code) {
      state.statusCode = code;
      return this;
    },
    send(body) {
      state.body = typeof body === 'string' ? body : String(body ?? '');
      return this;
    },
    json(object) {
      if (!state.headers['content-type']) {
        state.headers['content-type'] = 'application/json; charset=utf-8';
      }
      state.body = JSON.stringify(object);
      return this;
    }
  };

  await handler(req, res);

  return new Response(state.body, {
    status: state.statusCode,
    headers: state.headers
  });
}
