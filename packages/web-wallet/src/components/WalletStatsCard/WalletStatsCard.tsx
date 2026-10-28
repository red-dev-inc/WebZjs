import { zatsToZec } from '../../utils';
import type { ActivityStats } from '../../utils/walletStats';

export interface PoolBalances {
  transparent: number;
  sapling: number;
  orchard: number;
  ironwood: number;
}

export interface WalletStatsCardProps {
  pools: PoolBalances;
  activity: ActivityStats;
  chainHeight?: number;
  syncedHeight?: number;
  loading?: boolean;
}

const POOL_LABELS: { key: keyof PoolBalances; name: string; color: string }[] = [
  { key: 'ironwood', name: 'Ironwood', color: 'bg-[#c2410c]' },
  { key: 'orchard', name: 'Orchard', color: 'bg-[#f5a623]' },
  { key: 'sapling', name: 'Sapling', color: 'bg-[#5b7fa6]' },
  { key: 'transparent', name: 'Transparent', color: 'bg-[#afafaf]' },
];

function formatDate(seconds: number | null): string {
  if (!seconds) return 'None yet';
  return new Date(seconds * 1000).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function percent(part: number, whole: number): number {
  return whole > 0 ? Math.round((part / whole) * 100) : 0;
}

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="flex flex-col gap-0.5 min-w-0">
      <div className="text-[#595959] text-xs font-semibold font-inter uppercase tracking-wide">
        {label}
      </div>
      <div className="text-black text-lg font-medium font-['Inter'] leading-7 truncate" title={value}>
        {value}
      </div>
      {note && <div className="text-[#595959] text-xs font-inter">{note}</div>}
    </div>
  );
}

/**
 * Figures the wallet already knows about itself. Nothing here needs the network.
 *
 * Lifetime received, sent and shielded totals and the in/out breakdown are not
 * shown yet: after a Full Resync the wallet rebuilds from compact blocks and
 * never fetches the full transaction for its own spends, so every past send is
 * recorded as a small "Received" change output. Re-enable them once
 * zcash_client_memory queues transaction enhancement for spent notes.
 */
export function WalletStatsCard({
  pools,
  activity,
  chainHeight,
  syncedHeight,
  loading = false,
}: WalletStatsCardProps) {
  const shielded = pools.sapling + pools.orchard + pools.ironwood;
  const poolTotal = pools.transparent + shielded;
  const shieldedShare = percent(shielded, poolTotal);
  const blocksBehind =
    chainHeight !== undefined && syncedHeight !== undefined
      ? Math.max(0, chainHeight - syncedHeight)
      : undefined;
  const txCount = activity.sentCount + activity.receivedCount + activity.shieldedCount;

  return (
    <div className="w-full p-6 bg-white rounded-xl border border-[#afafaf] flex flex-col gap-5">
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <div className="text-[#595959] text-sm font-semibold font-inter leading-[21px]">
          Wallet stats
        </div>
        {loading && <div className="text-[#595959] text-xs font-inter">Updating…</div>}
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex justify-between text-sm font-inter">
          <span className="text-[#595959]">Balance by pool</span>
          <span className="text-black font-medium">{shieldedShare}% shielded</span>
        </div>
        <div
          className="h-3 w-full rounded-full bg-[#eeeeee] overflow-hidden flex"
          role="img"
          aria-label={`${shieldedShare} percent of the balance is shielded`}
        >
          {POOL_LABELS.map(({ key, color }) => (
            <div
              key={key}
              className={`${color} h-full`}
              style={{ width: `${percent(pools[key], poolTotal)}%` }}
            />
          ))}
        </div>
        <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm font-inter">
          {POOL_LABELS.map(({ key, name, color }) => (
            <span key={key} className="inline-flex items-center gap-2 text-[#434343]">
              <i className={`${color} inline-block w-2.5 h-2.5 rounded-sm`} />
              {name}: <span className="font-medium text-black">{zatsToZec(pools[key])} ZEC</span>
            </span>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 min-[700px]:grid-cols-4 gap-x-6 gap-y-4">
        <Stat
          label="Transactions"
          value={String(txCount)}
          note={activity.memoCount > 0 ? `${activity.memoCount} with memos` : undefined}
        />
        <Stat label="First activity" value={formatDate(activity.firstActivity)} />
        <Stat label="Last activity" value={formatDate(activity.lastActivity)} />
        <Stat
          label="Sync"
          value={blocksBehind === undefined ? '?' : blocksBehind === 0 ? 'At chain tip' : `${blocksBehind} behind`}
        />
      </div>
    </div>
  );
}

export default WalletStatsCard;
