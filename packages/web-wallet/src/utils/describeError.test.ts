import { describe, expect, it } from 'vitest';
import { BROADCAST_STAGE, describeTransferError, errorDetail } from './describeError';

describe('errorDetail', () => {
  it('reads the message off MetaMask JSON-RPC error objects instead of "[object Object]"', () => {
    expect(errorDetail({ code: -32603, message: 'unreachable', stack: 'RuntimeError: unreachable' })).toBe(
      'unreachable',
    );
    expect(errorDetail({ code: -32603, message: 'Internal JSON-RPC error.', data: { originalError: { message: 'Could not parse PCZT: Invalid(DeserializeUnexpectedEnd)' } } })).toBe(
      'Could not parse PCZT: Invalid(DeserializeUnexpectedEnd)',
    );
  });

  it('handles Error instances, strings, and arbitrary values', () => {
    expect(errorDetail(new Error('boom'))).toBe('boom');
    expect(errorDetail('plain')).toBe('plain');
    expect(errorDetail({ weird: true })).toBe('{"weird":true}');
    expect(errorDetail(undefined)).toBe('undefined');
  });
});

describe('describeTransferError', () => {
  it('names the stage and explains a WASM trap', () => {
    const { summary, detail } = describeTransferError(
      { code: -32603, message: 'unreachable' },
      'Signing in MetaMask',
    );
    expect(summary).toMatch(/^Signing in MetaMask hit an internal error/);
    expect(summary).toContain('Nothing was sent');
    expect(detail).toContain('unreachable');
  });

  it('recognises a user rejection by code or wording', () => {
    expect(describeTransferError({ code: 4001, message: 'User rejected the request.' }, 'Signing in MetaMask').summary).toMatch(
      /declined/,
    );
    expect(describeTransferError(new Error('User rejected the request.'), 'Signing in MetaMask').summary).toMatch(
      /declined/,
    );
  });

  it('does not claim nothing was sent once the transaction was broadcast', () => {
    const after = describeTransferError(new Error('quota exceeded'), 'Saving the wallet after broadcast', 'transfer', true);
    expect(after.summary).toContain('already broadcast');
    expect(after.summary).toContain('do not send it again');
    expect(after.summary).not.toContain('Nothing was sent');

    const during = describeTransferError(new Error('timeout'), BROADCAST_STAGE);
    expect(during.summary).toContain('not certain whether the payment went out');
    expect(during.summary).not.toContain('Nothing was sent');

    const trapAfter = describeTransferError({ code: -32603, message: 'unreachable' }, 'Saving the wallet after broadcast', 'transfer', true);
    expect(trapAfter.summary).toContain('already broadcast');
  });

  it('explains a proposal the wallet cannot build, for transfers and for shielding', () => {
    const transfer = describeTransferError(
      new Error('Failed to create Pczt: ProposalNotSupported'),
      'Building the transaction',
    );
    expect(transfer.summary).toMatch(/^This wallet cannot build a payment to that address/);
    expect(transfer.summary).toContain('transparent address');
    expect(transfer.summary).toContain('Nothing was sent');
    expect(transfer.detail).toBe('Failed to create Pczt: ProposalNotSupported');

    const shield = describeTransferError(
      new Error('Failed to create Pczt: ProposalNotSupported'),
      'Building the transaction',
      'shield',
    );
    expect(shield.summary).toMatch(/^This wallet cannot build the shielding transaction/);
    expect(shield.summary).toContain('Nothing was sent');

    // Only the variant name itself matches, not a longer word containing it.
    expect(describeTransferError(new Error('ProposalNotSupportedXYZ'), 'Building the transaction').summary).toBe(
      'Building the transaction failed. Nothing was sent.',
    );
  });

  it('passes other errors through with the stage', () => {
    const { summary, detail } = describeTransferError(new Error('Could not parse PCZT: Invalid(x)'), 'Signing in MetaMask');
    expect(summary).toBe('Signing in MetaMask failed. Nothing was sent.');
    expect(detail).toBe('Could not parse PCZT: Invalid(x)');
  });
});
