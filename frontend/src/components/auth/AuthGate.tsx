'use client';

import { usePrivy } from '@privy-io/react-auth';
import Image from 'next/image';

export function AuthGate({ children }: { children: React.ReactNode }) {
  const { ready, authenticated, login } = usePrivy();

  if (!ready) {
    return (
      <div className="min-h-screen bg-[#191919] flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-[#eb1700] border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!authenticated) {
    return (
      <div className="min-h-screen bg-[#191919] flex flex-col items-center justify-center p-4">
        <div className="max-w-md w-full text-center space-y-8">
          <Image src="/logo.jpg" alt="REIN" width={80} height={80} className="mx-auto rounded-xl shadow-lg" />
          
          <div className="space-y-4">
            <h1 className="text-3xl font-bold text-white tracking-tight">
              Autonomy is not the same as unsupervised.
            </h1>
            <p className="text-neutral-400 text-lg">
              REIN watches your AI agents so you don&apos;t have to. When they step outside their mandate, we pull the rein.
            </p>
          </div>

          <button
            onClick={login}
            className="w-full bg-[#eb1700] hover:bg-red-700 text-white font-medium py-3 px-4 rounded-lg transition-colors focus:outline-none focus:ring-2 focus:ring-[#eb1700] focus:ring-offset-2 focus:ring-offset-[#191919]"
          >
            Sign in with Email
          </button>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
