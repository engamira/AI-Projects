export type HealthResponse = {
  status: 'ok' | 'degraded';
  database: 'ok' | 'error' | 'not_configured';
  time: string;
};

export type ProbeResponse = {
  id: number;
  note: string;
  createdAt: string;
};
