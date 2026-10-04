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
  // session_key_id is required: it is the host-chain key REIN revokes, and a
  // mandate without one would be unenforceable.
  createMandate: (token: string, data: {
    delegator: string;
    agent_address: string;
    mandate_text: string;
    session_key_id: string;
    spend_ceiling_wei?: string;
    chain_id?: string;
  }) => fetchApi<{ mandate: any; genlayer_tx_hash: string; host_chain: any }>('/api/mandates', token, { method: 'POST', body: JSON.stringify(data) }),

  // What ReinSessionKeyRegistry on the host chain says about this delegation.
  // `active: false` means the agent's session key cannot spend, whatever any
  // database says.
  getHostStatus: (token: string, delegationId: string) =>
    fetchApi<{
      delegation_id: string;
      handle: string;
      active: boolean;
      delegation: any;
      chainId: string;
      sessionKeyRegistry: string | null;
    }>(`/api/mandates/${delegationId}/host`, token),

  getMandates: (token: string) =>
    fetchApi<{ mandates: any[] }>('/api/mandates', token),

  getMandate: (token: string, delegationId: string) =>
    fetchApi<{ mandate: any }>(`/api/mandates/${delegationId}`, token),

  // Actions / Review
  // No chain_id and no mandate text: the court reads both from MandateRegistry
  // so a review is bound to the delegation that was actually registered.
  reviewAction: (token: string, data: {
    delegation_id: string;
    tx_hash: string;
    action_description?: string;
  }) => fetchApi<{ action_id: string; status: string; verdict: any; revocation: any; genlayer_tx_hash: string }>('/api/actions/review', token, { method: 'POST', body: JSON.stringify(data) }),

  getActionStatus: (token: string, actionId: string) =>
    fetchApi<{ action_id: string; status: string; verdict: any; revocation: any; genlayer_tx_hash: string }>(`/api/actions/${actionId}/status`, token),

  // Verdicts
  getVerdicts: (token: string) =>
    fetchApi<{ verdicts: any[] }>('/api/verdicts', token),

  getVerdictsByDelegation: (token: string, delegationId: string) =>
    fetchApi<{ verdicts: any[] }>(`/api/verdicts/${delegationId}`, token),

  // Revocations
  getRevocations: (token: string) =>
    fetchApi<{ revocations: any[] }>('/api/revocations', token),

  // Appeals
  // The bond is not a parameter. It is a fixed amount of native value the
  // relayer sends with the call and the Enforcer escrows, so it cannot be
  // declared as a number that nothing collects.
  createAppeal: (token: string, data: {
    revocation_id: string;
    appeal_reason: string;
  }) => fetchApi<{ appeal_id: string; appeal: any; bond_wei: string; genlayer_tx_hash: string }>('/api/appeals', token, { method: 'POST', body: JSON.stringify(data) }),

  adjudicateAppeal: (token: string, appealId: string) =>
    fetchApi<{ appeal_id: string; status: string; genlayer_tx_hash: string }>(`/api/appeals/${appealId}/adjudicate`, token, { method: 'POST', body: JSON.stringify({}) }),

  getAppealStatus: (token: string, appealId: string) =>
    fetchApi<{
      appeal_id: string;
      status: string;
      adjudication: any;
      restoration_state?: string;
      restoration_tx_hash?: string;
      bond_settlement?: string;
      bond_paid_to?: string;
      genlayer_tx_hash: string;
    }>(`/api/appeals/${appealId}/status`, token),

  getAppeals: (token: string) =>
    fetchApi<{ appeals: any[] }>('/api/appeals', token),

  // Health, which reports whether revocations can actually be enforced.
  getHealth: () =>
    fetch(`${API_URL}/api/health`).then((r) => r.json() as Promise<{
      status: string;
      contracts: Record<string, string>;
      host_chain: { chainId: string; sessionKeyRegistry: string | null; guardian: string | null; configured: boolean };
      appeal_bond_wei: string;
      relayer: string;
    }>),

  // Stats
  getStats: (token: string) =>
    fetchApi<{
      mandates: Record<string, number>;
      verdicts: Record<string, number>;
      total_revocations: number;
      appeals: Record<string, number>;
    }>('/api/stats', token),
};
