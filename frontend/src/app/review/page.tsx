'use client';

import { useState, useEffect, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { usePrivy } from '@privy-io/react-auth';
import { api } from '@/lib/api';
import { motion, AnimatePresence } from 'framer-motion';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { SeverityBadge } from '@/components/ui/SeverityBadge';
import { Send, Loader2 } from 'lucide-react';

function ReviewContent() {
  const searchParams = useSearchParams();
  const prefillMandateId = searchParams.get('mandateId');

  const { getAccessToken } = usePrivy();
  const [mandates, setMandates] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState('');
  const [progress, setProgress] = useState('');

  const [formData, setFormData] = useState({
    delegationId: prefillMandateId || '',
    txHash: '',
    description: '',
  });

  useEffect(() => {
    async function load() {
      try {
        const token = await getAccessToken();
        if (token) {
          const data = await api.getMandates(token);
          // A revoked delegation has no authority left to judge, and the court
          // refuses to review one. Everything still live can be reviewed.
          const live = (data.mandates || []).filter((m: any) =>
            ['ACTIVE', 'FLAGGED', 'RESTORED'].includes(m.status)
          );
          setMandates(live);
        }
      } catch (e) {
        console.error(e);
      }
    }
    load();
  }, [getAccessToken]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setResult(null);
    setError('');
    try {
      const token = await getAccessToken();
      if (!token) throw new Error('Not authenticated');

      // Only the delegation and the hash. The court reads the mandate, the
      // agent and the chain out of MandateRegistry itself, so a review cannot be
      // pointed at a different mandate or a different chain than the one that
      // was registered.
      const res = await api.reviewAction(token, {
        delegation_id: formData.delegationId,
        tx_hash: formData.txHash,
        action_description: formData.description,
      });

      // The review runs an LLM through GenLayer consensus, which takes roughly
      // a minute. The submit call only broadcasts, so poll until the verdict
      // is on chain.
      setProgress('Submitted to GenLayer. Waiting for validators to reach consensus...');
      const deadline = Date.now() + 5 * 60 * 1000;
      let settled = res;

      while (settled.status !== 'REVIEWED' && Date.now() < deadline) {
        // StudioNet allows 500 RPC requests an hour across the whole backend,
        // so poll gently rather than every few seconds.
        await new Promise((r) => setTimeout(r, 10000));
        const elapsed = Math.round((Date.now() - (deadline - 5 * 60 * 1000)) / 1000);
        setProgress(`Waiting for consensus... ${elapsed}s elapsed (typically 50-90s)`);
        try {
          settled = await api.getActionStatus(token, res.action_id);
        } catch {
          // A transient poll failure is not fatal; keep waiting.
        }
      }

      if (settled.status !== 'REVIEWED') {
        throw new Error(
          'The verdict has not reached consensus yet. It will appear on the Verdicts page once the network settles.'
        );
      }

      setResult(settled);
    } catch (err: any) {
      console.error(err);
      setError(err.message || 'Review failed. The GenLayer network might be busy.');
    } finally {
      setLoading(false);
      setProgress('');
    }
  };

  const verdict = result?.verdict;

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div className="bg-[#1f1f1f] border border-[#2a2a2a] rounded-sm p-6">
        <h2 className="font-mono text-sm text-neutral-400 mb-5">submit an action for review</h2>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-mono text-neutral-500 mb-1.5">mandate</label>
            <select
              required
              value={formData.delegationId}
              onChange={(e) => setFormData({ ...formData, delegationId: e.target.value })}
              className="w-full bg-transparent border border-[#2a2a2a] rounded-sm px-4 py-2.5 text-sm font-mono text-white focus:outline-none focus:border-[#eb1700]/50 focus:ring-1 focus:ring-[#eb1700]/30 transition-colors"
            >
              <option value="" disabled className="bg-[#191919]">Pick the mandate this action should be judged against</option>
              {mandates.map(m => (
                <option key={m.delegation_id} value={m.delegation_id} className="bg-[#191919]">
                  {m.agent_address?.slice(0, 10)}...{m.agent_address?.slice(-4)} &middot; {m.status}
                </option>
              ))}
            </select>
            {mandates.length === 0 && (
              <p className="text-xs text-neutral-600 mt-1">No live mandates. Write one first.</p>
            )}
            <p className="text-[11px] text-neutral-600 mt-1.5">
              The chain and the mandate text come from the registered delegation,
              not from this form.
            </p>
          </div>

          <div>
            <label className="block text-xs font-mono text-neutral-500 mb-1.5">transaction hash</label>
            <input
              required
              type="text"
              value={formData.txHash}
              onChange={(e) => setFormData({ ...formData, txHash: e.target.value })}
              className="w-full bg-transparent border border-[#2a2a2a] rounded-sm px-4 py-2.5 font-mono text-sm text-white placeholder:text-neutral-600 focus:outline-none focus:border-[#eb1700]/50 focus:ring-1 focus:ring-[#eb1700]/30 transition-colors"
              placeholder="0x..."
            />
          </div>

          <div>
            <label className="block text-xs font-mono text-neutral-500 mb-1.5">what was the agent doing? (optional)</label>
            <input
              type="text"
              value={formData.description}
              onChange={(e) => setFormData({ ...formData, description: e.target.value })}
              className="w-full bg-transparent border border-[#2a2a2a] rounded-sm px-4 py-2.5 text-sm text-white placeholder:text-neutral-600 focus:outline-none focus:border-[#eb1700]/50 focus:ring-1 focus:ring-[#eb1700]/30 transition-colors"
              placeholder="Bought GPU credits on Lambda Cloud"
            />
          </div>

          {error && (
            <p className="text-sm text-[#eb1700]">{error}</p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="flex items-center justify-center gap-2 w-full bg-white text-[#191919] hover:bg-neutral-200 disabled:opacity-40 font-medium py-3 px-4 rounded-sm transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-[#191919]"
          >
            {loading ? (
              <>
                <Loader2 size={16} className="animate-spin" />
                Validators are deliberating...
              </>
            ) : (
              <>
                <Send size={16} />
                Submit for review
              </>
            )}
          </button>

          {loading && progress && (
            <p className="text-xs font-mono text-neutral-500 text-center">{progress}</p>
          )}
        </form>
      </div>

      <AnimatePresence>
        {verdict && (
          <motion.div
            initial={{ clipPath: 'inset(0 100% 0 0)' }}
            animate={{ clipPath: 'inset(0 0 0 0)' }}
            transition={{ duration: 0.3, ease: 'easeOut' }}
            className={`border rounded-sm p-6 relative overflow-hidden ${
              verdict.verdict === 'breach' ? 'border-[#eb1700]/40 bg-[#eb1700]/5' :
              verdict.verdict === 'ambiguous' ? 'border-amber-500/40 bg-amber-500/5' :
              'border-green-500/40 bg-green-500/5'
            }`}
          >
            <div className="flex items-center gap-3 mb-4">
              <StatusBadge status={verdict.verdict} />
              {verdict.severity && <SeverityBadge severity={verdict.severity} />}
              {verdict.attributed === false && (
                <span className="text-xs text-neutral-500 font-mono">
                  not the registered agent
                </span>
              )}
              {verdict.confidence && (
                <span className="text-xs text-neutral-500 font-mono">
                  {(verdict.confidence * 100).toFixed(0)}% confident
                </span>
              )}
            </div>

            <div className="space-y-4">
              <div>
                <h4 className="text-xs font-mono text-neutral-500 mb-1">the court says</h4>
                <p className="text-sm leading-relaxed">{verdict.reasoning || 'No reasoning provided.'}</p>
              </div>

              {verdict.breached_clause && (
                <div>
                  <h4 className="text-xs font-mono text-[#eb1700] mb-1">breached clause</h4>
                  <p className="text-sm font-mono border-l-2 border-[#eb1700] pl-3 py-1 bg-black/20 rounded-r-sm">
                    {verdict.breached_clause}
                  </p>
                </div>
              )}

              {result.revocation && (
                <div className="mt-4 pt-4 border-t border-[#eb1700]/20 space-y-1.5">
                  {result.revocation.host_state === 'REVOKED' ? (
                    <>
                      <p className="text-xs font-mono text-[#eb1700]">
                        Revoked. The agent&rsquo;s session key can no longer spend.
                      </p>
                      {result.revocation.evm_tx_hash && (
                        <p className="text-[11px] font-mono text-neutral-500">
                          host chain tx: {result.revocation.evm_tx_hash.slice(0, 12)}
                          ...{result.revocation.evm_tx_hash.slice(-8)}
                        </p>
                      )}
                    </>
                  ) : (
                    <>
                      <p className="text-xs font-mono text-amber-400">
                        Flagged. The revocation is on its way to the host chain
                        and the key is still live until it lands.
                      </p>
                      <p className="text-[11px] font-mono text-neutral-500">
                        state: {result.revocation.host_state || 'PENDING_HOST'}
                      </p>
                    </>
                  )}
                </div>
              )}

              {result.genlayer_tx_hash && (
                <p className="text-xs font-mono text-neutral-600 mt-2">
                  GenLayer tx: {result.genlayer_tx_hash.slice(0, 10)}...{result.genlayer_tx_hash.slice(-8)}
                </p>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export default function ReviewPage() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center min-h-[60vh]"><div className="w-6 h-6 border-2 border-[#eb1700] border-t-transparent rounded-full animate-spin" /></div>}>
      <ReviewContent />
    </Suspense>
  );
}
