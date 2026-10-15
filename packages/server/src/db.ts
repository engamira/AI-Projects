import pg from 'pg';

export type Db = Pick<pg.Pool, 'query' | 'end'>;

export function createPool(connectionString: string): pg.Pool {
  return new pg.Pool({
    connectionString,
    max: 5,
    ssl: connectionString.includes('localhost') ? false : { rejectUnauthorized: true },
  });
}
