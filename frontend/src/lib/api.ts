const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

async function fetchApi<T = any>(endpoint: string, token: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_URL}${endpoint}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...options.headers,
    },
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    throw new Error(`API error ${response.status}: ${errorBody}`);
  }

  const json = await response.json();
  return json;
}

export const api = {
  // User
  registerUser: (token: string, data: { email: string }) =>
    fetchApi<{ user: any }>('/api/users/register', token, { method: 'POST', body: JSON.stringify(data) }),

  getUser: (token: string) =>
    fetchApi<{ user: any }>('/api/users/me', token),

  // Mandates
  createMandate: (token: string, data: {
    delegator: string;
    agent_address: string;
    mandate_text: string;
    spend_ceiling_wei?: string;
    chain_id?: string;
    session_key_id?: string;
  }) => fetchApi<{ mandate: any; genlayer_tx_hash: string }>('/api/mandates', token, { method: 'POST', body: JSON.stringify(data) }),

  getMandates: (token: string) =>
    fetchApi<{ mandates: any[] }>('/api/mandates', token),

  getMandate: (token: string, delegationId: string) =>
    fetchApi<{ mandate: any }>(`/api/mandates/${delegationId}`, token),

  // Actions / Review
  reviewAction: (token: string, data: {
    delegation_id: string;
    tx_hash: string;
    chain_id?: string;
    action_description?: string;
  }) => fetchApi<{ action_id: string; verdict: any; revocation: any; genlayer_tx_hash: string }>('/api/actions/review', token, { method: 'POST', body: JSON.stringify(data) }),

  // Verdicts
  getVerdicts: (token: string) =>
    fetchApi<{ verdicts: any[] }>('/api/verdicts', token),

  getVerdictsByDelegation: (token: string, delegationId: string) =>
    fetchApi<{ verdicts: any[] }>(`/api/verdicts/${delegationId}`, token),

  // Revocations
  getRevocations: (token: string) =>
    fetchApi<{ revocations: any[] }>('/api/revocations', token),

  // Appeals
  createAppeal: (token: string, data: {
    revocation_id: string;
    appeal_reason: string;
    bond_amount?: string;
  }) => fetchApi<{ appeal_id: string; appeal: any; genlayer_tx_hash: string }>('/api/appeals', token, { method: 'POST', body: JSON.stringify(data) }),

  adjudicateAppeal: (token: string, appealId: string) =>
    fetchApi<{ appeal_id: string; status: string; genlayer_tx_hash: string }>(`/api/appeals/${appealId}/adjudicate`, token, { method: 'POST', body: JSON.stringify({}) }),

  getAppeals: (token: string) =>
    fetchApi<{ appeals: any[] }>('/api/appeals', token),

  // Stats
  getStats: (token: string) =>
    fetchApi<{
      mandates: Record<string, number>;
      verdicts: Record<string, number>;
      total_revocations: number;
      appeals: Record<string, number>;
    }>('/api/stats', token),
};
