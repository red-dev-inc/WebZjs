import { useState } from 'react';
import { Pczt } from '@zcashcommunitygrants/webzjs-wallet';
import { Buffer } from 'buffer';
import { useWebZjsContext } from '../context/WebzjsContext';
import { useMetaMaskContext } from '../context/MetamaskContext';
import { useInvokeSnap } from './snaps/useInvokeSnap';
import { useWebZjsActions } from './useWebzjsActions';
import useBalance from './useBalance';
import { zatsToZec } from '../utils';
import { SignPcztDetails } from '../types/snap';

/**
 * Fee buffer (zatoshis) held back from the sweep so the migration transaction's
 * ZIP-317 fee is covered. Any remainder below this stays as dust in the legacy
 * account (recoverable later) — never lost.
 */
const MIGRATION_FEE_BUFFER = 20_000; // 0.0002 ZEC

export enum MigrationStatus {
  IDLE = 'Idle',
  PREPARING = 'Preparing migration',
  CREATING = 'Building migration transaction',
  SIGNING = 'Signing with your current key',
  PROVING = 'Proving transaction',
  SENDING = 'Moving your funds',
  STAMPING = 'Switching to the portable account',
  RESYNCING = 'Refreshing your wallet',
  DONE = 'Migration complete',
  ERROR = 'Migration failed',
}

interface IUseMigration {
  migrateToPortable: () => Promise<void>;
  migrationStatus: MigrationStatus;
  migrationError: string | null;
}

/**
 * Orchestrates the one-time v1 (legacy) → v2 (portable) sweep: moves the legacy
 * account's balance to the portable address, then commits the derivation switch.
 */
export const useMigration = (): IUseMigration => {
  const { state } = useWebZjsContext();
  const invokeSnap = useInvokeSnap();
  const { flushDbToStore, fullResync } = useWebZjsActions();
  const { refreshSnapState } = useMetaMaskContext();
  const { spendableBalance } = useBalance();

  const [migrationStatus, setMigrationStatus] = useState<MigrationStatus>(
    MigrationStatus.IDLE,
  );
  const [migrationError, setMigrationError] = useState<string | null>(null);

  const migrateToPortable = async (): Promise<void> => {
    setMigrationError(null);

    if (!state.webWallet) {
      setMigrationError('Wallet is not ready. Please wait for sync to finish.');
      return;
    }
    const account =
      state.activeAccount === null || state.activeAccount === undefined
        ? null
        : state.activeAccount;
    if (account === null) {
      setMigrationError('No active account to migrate.');
      return;
    }

    const sweepZats = spendableBalance - MIGRATION_FEE_BUFFER;
    if (sweepZats <= 0) {
      setMigrationError(
        'Not enough spendable balance to migrate (after the network fee). ' +
          'Wait for sync to finish, or there may be nothing to move.',
      );
      return;
    }

    try {
      setMigrationStatus(MigrationStatus.PREPARING);
      // Destination: the portable (v2) account's shielded address.
      const toAddress = (await invokeSnap({
        method: 'getPortableAddress',
      })) as string;

      setMigrationStatus(MigrationStatus.CREATING);
      const sweepZec = zatsToZec(sweepZats).toString();
      const pczt = await state.webWallet.pczt_create(
        account,
        toAddress,
        BigInt(sweepZats),
      );

      setMigrationStatus(MigrationStatus.SIGNING);
      // Signed with the active (legacy v1) key — correct, since the spent notes
      // belong to v1 and `derivationVersion` has not been switched yet.
      const pcztHexTring = Buffer.from(pczt.serialize()).toString('hex');
      const params: SignPcztDetails = {
        pcztHexTring,
        signDetails: { recipient: toAddress, amount: sweepZec },
      };
      const signedHex = (await invokeSnap({
        method: 'signPczt',
        params,
      })) as string;
      const signedPczt = Pczt.from_bytes(
        new Uint8Array(Buffer.from(signedHex, 'hex')),
      );

      setMigrationStatus(MigrationStatus.PROVING);
      const provedPczt = await state.webWallet.pczt_prove(signedPczt);

      setMigrationStatus(MigrationStatus.SENDING);
      await state.webWallet.pczt_send(provedPczt);
      await flushDbToStore();

      // Only now that the funds are on their way do we commit the switch.
      setMigrationStatus(MigrationStatus.STAMPING);
      const stamped = (await invokeSnap({
        method: 'completeMigration',
      })) as boolean;
      if (!stamped) {
        // User declined the final confirmation. The sweep is already broadcast;
        // the funds are heading to the portable account, but the wallet stays on
        // the legacy view until they complete the switch. Surface this clearly.
        setMigrationError(
          'Funds were sent to your portable account, but the switch was not ' +
            'confirmed. Re-run the migration to finish switching.',
        );
        setMigrationStatus(MigrationStatus.ERROR);
        return;
      }

      // Re-import the wallet onto the portable (v2) account and re-scan so the
      // swept funds show up there.
      setMigrationStatus(MigrationStatus.RESYNCING);
      await fullResync();

      // Refresh the cached snap state so the UI sees derivationVersion = 2 and
      // hides the "move funds to portable account" prompt now that the switch is done.
      await refreshSnapState();

      setMigrationStatus(MigrationStatus.DONE);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('Migration failed:', error);
      setMigrationError(message);
      setMigrationStatus(MigrationStatus.ERROR);
    }
  };

  return { migrateToPortable, migrationStatus, migrationError };
};
