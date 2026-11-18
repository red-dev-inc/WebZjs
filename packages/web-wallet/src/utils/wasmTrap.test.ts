import { describe, expect, it } from 'vitest';
import { isWasmTrapEvent } from './wasmTrap';

describe('isWasmTrapEvent', () => {
  it('matches the message of an uncaught unreachable trap', () => {
    expect(isWasmTrapEvent('Uncaught RuntimeError: unreachable', undefined)).toBe(true);
    expect(isWasmTrapEvent('unreachable executed', null)).toBe(true);
  });

  it('matches a RuntimeError carried in the error object', () => {
    class RuntimeError extends Error {
      name = 'RuntimeError';
    }
    expect(isWasmTrapEvent('Script error.', new RuntimeError('unreachable'))).toBe(true);
    expect(isWasmTrapEvent(undefined, new RuntimeError('memory access out of bounds'))).toBe(true);
  });

  it('ignores ordinary errors and empty events', () => {
    expect(isWasmTrapEvent('Network request failed', new TypeError('Failed to fetch'))).toBe(false);
    expect(isWasmTrapEvent(undefined, undefined)).toBe(false);
    expect(isWasmTrapEvent('', null)).toBe(false);
    expect(isWasmTrapEvent(undefined, 'the sync worker stopped after an internal error')).toBe(false);
  });
});
