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
    bond_amount: '0.1',
  });

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
        bond_amount: formData.bond_amount,
      });

      setFormVisible(false);
      setFormData({ revocation_id: '', appeal_reason: '', bond_amount: '0.1' });
      await loadAppeals();
    } catch (err: any) {
      console.error(err);
      setError(err.message || 'Failed to submit appeal.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleAdjudicate = async (appealId: string) => {
    setAdjudicatingId(appealId);
    try {
      const token = await getAccessToken();
      if (!token) return;
      await api.adjudicateAppeal(token, appealId);
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
            Challenge revocation decisions before an independent GenLayer validator panel with bonded stake.
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

            <div>
              <label className="block text-xs font-mono text-neutral-500 mb-1.5">bond amount in ETH</label>
              <input
                required
                type="number"
                step="0.01"
                min="0.01"
                value={formData.bond_amount}
                onChange={(e) => setFormData({ ...formData, bond_amount: e.target.value })}
                className="w-full bg-transparent border border-[#2a2a2a] rounded-sm px-4 py-2.5 font-mono text-sm text-white focus:outline-none focus:border-[#eb1700]/50 focus:ring-1 focus:ring-[#eb1700]/30 transition-colors"
              />
              <p className="text-xs text-neutral-500 mt-1">
                Bond is returned in full if overturned. Upheld appeals forfeit bond to the bounty watcher.
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
                    Bond: {a.bond_amount} ETH
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
