import React, { useState } from 'react';
import { zatsToZec } from '../utils';
import { CoinsSvg, ShieldDividedSvg, ShieldSvg } from '../assets';
import useBalance from '../hooks/useBalance';
import { usePendingTransactions } from '../hooks/usePendingTransactions';
import { useWebZjsContext } from 'src/context/WebzjsContext';
import { BlockHeightCard } from 'src/components/BlockHeightCard/BlockHeightCard';
import { useMetaMaskContext } from 'src/context/MetamaskContext';
import { useWebZjsActions } from '../hooks/useWebzjsActions';
import { useInvokeSnap } from '../hooks/snaps/useInvokeSnap';
import { useMigration, MigrationStatus } from '../hooks/useMigration';

interface BalanceCard {
  name: string;
  icon: React.JSX.Element;
  balance: number;
}

function AccountSummary() {
  const { totalBalance, spendableBalance, unshieldedBalance, shieldedBalance, hasPending } = useBalance();
  const { pendingTxs } = usePendingTransactions();
  const { state } = useWebZjsContext();
  const { snapState, installedSnap } = useMetaMaskContext();
  const { fullResync } = useWebZjsActions();
  const invokeSnap = useInvokeSnap();
  const [exporting, setExporting] = useState(false);
  const { migrateToPortable, migrationStatus, migrationError } = useMigration();

  // Show the migration prompt only while the account is still on the legacy (v1)
  // derivation. Once switched to the portable account (v2) it is hidden.
  const onLegacyDerivation = snapState?.derivationVersion !== 2;
  const migrationInProgress =
    migrationStatus !== MigrationStatus.IDLE &&
    migrationStatus !== MigrationStatus.DONE &&
    migrationStatus !== MigrationStatus.ERROR;

  const handleMigrate = async () => {
    const ok = window.confirm(
      'This moves all of your funds from your current (legacy) Zcash account to ' +
        'a new portable account whose recovery phrase you can export. You will ' +
        'approve the transaction in MetaMask. Continue?',
    );
    if (!ok) return;
    await migrateToPortable();
  };

  // Triggers the Snap's secure reveal dialog. The secret is shown by MetaMask
  // itself and is never returned to this page.
  const handleExportKeys = async () => {
    setExporting(true);
    try {
      await invokeSnap({ method: 'exportZcashSecret' });
    } catch (err) {
      console.warn('Key export cancelled or failed:', err);
    } finally {
      setExporting(false);
    }
  };

  const BalanceCards: BalanceCard[] = [
    {
      name: 'Total Balance',
      icon: <CoinsSvg />,
      balance: totalBalance,
    },
    {
      name: 'Shielded Balance',
      icon: <ShieldSvg />,
      balance: shieldedBalance,
    },
    {
      name: 'Unshielded Balance',
      icon: <ShieldDividedSvg />,
      balance: unshieldedBalance,
    },
  ];

  const renderBalanceCard = ({ name, balance, icon }: BalanceCard) => {
    return (
      <div
        key={name}
        className="grow shrink min-w-[317px] basis-0 p-6 bg-white rounded-xl border border-[#afafaf] flex-col justify-start items-start gap-2 inline-flex"
      >
        {icon}
        <div className="self-stretch text-[#595959] text-sm font-semibold font-inter leading-[21px]">
          {name}
        </div>
        <div className="self-stretch justify-start items-center gap-2 inline-flex">
          <div className="text-black text-2xl font-medium font-['Inter'] leading-9">
            {zatsToZec(balance)} ZEC
          </div>
        </div>
        {name === 'Total Balance' && hasPending && (
          <div className="text-[#595959] text-sm font-inter">
            {zatsToZec(spendableBalance)} ZEC spendable
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="pb-[72px] mt-[46px] flex-col justify-center items-center gap-6 inline-flex">
      <div className="py-6 self-start  gap-3 inline-flex">
        <div className="grow shrink basis-0 flex-col justify-start items-start gap-2 inline-flex">
          <div className="self-stretch text-black text-[44px] font-semibold leading-[52.80px]">
            Account summary
          </div>
        </div>
      </div>
      <div
        className={
          'rounded-2xl justify-start items-center gap-6 flex flex-col min-[1000px]:flex-row'
        }
      >
        {BalanceCards.map((card) => renderBalanceCard(card))}
      </div>
      {pendingTxs.length > 0 && (
        <div className="w-full p-4 bg-amber-50 border border-amber-200 rounded-xl flex flex-col gap-2">
          {pendingTxs.map((tx) => (
            <div key={tx.txid} className="flex items-center gap-3">
              <span className="text-amber-600 text-lg">⏳</span>
              <span className="text-amber-800 font-medium">
                {tx.tx_type} {zatsToZec(tx.value)} ZEC — waiting for confirmation
              </span>
            </div>
          ))}
        </div>
      )}
      <BlockHeightCard
        state={state}
        syncedFrom={snapState?.webWalletSyncStartBlock}
        onFullResync={fullResync}
      />
      <div className="w-full p-6 bg-white rounded-xl border border-[#afafaf] flex flex-col gap-3">
        <div className="text-black text-lg font-semibold font-inter">
          Export Zcash keys
        </div>
        <div className="text-[#595959] text-sm font-inter">
          Reveal your Zcash wallet&apos;s recovery phrase to import this wallet
          into another Zcash wallet (e.g. Zkool or Zodl). The phrase is shown
          securely inside MetaMask and is different from your MetaMask Secret
          Recovery Phrase.
        </div>
        <button
          onClick={handleExportKeys}
          disabled={exporting || !installedSnap}
          className="self-start px-4 py-2 bg-black text-white rounded-lg text-sm font-medium disabled:opacity-50"
        >
          {exporting ? 'Opening MetaMask…' : 'Export Zcash keys'}
        </button>
      </div>
      {onLegacyDerivation && installedSnap && (
        <div className="w-full p-6 bg-white rounded-xl border border-[#afafaf] flex flex-col gap-3">
          <div className="text-black text-lg font-semibold font-inter">
            Upgrade to a portable Zcash account
          </div>
          <div className="text-[#595959] text-sm font-inter">
            Your current Zcash account cannot be exported to other wallets. Move
            your funds to a new portable account to get a recovery phrase you can
            import anywhere. This sends a transaction you approve in MetaMask.
          </div>
          <button
            onClick={handleMigrate}
            disabled={migrationInProgress}
            className="self-start px-4 py-2 bg-black text-white rounded-lg text-sm font-medium disabled:opacity-50"
          >
            {migrationInProgress
              ? migrationStatus
              : 'Move funds to portable account'}
          </button>
          {migrationStatus === MigrationStatus.DONE && (
            <div className="text-green-700 text-sm font-inter">
              Migration complete — your funds are now in your portable account.
            </div>
          )}
          {migrationError && (
            <div className="text-red-600 text-sm font-inter">
              {migrationError}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default AccountSummary;
