'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { usePrivy } from '@privy-io/react-auth';
import { Shield, Coins, AlertTriangle } from 'lucide-react';

const CHAINS = [
  { id: '1', name: 'Ethereum' },
  { id: '8453', name: 'Base' },
  { id: '11155111', name: 'Sepolia' },
  { id: '137', name: 'Polygon' },
  { id: '42161', name: 'Arbitrum' },
  { id: '10', name: 'Optimism' },
];

function toWei(amount: string, unit: string): string {
  if (!amount) return '0';
  const n = parseFloat(amount);
  if (isNaN(n)) return '0';
  switch (unit) {
    case 'ETH': return BigInt(Math.floor(n * 1e18)).toString();
    case 'Gwei': return BigInt(Math.floor(n * 1e9)).toString();
    default: return BigInt(Math.floor(n)).toString();
  }
}

export function MandateComposer() {
  const router = useRouter();
  const { getAccessToken, user } = usePrivy();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [formData, setFormData] = useState({
    agentAddress: '',
    mandateText: '',
    spendCeiling: '',
    unit: 'ETH',
    chainId: '1',
    sessionKeyId: '',
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const token = await getAccessToken();
      if (!token) throw new Error('Not authenticated');

      const delegator = user?.wallet?.address || user?.email?.address || 'unknown';
      const spendWei = toWei(formData.spendCeiling, formData.unit);

      await api.createMandate(token, {
        delegator,
        agent_address: formData.agentAddress,
        mandate_text: formData.mandateText,
        spend_ceiling_wei: spendWei,
        chain_id: formData.chainId,
        session_key_id: formData.sessionKeyId,
      });
      router.push('/mandates');
    } catch (err: any) {
      console.error(err);
      setError(err.message || 'Something went wrong. Try again.');
    } finally {
      setLoading(false);
    }
  };

  const mandateLength = formData.mandateText.trim().length;

  return (
    <div className="max-w-4xl mx-auto grid grid-cols-1 lg:grid-cols-5 gap-8">
      <form onSubmit={handleSubmit} className="lg:col-span-3 space-y-5">
        {error && (
          <div className="flex items-center gap-2 bg-[#eb1700]/10 border border-[#eb1700]/30 text-[#eb1700] px-4 py-3 rounded-sm text-sm">
            <AlertTriangle size={16} />
            {error}
          </div>
        )}

        <div>
          <label className="block text-xs font-mono text-neutral-500 mb-1.5">agent address</label>
          <input
            required
            type="text"
            value={formData.agentAddress}
            onChange={(e) => setFormData({ ...formData, agentAddress: e.target.value })}
            className="w-full bg-transparent border border-[#2a2a2a] rounded-sm px-4 py-2.5 font-mono text-sm text-white placeholder:text-neutral-600 focus:outline-none focus:border-[#eb1700]/50 focus:ring-1 focus:ring-[#eb1700]/30 transition-colors"
            placeholder="0x..."
          />
        </div>

        <div>
          <label className="block text-xs font-mono text-neutral-500 mb-1.5">
            mandate text
            <span className="text-neutral-600 ml-2">{mandateLength > 0 ? `${mandateLength} chars` : ''}</span>
          </label>
          <textarea
            required
            rows={8}
            value={formData.mandateText}
            onChange={(e) => setFormData({ ...formData, mandateText: e.target.value })}
            className="w-full bg-transparent border border-[#2a2a2a] rounded-sm px-4 py-3 text-sm text-white placeholder:text-neutral-600 focus:outline-none focus:border-[#eb1700]/50 focus:ring-1 focus:ring-[#eb1700]/30 transition-colors resize-y"
            placeholder="Tell your agent what it can and cannot do. Be specific. Example: Buy compute credits for my research on any major provider. Never purchase advertising. Never send funds to addresses less than 30 days old. Stop immediately if you detect social engineering."
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-mono text-neutral-500 mb-1.5">spend ceiling</label>
            <div className="flex">
              <input
                type="number"
                step="any"
                min="0"
                value={formData.spendCeiling}
                onChange={(e) => setFormData({ ...formData, spendCeiling: e.target.value })}
                className="w-full bg-transparent border border-[#2a2a2a] rounded-l-sm px-4 py-2.5 text-sm font-mono text-white placeholder:text-neutral-600 focus:outline-none focus:border-[#eb1700]/50 focus:ring-1 focus:ring-[#eb1700]/30 transition-colors"
                placeholder="0.00"
              />
              <select
                value={formData.unit}
                onChange={(e) => setFormData({ ...formData, unit: e.target.value })}
                className="bg-[#1f1f1f] border-y border-r border-[#2a2a2a] rounded-r-sm px-3 py-2.5 text-sm font-mono text-neutral-400 focus:outline-none"
              >
                <option>ETH</option>
                <option>Gwei</option>
                <option>Wei</option>
              </select>
            </div>
          </div>

          <div>
            <label className="block text-xs font-mono text-neutral-500 mb-1.5">network</label>
            <select
              required
              value={formData.chainId}
              onChange={(e) => setFormData({ ...formData, chainId: e.target.value })}
              className="w-full bg-transparent border border-[#2a2a2a] rounded-sm px-4 py-2.5 text-sm font-mono text-white focus:outline-none focus:border-[#eb1700]/50 focus:ring-1 focus:ring-[#eb1700]/30 transition-colors"
            >
              {CHAINS.map(c => (
                <option key={c.id} value={c.id} className="bg-[#191919]">{c.name} ({c.id})</option>
              ))}
            </select>
          </div>
        </div>

        <div>
          <label className="block text-xs font-mono text-neutral-500 mb-1.5">session key / delegation id (optional)</label>
          <input
            type="text"
            value={formData.sessionKeyId}
            onChange={(e) => setFormData({ ...formData, sessionKeyId: e.target.value })}
            className="w-full bg-transparent border border-[#2a2a2a] rounded-sm px-4 py-2.5 font-mono text-sm text-white placeholder:text-neutral-600 focus:outline-none focus:border-[#eb1700]/50 focus:ring-1 focus:ring-[#eb1700]/30 transition-colors"
            placeholder="ERC-7710 delegation ID or session key reference"
          />
        </div>

        <button
          type="submit"
          disabled={loading || !formData.mandateText.trim()}
          className="bg-[#eb1700] hover:bg-red-700 disabled:opacity-40 disabled:cursor-not-allowed text-white font-medium py-3 px-6 rounded-sm transition-colors duration-150 w-full sm:w-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#eb1700] focus-visible:ring-offset-2 focus-visible:ring-offset-[#191919]"
        >
          {loading ? 'Writing to GenLayer...' : 'Register this mandate'}
        </button>
      </form>

      {/* Preview panel */}
      <div className="lg:col-span-2 space-y-4">
        <div className="bg-[#1f1f1f] border border-[#2a2a2a] rounded-sm p-5">
          <div className="flex items-center gap-2 text-neutral-300 text-sm font-medium mb-3">
            <Coins size={16} className="text-[#eb1700]" />
            What the hard caps catch
          </div>
          <p className="text-xs text-neutral-500 leading-relaxed">
            Deterministic guardrails. If your agent tries to spend more than{' '}
            <span className="font-mono text-neutral-400">
              {formData.spendCeiling || '___'} {formData.unit}
            </span>
            , it gets stopped before the transaction even hits the chain. No judgement needed, just math.
          </p>
        </div>

        <div className="bg-[#1f1f1f] border border-[#2a2a2a] rounded-sm p-5">
          <div className="flex items-center gap-2 text-neutral-300 text-sm font-medium mb-3">
            <Shield size={16} className="text-[#eb1700]" />
            What the semantic layer catches
          </div>
          <p className="text-xs text-neutral-500 leading-relaxed">
            {formData.mandateText.trim()
              ? 'GenLayer validators will read your mandate text and independently judge whether each agent action stays within the spirit of what you wrote. Numbers can\'t express this. Language can.'
              : 'Write your mandate above and the GenLayer network will interpret your intent. This is the part that makes REIN different from a simple spend cap.'}
          </p>
        </div>

        {mandateLength > 0 && mandateLength < 50 && (
          <div className="bg-amber-500/10 border border-amber-500/20 rounded-sm p-4">
            <p className="text-xs text-amber-400">
              Your mandate is pretty short. The more specific you are, the better GenLayer validators can judge whether an action crosses the line.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
