/** Builds a fake DatabaseService whose withTransaction runs the callback against a scripted fake client. */
export function fakeDbWithTx(opts: { queries?: any[][]; clientQueries?: any[][] }) {
  const clientQuery = jest.fn();
  (opts.clientQueries ?? []).forEach((rows) => clientQuery.mockResolvedValueOnce({ rows }));
  const client = { query: clientQuery };
  const query = jest.fn();
  (opts.queries ?? []).forEach((rows) => query.mockResolvedValueOnce({ rows }));
  return { db: { query, withTransaction: jest.fn(async (cb: any) => cb(client)) } as any, client, query, clientQuery };
}
