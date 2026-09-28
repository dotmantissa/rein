import { NavRail } from './NavRail';
import { CommandBar } from './CommandBar';

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-[#191919] text-white">
      <NavRail />
      <div className="md:pl-[56px] pb-[56px] md:pb-0 min-h-screen flex flex-col">
        <CommandBar />
        <main className="flex-1 p-6 md:p-8 max-w-7xl mx-auto w-full">
          {children}
        </main>
      </div>
    </div>
  );
}
