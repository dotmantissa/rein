'use client';

import { useEffect, useState, useCallback, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { usePrivy } from '@privy-io/react-auth';
import { api } from '@/lib/api';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { Scale, Gavel, Loader2, Plus, ArrowUpRight } from 'lucide-react';
import Link from 'next/link';

function AppealsContent() {
  const searchParams = useSearchParams();
  const prefillRevocationId = searchParams.get('revocationId');
  const { getAccessToken } = usePrivy();

  const [appeals, setAppeals] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [adjudicatingId, setAdjudicatingId] = useState<string | null>(null);
  const [formVisible, setFormVisible] = useState(!!prefillRevocationId);
  const [error, setError] = useState('');

  const [formData, setFormData] = useState({
    revocation_id: prefillRevocationId || '',
    appeal_reason: '',
  });
  // The bond is a fixed amount of native value the relayer sends with the call
  // and the Enforcer escrows. It was a number typed into this form that nothing
  // ever collected, which made both halves of the published appeal economics
  // claims about nothing.
  const [bondWei, setBondWei] = useState<string | null>(null);

  useEffect(() => {
    api
      .getHealth()
      .then((h) => setBondWei(h.appeal_bond_wei))
      .catch(() => setBondWei(null));
  }, []);

  const loadAppeals = useCallback(async () => {
    try {
      const token = await getAccessToken();
      if (token) {
        const data = await api.getAppeals(token);
        setAppeals(data.appeals || []);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [getAccessToken]);

  useEffect(() => {
    loadAppeals();
  }, [loadAppeals]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError('');
    try {
      const token = await getAccessToken();
      if (!token) throw new Error('Not authenticated');

      await api.createAppeal(token, {
        revocation_id: formData.revocation_id,
        appeal_reason: formData.appeal_reason,
      });

      setFormVisible(false);
      setFormData({ revocation_id: '', appeal_reason: '' });
      await loadAppeals();
    } catch (err: any) {
      console.error(err);
      setError(err.message || 'Failed to submit appeal.');
    } finally {
      setSubmitting(false);
    }
  };

  // Appeals are filed against a confirmed revocation, so the bond is denominated
  // in the native token of the chain the Enforcer runs on.
  const formatBond = (wei: string) => {
    try {
      const n = BigInt(wei);
      const whole = n / 10n ** 18n;
      const frac = (n % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, '');
      return frac ? `${whole}.${frac}` : `${whole}`;
    } catch {
      return wei;
    }
  };

  const handleAdjudicate = async (appealId: string) => {
    setAdjudicatingId(appealId);
    try {
      const token = await getAccessToken();
      if (!token) return;
      await api.adjudicateAppeal(token, appealId);

      // Adjudication is an LLM call settled by GenLayer consensus, so the
      // submit above only broadcasts. Poll until the ruling is on chain.
      const deadline = Date.now() + 5 * 60 * 1000;
      for (;;) {
        await new Promise((r) => setTimeout(r, 10000));
        let status = 'ADJUDICATING';
        try {
          status = (await api.getAppealStatus(token, appealId)).status;
        } catch {
          // Transient poll failure; keep waiting.
        }
        if (status !== 'ADJUDICATING' || Date.now() >= deadline) break;
      }

      await loadAppeals();
    } catch (err: any) {
      console.error(err);
      alert(err.message || 'Adjudication failed on GenLayer.');
    } finally {
      setAdjudicatingId(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="w-6 h-6 border-2 border-[#eb1700] border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-8 max-w-4xl mx-auto">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="font-mono text-sm text-neutral-300">appeals court</h2>
          <p className="text-xs text-neutral-500">
            Challenge a confirmed revocation before a fresh GenLayer validator
            panel. The panel re-reads the registered mandate and the verified
            on-chain facts the original verdict was reached on.
          </p>
        </div>

        <button
          onClick={() => setFormVisible(!formVisible)}
          className="inline-flex items-center gap-1.5 self-start bg-white text-[#191919] px-4 py-2 rounded-sm text-xs font-mono font-medium hover:bg-neutral-200 transition-colors"
        >
          {formVisible ? (
            'Close form'
          ) : (
            <>
              <Plus size={14} />
              File an appeal
            </>
          )}
        </button>
      </div>

      {formVisible && (
        <div className="bg-[#1f1f1f] border border-[#2a2a2a] p-6 rounded-sm">
          <h3 className="font-mono text-sm text-neutral-300 mb-4">file formal appeal with bonded stake</h3>

          {error && (
            <p className="text-xs text-[#eb1700] font-mono mb-4">{error}</p>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-xs font-mono text-neutral-500 mb-1.5">revocation identifier</label>
              <input
                required
                type="text"
                value={formData.revocation_id}
                onChange={(e) => setFormData({ ...formData, revocation_id: e.target.value })}
                className="w-full bg-transparent border border-[#2a2a2a] rounded-sm px-4 py-2.5 font-mono text-sm text-white placeholder:text-neutral-600 focus:outline-none focus:border-[#eb1700]/50 focus:ring-1 focus:ring-[#eb1700]/30 transition-colors"
                placeholder="rev_..."
              />
            </div>

            <div>
              <label className="block text-xs font-mono text-neutral-500 mb-1.5">appeal argument</label>
              <textarea
                required
                rows={4}
                value={formData.appeal_reason}
                onChange={(e) => setFormData({ ...formData, appeal_reason: e.target.value })}
                className="w-full bg-transparent border border-[#2a2a2a] rounded-sm px-4 py-3 text-sm text-white placeholder:text-neutral-600 focus:outline-none focus:border-[#eb1700]/50 focus:ring-1 focus:ring-[#eb1700]/30 transition-colors"
                placeholder="Detail why the flagged transaction complied with the spirit of the natural language mandate."
              />
            </div>

            <div className="border border-[#2a2a2a] rounded-sm p-4 bg-black/20 space-y-1.5">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-xs font-mono text-neutral-500">bond posted with this appeal</span>
                <span className="text-sm font-mono text-neutral-200">
                  {bondWei ? `${formatBond(bondWei)} GEN` : '...'}
                </span>
              </div>
              <p className="text-xs text-neutral-500 leading-relaxed">
                Escrowed by the Enforcer contract when the appeal is filed.
                Returned in full if the revocation is overturned. Awarded to the
                watcher who flagged the breach if it is upheld.
              </p>
            </div>

            <button
              type="submit"
              disabled={submitting}
              className="inline-flex items-center gap-2 bg-[#eb1700] text-white px-5 py-2.5 rounded-sm font-medium text-sm hover:bg-red-700 transition-colors disabled:opacity-40"
            >
              {submitting ? (
                <>
                  <Loader2 size={14} className="animate-spin" />
                  Recording bond on GenLayer...
                </>
              ) : (
                'Submit appeal to panel'
              )}
            </button>
          </form>
        </div>
      )}

      {/* Appeals List */}
      <div className="space-y-3">
        {appeals.length > 0 ? (
          appeals.map(a => {
            const isPending = a.status === 'PENDING';
            const isOverturned = a.status === 'OVERTURNED';
            const isUpheld = a.status === 'UPHELD';

            return (
              <div key={a.appeal_id} className="bg-[#1f1f1f] border border-[#2a2a2a] rounded-sm p-5 space-y-4">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                  <div className="flex items-center gap-3">
                    <span className="font-mono text-xs text-neutral-400">
                      Appeal {a.appeal_id}
                    </span>
                    <StatusBadge status={a.status || 'PENDING'} />
                  </div>
                  <span className="font-mono text-xs text-neutral-500">
                    Bond: {formatBond(a.bond_wei || a.bond_amount || '0')} GEN
                    {a.bond_settlement ? ` · ${a.bond_settlement.replace(/_/g, ' ').toLowerCase()}` : ''}
                  </span>
                </div>

                <div className="space-y-1">
                  <span className="text-xs font-mono text-neutral-500">operator argument</span>
                  <p className="text-sm text-neutral-200 font-mono bg-black/30 p-3 rounded-sm leading-relaxed">
                    {a.appeal_reason}
                  </p>
                </div>

                {a.adjudication_result && (
                  <div className="space-y-1">
                    <span className="text-xs font-mono text-neutral-500">panel adjudication verdict</span>
                    <p className={`text-sm font-mono p-3 rounded-sm border-l-2 ${
                      isOverturned
                        ? 'border-green-500 bg-green-500/10 text-green-300'
                        : isUpheld
                        ? 'border-[#eb1700] bg-[#eb1700]/10 text-red-300'
                        : 'border-neutral-500 bg-black/20 text-neutral-300'
                    }`}>
                      {a.adjudication_result}
                    </p>
                  </div>
                )}

                {isOverturned && (
                  <div className="space-y-1">
                    <span className="text-xs font-mono text-neutral-500">host chain restoration</span>
                    {a.restoration_state === 'RESTORED' ? (
                      <p className="text-sm font-mono text-green-300">
                        Restored. The agent&rsquo;s session key can spend again.
                        {a.restoration_tx_hash
                          ? ` tx ${a.restoration_tx_hash.slice(0, 12)}...${a.restoration_tx_hash.slice(-8)}`
                          : ''}
                      </p>
                    ) : (
                      <p className="text-sm font-mono text-amber-400">
                        Pending ({(a.restoration_state || 'PENDING_HOST_RESTORE')
                          .replace(/_/g, ' ')
                          .toLowerCase()}). The bond is back, but the key stays
                        revoked until the restoration lands on chain.
                      </p>
                    )}
                  </div>
                )}

                <div className="pt-2 border-t border-[#2a2a2a] flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs font-mono text-neutral-500">
                  <div className="flex items-center gap-3">
                    <span>Revocation: {a.revocation_id}</span>
                    {a.delegation_id && (
                      <Link
                        href={`/mandates/${a.delegation_id}`}
                        className="text-neutral-400 hover:text-white underline underline-offset-2 flex items-center gap-1"
                      >
                        Mandate
                        <ArrowUpRight size={10} />
                      </Link>
                    )}
                  </div>

                  {isPending && (
                    <button
                      onClick={() => handleAdjudicate(a.appeal_id)}
                      disabled={adjudicatingId === a.appeal_id}
                      className="inline-flex items-center gap-1.5 bg-[#2a2a2a] hover:bg-neutral-700 text-white px-3 py-1.5 rounded-sm transition-colors disabled:opacity-50 text-xs self-start sm:self-auto"
                    >
                      {adjudicatingId === a.appeal_id ? (
                        <>
                          <Loader2 size={12} className="animate-spin" />
                          Validators convening...
                        </>
                      ) : (
                        <>
                          <Gavel size={12} />
                          Convene validator panel
                        </>
                      )}
                    </button>
                  )}
                </div>
              </div>
            );
          })
        ) : (
          <div className="text-center py-16 bg-[#1f1f1f] border border-[#2a2a2a] rounded-sm">
            <Scale size={36} className="mx-auto text-neutral-600 mb-3" />
            <p className="text-neutral-400 text-sm">No appeals on file.</p>
            <p className="text-neutral-600 text-xs mt-1">If an agent was unjustly revoked, file an appeal to convene an independent panel.</p>
          </div>
        )}
      </div>
    </div>
  );
}

export default function AppealsPage() {
  return (
    <Suspense fallback={
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="w-6 h-6 border-2 border-[#eb1700] border-t-transparent rounded-full animate-spin" />
      </div>
    }>
      <AppealsContent />
    </Suspense>
  );
}
