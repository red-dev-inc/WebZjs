import React, { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { PcztTransferStatus, usePczt } from '../../hooks/usePCZT';
import { useWebZjsContext } from '../../context/WebzjsContext';

/** Route state accepted by the Transfer Balance page, e.g. from "Send again" in the history. */
export interface TransferBalanceRouteState {
  recipient?: string;
}

export interface TransferBalanceFormData {
  amount: string;
  recipient: string;
}

export type TransferBalanceFormHandleChange = (
  input: keyof TransferBalanceFormData,
) => (
  e:
    | React.ChangeEvent<
        HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
      >
    | string,
) => void;

export interface TransferBalanceFormType {
  currentStep: number;
  formData: TransferBalanceFormData;
  /** The recipient the page was opened with, if it came from a previous transaction */
  prefilledRecipient: string;
  pcztTransferStatus: PcztTransferStatus;
  lastError: string | null;
  nextStep: () => void;
  handleChange: TransferBalanceFormHandleChange;
  submitForm: () => void;
  resetForm: () => void;
}

export enum TransferStep {
  INPUT,
  CONFIRM,
  RESULT
}

const useTransferBalanceForm = (): TransferBalanceFormType => {
  const { state } = useWebZjsContext();
  const { handlePcztTransaction, pcztTransferStatus, lastError } = usePczt();
  const location = useLocation();
  const prefilledRecipient =
    (location.state as TransferBalanceRouteState | null)?.recipient ?? '';
  const [currentStep, setCurrentStep] = useState<TransferStep>(0);
  const [formData, setFormData] = useState<TransferBalanceFormData>({
    amount: '',
    recipient: prefilledRecipient,
  });

  // A later "Send again" while this page is already mounted replaces the recipient
  // and starts the form over.
  useEffect(() => {
    if (prefilledRecipient) {
      setFormData({ amount: '', recipient: prefilledRecipient });
      setCurrentStep(TransferStep.INPUT);
    }
  }, [prefilledRecipient, location.key]);

  const nextStep = () => setCurrentStep((prev) => prev + 1);

  const handleChange: TransferBalanceFormHandleChange = (input) => (e) => {
    if (typeof e === 'string') {
      setFormData({ ...formData, [input]: e });
    } else {
      setFormData({ ...formData, [input]: e.target.value });
    }
  };

  const submitForm = () => {
    const { amount, recipient } = formData;
    const accountId = state.activeAccount ?? 0;
    handlePcztTransaction(accountId, recipient, amount);
  };


  const resetForm = () => {
    setFormData({
      amount: '',
      recipient: '',
    });
    setCurrentStep(TransferStep.INPUT);
  };

  return {
    currentStep,
    formData,
    prefilledRecipient,
    pcztTransferStatus,
    lastError,
    nextStep,
    handleChange,
    submitForm,
    resetForm,
  };
};

export default useTransferBalanceForm;
