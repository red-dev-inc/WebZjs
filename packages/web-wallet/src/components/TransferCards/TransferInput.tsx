import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  TransferBalanceFormData,
  TransferBalanceFormHandleChange,
} from '../../pages/TransferBalance/useTransferBalanceForm';
import Input, { InputTone } from '../Input/Input';
import Button from '../Button/Button';
import useBalance from '../../hooks/useBalance';
import { useWebZjsContext } from '../../context/WebzjsContext';
import { zecToZats, zatsToZec } from '../../utils/balance';

interface TransferInputProps {
  formData: TransferBalanceFormData;
  /** Recipient the page was opened with (from "Send again"); shown as a known address */
  prefilledRecipient?: string;
  handleChange: TransferBalanceFormHandleChange;
  nextStep: () => void;
}

/** What the wallet knows about the typed recipient. */
type RecipientStatus = 'empty' | 'checking' | 'known' | 'new' | 'invalid';

const RECIPIENT_CHECK_DELAY_MS = 400;

export const KNOWN_RECIPIENT_HINT = 'You have sent to this address before.';
export const NEW_RECIPIENT_HINT =
  'You have never sent to this address from this wallet. Check it carefully before continuing.';

const recipientTone: Record<RecipientStatus, InputTone> = {
  empty: 'default',
  checking: 'default',
  known: 'success',
  new: 'warning',
  invalid: 'default',
};

const recipientHint: Record<RecipientStatus, string | undefined> = {
  empty: undefined,
  checking: undefined,
  known: KNOWN_RECIPIENT_HINT,
  new: NEW_RECIPIENT_HINT,
  invalid: undefined,
};

export function TransferInput({
  formData: { recipient, amount },
  prefilledRecipient = '',
  nextStep,
  handleChange,
}: TransferInputProps): React.JSX.Element {
  const { spendableBalance } = useBalance();
  const { state } = useWebZjsContext();

  const [errors, setErrors] = useState({
    recipient: '',
    amount: '',
  });

  // A prefilled recipient came from the wallet's own history, so it is known by construction.
  const [recipientStatus, setRecipientStatus] = useState<RecipientStatus>(
    recipient && recipient === prefilledRecipient ? 'known' : 'empty',
  );
  const latestCheck = useRef(0);
  // Read through a ref so the check always sees the current wallet without the effect
  // below restarting whenever the context re-renders.
  const stateRef = useRef(state);
  stateRef.current = state;

  const checkRecipient = useCallback(async (address: string): Promise<RecipientStatus> => {
    const { webWallet, activeAccount } = stateRef.current;
    if (!address) return 'empty';
    if (!webWallet || activeAccount === null || activeAccount === undefined) return 'empty';
    try {
      return (await webWallet.has_sent_to(activeAccount, address)) ? 'known' : 'new';
    } catch (error) {
      // The wallet rejects a malformed address. Any other failure (worker busy, storage
      // error) must not block a valid address, so it only loses the "known" hint.
      const message = error instanceof Error ? error.message : String(error);
      return /address/i.test(message) ? 'invalid' : 'new';
    }
  }, []);

  // Re-check a little after the user stops typing. The prefilled address skips the check.
  useEffect(() => {
    if (recipient && recipient === prefilledRecipient) {
      setRecipientStatus('known');
      return;
    }
    if (!recipient) {
      setRecipientStatus('empty');
      return;
    }
    const check = ++latestCheck.current;
    setRecipientStatus('checking');
    const timer = setTimeout(async () => {
      const status = await checkRecipient(recipient);
      if (check === latestCheck.current) setRecipientStatus(status);
    }, RECIPIENT_CHECK_DELAY_MS);
    return () => clearTimeout(timer);
  }, [recipient, prefilledRecipient, checkRecipient]);

  const validateFields = async () => {
    const newErrors = {
      recipient: '',
      amount: '',
    };

    if (!recipient) {
      newErrors.recipient = 'Please enter a valid address';
    } else {
      // Settle a pending check now, rather than letting the user continue with a bad address.
      const status =
        recipientStatus === 'checking' ? await checkRecipient(recipient) : recipientStatus;
      setRecipientStatus(status);
      if (status === 'invalid') {
        newErrors.recipient = 'Please enter a valid Zcash address';
      }
    }

    // Amount validation
    if (!amount) {
      newErrors.amount = 'Amount is required';
    } else if (isNaN(Number(amount))) {
      newErrors.amount = 'Please enter a valid number';
    } else if (Number(amount) <= 0) {
      newErrors.amount = 'Amount must be greater than 0';
    } else {
      // Balance validation with fee buffer
      try {
        const amountInZats = zecToZats(amount);
        const FEE_BUFFER = 10_000; // Conservative estimate: 0.0001 ZEC buffer for fees
        const totalRequired = Number(amountInZats) + FEE_BUFFER;

        if (totalRequired > spendableBalance) {
          const availableZec = zatsToZec(Math.max(0, spendableBalance - FEE_BUFFER));
          newErrors.amount = `Insufficient balance. Available (after fees): ${availableZec.toFixed(8)} ZEC`;
        }
      } catch (error) {
        // If conversion fails, let it pass - the error will be caught later
        // This handles edge cases like invalid decimal formats
      }
    }

    setErrors(newErrors);

    return !Object.values(newErrors).some((error) => error !== '');
  };

  const handleContinue = async () => {
    if (await validateFields()) nextStep();
  };

  return (
    <div className="px-12 py-9 bg-white rounded-3xl border border-[#afafaf] flex-col justify-start items-center gap-6 inline-flex">
      <div className="self-stretch flex-col justify-center items-center gap-6 flex">
        <div className="self-stretch min-h-[184px] flex-col justify-center items-start gap-6 flex">
          <div className="self-stretch justify-start items-start gap-6 inline-flex">
            <div className="grow shrink basis-0 flex-col justify-start items-start gap-2 inline-flex">
              <Input
                label="To:"
                id="recipient"
                placeholder="Zcash Address"
                error={errors.recipient}
                tone={recipientTone[recipientStatus]}
                hint={recipientHint[recipientStatus]}
                value={recipient}
                onChange={(event) => handleChange('recipient')(event)}
              />
            </div>
          </div>
          <div className="self-stretch justify-start items-start gap-6 inline-flex">
            <div className="grow shrink basis-0 flex-col justify-start items-start gap-2 inline-flex">
              <Input
                label="Amount:"
                id="amount"
                suffix="ZEC"
                error={errors.amount}
                placeholder="Enter amount"
                value={amount}
                onChange={(event) => handleChange('amount')(event)}
              />
            </div>
          </div>
        </div>
        <div className="justify-start items-start inline-flex">
          <Button classNames='cursor-pointer' onClick={() => handleContinue()} label="Continue" />
        </div>
      </div>
    </div>
  );
}
